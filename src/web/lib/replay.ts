import {
	type CameraId,
	DAY_MS,
	MAX_REPLAY_TRACKS,
	MAX_TRACK_ID,
	type Quality,
	type ReplayCommand,
	ReplayEvent,
	type ReplayRate,
} from "@/shared/schema";
import { mediaSource } from "@/web/lib/player";
import { clampDay, covers, nextRange } from "@/web/lib/timeline";

export type ReplayState = "opening" | "playing" | "paused" | "buffering" | "ended" | "failed";

/** One picture to fill: a tile (or the one big picture), its camera, and its video. */
export type ReplayEntry = { key: number; camera: CameraId; video: HTMLVideoElement };

type Listener = {
	onState: (state: ReplayState, detail?: string) => void;
	onTime: (ms: number) => void;
	/** Which pictures, by key, hold footage at the playhead, each time that changes. */
	onCover?: (covered: ReadonlyMap<number, boolean>) => void;
};

type Range = [number, number];

const WATCH_MS = 200;
/** A blip this short between two appends is not worth a message on the picture. */
const STALL_WATCHES = 3;
/** Seconds. The decoder keeps up to 16 frames back, which is about one second at 15 fps. */
const STALLED_MARGIN = 1.2;
/** Seconds of played video kept behind the playhead, so a short step back is instant. */
const KEEP = 30;
/** Seconds a track may wander from the playhead before it is put back in step. */
const DRIFT = 0.3;

type Track = ReplayEntry & {
	id: number;
	source: MediaSource;
	objectUrl: string | null;
	opened: Promise<void>;
	buffer: SourceBuffer | null;
	queue: Uint8Array[];
	/** The buffer still holds video from before a seek. */
	clearing: boolean;
	/** Its first picture since the last start or seek has arrived. */
	landed: boolean;
};

function bufferedRanges(buffer: SourceBuffer | null): Range[] {
	if (!buffer) return [];
	const { buffered } = buffer;
	const ranges: Range[] = [];
	for (let i = 0; i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
	return ranges;
}

function replayUrl(cameras: readonly string[], quality: Quality, day: string, ms: number): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const query = new URLSearchParams({
		cameras: cameras.join(","),
		quality,
		day,
		ms: String(clampDay(ms)),
	});
	return `${scheme}://${location.host}/ws/replay?${query}`;
}

/**
 * Plays one replay socket into one video per camera. Timestamps are the recorder's time of day,
 * the same on every track, so keeping tracks in step is a matter of matching `currentTime`. One
 * track, the master, sets the playhead and the rest follow it. When the master's camera stops
 * recording or leaves the screen, another that still has footage takes over in place.
 *
 * Cameras come and go without a new socket: those kept keep playing, and new ones join at the
 * playhead. A track number is never given out twice, so video still on its way for a camera
 * that left can't land in the tile that replaced it.
 */
export class ReplayPlayer {
	#tracks = new Map<number, Track>();
	#nextId = 0;
	#listener: Listener;
	#socket: WebSocket | null = null;
	#timer: ReturnType<typeof setInterval> | undefined;
	#stopped = false;
	#paused = false;
	#rate: ReplayRate;
	/** Drops everything from the old spot until the server says the seek is done. */
	#discarding = false;
	/** Until a track lands after a start or a seek, nothing knows where the playhead is. */
	#landing = true;
	#master: number | null = null;
	/** Seconds. The playhead as last seen, for when the master goes. */
	#time = 0;
	#ended = false;
	#state: ReplayState | null = null;
	#stalls = 0;
	#covered = "";
	/** The cameras the server last heard about, as `track:camera` pairs. */
	#announced = "";

	constructor(listener: Listener, rate: ReplayRate = 1) {
		this.#listener = listener;
		this.#rate = rate;
	}

	start(entries: readonly ReplayEntry[], quality: Quality, day: string, ms: number): void {
		this.#set("opening");
		this.#time = ms / 1000;
		// Tracks start at 0, in the order of the socket's camera list.
		const tracks = entries.flatMap((entry) => this.#add(entry) ?? []);
		this.#announced = this.#trackList().text;
		void Promise.all(tracks.map((track) => track.opened)).then(() => {
			if (!this.#stopped) {
				this.#connect(
					replayUrl(
						tracks.map((t) => t.camera),
						quality,
						day,
						ms,
					),
				);
			}
		});
	}

	/**
	 * Shows these pictures from now on. False when the socket has given out all its track
	 * numbers, and only a new one can take more.
	 */
	setEntries(entries: readonly ReplayEntry[]): boolean {
		const wanted = new Map(entries.map((entry) => [entry.key, entry]));
		let changed = false;
		for (const [id, track] of this.#tracks) {
			const entry = wanted.get(track.key);
			if (entry?.camera === track.camera && entry.video === track.video) {
				wanted.delete(track.key);
				continue;
			}
			this.#drop(id);
			changed = true;
		}
		for (const entry of wanted.values()) {
			if (this.#tracks.size >= MAX_REPLAY_TRACKS) break;
			if (!this.#add(entry)) return false;
			changed = true;
		}
		if (changed) {
			this.#announce();
			this.#report();
		}
		return true;
	}

	#trackList() {
		const tracks = [...this.#tracks.values()].map(({ id, camera }) => ({ track: id, camera }));
		return { tracks, text: tracks.map(({ track, camera }) => `${track}:${camera}`).join(",") };
	}

	/** Tells the server the cameras now on screen, if it does not know them yet. */
	#announce(): void {
		const { tracks, text } = this.#trackList();
		if (text === this.#announced || this.#socket?.readyState !== WebSocket.OPEN) return;
		this.#announced = text;
		this.#say({ type: "tracks", tracks });
	}

	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
		const socket = this.#socket;
		this.#socket = null;
		socket?.close();
		for (const track of this.#tracks.values()) this.#release(track);
		this.#tracks.clear();
	}

	get paused(): boolean {
		return this.#paused;
	}

	video(key: number): HTMLVideoElement | null {
		for (const track of this.#tracks.values()) if (track.key === key) return track.video;
		return null;
	}

	seek(ms: number): void {
		this.#ended = false;
		this.#landing = true;
		this.#discarding = true;
		this.#time = ms / 1000;
		for (const track of this.#tracks.values()) {
			track.clearing = true;
			track.landed = false;
			track.queue = [];
		}
		this.#set("buffering");
		this.#listener.onTime(ms);
		this.#say({ type: "seek", ms: clampDay(ms) });
		for (const track of this.#tracks.values()) this.#pump(track);
	}

	setRate(value: ReplayRate): void {
		this.#rate = value;
		for (const track of this.#tracks.values()) track.video.playbackRate = value;
		this.#say({ type: "rate", value });
	}

	setPaused(paused: boolean): void {
		this.#paused = paused;
		if (paused) {
			for (const track of this.#tracks.values()) track.video.pause();
			this.#set("paused");
			return;
		}
		const lead = this.#landing ? null : this.#lead();
		lead?.video.play().catch(() => undefined);
		if (lead) this.#align(lead.video.currentTime);
		this.#set(lead && lead.video.readyState >= 3 ? "playing" : "buffering");
	}

	#add(entry: ReplayEntry): Track | null {
		if (this.#nextId > MAX_TRACK_ID) return null;
		const { video } = entry;
		video.disableRemotePlayback = true;
		video.playbackRate = this.#rate;
		const { source, managed } = mediaSource();
		let objectUrl: string | null = null;
		if (managed) {
			video.srcObject = source;
		} else {
			objectUrl = URL.createObjectURL(source);
			video.src = objectUrl;
		}
		const opened = new Promise<void>((resolve) => {
			source.addEventListener("sourceopen", () => resolve(), { once: true });
		});
		const track: Track = {
			...entry,
			id: this.#nextId++,
			source,
			objectUrl,
			opened,
			buffer: null,
			queue: [],
			clearing: false,
			landed: false,
		};
		this.#tracks.set(track.id, track);
		return track;
	}

	/** A camera left. Its tile keeps its last picture until it plays again or goes. */
	#drop(id: number): void {
		const track = this.#tracks.get(id);
		if (!track) return;
		this.#tracks.delete(id);
		track.video.pause();
		if (track.objectUrl !== null) URL.revokeObjectURL(track.objectUrl);
		if (this.#master === id) this.#master = null;
	}

	#release(track: Track): void {
		const { video } = track;
		video.pause();
		video.srcObject = null;
		video.removeAttribute("src");
		video.load();
		if (track.objectUrl !== null) URL.revokeObjectURL(track.objectUrl);
	}

	#set(state: ReplayState, detail?: string): void {
		if (state === this.#state) return;
		this.#state = state;
		this.#listener.onState(state, detail);
	}

	#say(command: ReplayCommand): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(command));
	}

	#connect(url: string): void {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;

		// Cameras that changed while the socket was opening go with its first words.
		socket.onopen = () => this.#announce();

		socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
			if (this.#socket !== socket) return;
			if (typeof event.data === "string") {
				this.#event(event.data);
				return;
			}
			if (this.#discarding) return;
			const data = new Uint8Array(event.data);
			const track = this.#tracks.get(data[0] ?? -1);
			if (!track) return;
			track.queue.push(data.subarray(1));
			this.#pump(track);
		};

		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#set("failed", "The connection to Camwall dropped.");
		};

		this.#timer = setInterval(() => this.#watch(), WATCH_MS);
	}

	#event(text: string): void {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		const event = ReplayEvent.safeParse(parsed);
		if (!event.success) return;
		switch (event.data.type) {
			case "mse": {
				const track = this.#tracks.get(event.data.track);
				if (!track || track.buffer) return;
				const codec = event.data.value;
				// A camera that just joined may still be opening its picture.
				void track.opened.then(() => {
					if (this.#tracks.get(track.id) !== track || track.buffer) return;
					const buffer = track.source.addSourceBuffer(codec);
					buffer.mode = "segments";
					buffer.addEventListener("updateend", () => this.#updated(track));
					track.buffer = buffer;
					this.#say({ type: "rate", value: this.#rate });
					this.#pump(track);
				});
				break;
			}
			case "seeked":
				this.#discarding = false;
				break;
			case "end":
				this.#ended = true;
				break;
			case "error":
				this.#set("failed", event.data.value);
				break;
			default: {
				const _exhaustive: never = event.data;
				throw new Error(`Unknown event ${String(_exhaustive)}`);
			}
		}
	}

	#updated(track: Track): void {
		const buffer = track.buffer;
		if (this.#tracks.get(track.id) !== track) return;
		if (buffer && !track.landed && !track.clearing && buffer.buffered.length > 0) {
			track.landed = true;
			const first = buffer.buffered.start(0);
			const { video } = track;
			video.playbackRate = this.#rate;
			if (this.#landing) {
				// The first picture after a start or a seek sets the playhead.
				this.#landing = false;
				this.#master = track.id;
				this.#time = first;
				video.currentTime = first;
				if (this.#paused) {
					this.#listener.onTime(first * 1000);
					this.#set("paused");
				} else {
					video.play().catch(() => undefined);
				}
			} else {
				// A later track joins the playhead, or waits on its first picture until it gets there.
				const time = this.#lead()?.video.currentTime ?? this.#time;
				video.currentTime = covers(bufferedRanges(buffer), time) ? time : first;
				this.#align(time);
			}
		}
		this.#pump(track);
	}

	#pump(track: Track): void {
		const buffer = track.buffer;
		if (!buffer || buffer.updating) return;
		if (track.clearing) {
			track.clearing = false;
			if (buffer.buffered.length > 0) {
				buffer.remove(0, buffer.buffered.end(buffer.buffered.length - 1));
				return;
			}
		}
		const ranges = bufferedRanges(buffer);
		const oldest = ranges[0]?.[0];
		const time = track.video.currentTime;
		if (oldest !== undefined && time - oldest > KEEP * 2) {
			buffer.remove(oldest, time - KEEP);
			return;
		}
		if (track.queue.length === 0) return;
		const data = new Uint8Array(track.queue.reduce((sum, part) => sum + part.byteLength, 0));
		let offset = 0;
		for (const part of track.queue) {
			data.set(part, offset);
			offset += part.byteLength;
		}
		track.queue = [];
		try {
			buffer.appendBuffer(data);
		} catch {
			this.#set("failed", "This browser could not take the video.");
		}
	}

	/**
	 * The track that sets the playhead. When it left the screen, the next one with footage at the
	 * playhead takes over from there. Null when no track has a picture yet.
	 */
	#lead(): Track | null {
		const current = this.#master === null ? undefined : this.#tracks.get(this.#master);
		if (current?.landed) return current;
		const landed = [...this.#tracks.values()].filter((track) => track.landed);
		const next = landed.find((t) => covers(bufferedRanges(t.buffer), this.#time)) ?? landed[0];
		if (!next) return null;
		this.#master = next.id;
		if (Math.abs(next.video.currentTime - this.#time) > DRIFT) {
			if (covers(bufferedRanges(next.buffer), this.#time)) next.video.currentTime = this.#time;
		}
		if (!this.#paused && this.#state !== "ended") next.video.play().catch(() => undefined);
		return next;
	}

	/** Puts every track with footage at `time` in step with it, and parks the rest. */
	#align(time: number): void {
		for (const track of this.#tracks.values()) {
			if (track.id === this.#master || !track.landed) continue;
			const { video } = track;
			if (!covers(bufferedRanges(track.buffer), time)) {
				if (!video.paused) video.pause();
				continue;
			}
			if (Math.abs(video.currentTime - time) > DRIFT) video.currentTime = time;
			if (video.playbackRate !== this.#rate) video.playbackRate = this.#rate;
			const running = !this.#paused && this.#state !== "ended";
			if (running && video.paused) video.play().catch(() => undefined);
		}
		this.#report();
	}

	#report(): void {
		const covered = new Map<number, boolean>();
		for (const track of this.#tracks.values()) {
			covered.set(track.key, covers(bufferedRanges(track.buffer), this.#time));
		}
		const text = [...covered].map(([key, on]) => `${key}:${on ? 1 : 0}`).join(",");
		if (text === this.#covered) return;
		this.#covered = text;
		this.#listener.onCover?.(covered);
	}

	/** Every track with footage there goes to `time`, and the first of them leads. */
	#jump(time: number): void {
		const there = [...this.#tracks.values()].filter(
			(track) => track.landed && covers(bufferedRanges(track.buffer), time),
		);
		if (there[0]) this.#master = there[0].id;
		for (const track of there) track.video.currentTime = time;
		this.#time = time;
		// Say where the jump landed now. Until the next watch the clock, and anything that
		// reads it like a camera step or a skip, would still be at the old spot.
		this.#listener.onTime(Math.min(DAY_MS, Math.round(time * 1000)));
	}

	#watch(): void {
		if (this.#landing) return;
		const lead = this.#lead();
		if (!lead) {
			// Every camera with a picture left. The next to arrive sets the playhead.
			this.#landing = true;
			return;
		}
		const buffer = lead.buffer;
		if (!buffer || buffer.updating) return;
		const video = lead.video;
		const time = video.currentTime;
		this.#time = time;
		const ms = Math.min(DAY_MS, Math.round(time * 1000));
		this.#say({ type: "at", ms });
		this.#listener.onTime(ms);
		const stalled = !video.paused && video.readyState < 3;
		const margin = stalled ? STALLED_MARGIN : undefined;
		if (!covers(bufferedRanges(buffer), time, margin)) {
			// This camera has nothing here. Another that does takes the lead without a jump.
			const other = [...this.#tracks.values()].find(
				(track) =>
					track.id !== lead.id && track.landed && covers(bufferedRanges(track.buffer), time),
			);
			if (other) {
				this.#master = other.id;
				if (!this.#paused && other.video.paused) other.video.play().catch(() => undefined);
			} else {
				const all = [...this.#tracks.values()]
					.flatMap((track) => bufferedRanges(track.buffer))
					.toSorted((a, b) => a[0] - b[0]);
				const next = nextRange(all, time, margin);
				if (next !== null) {
					this.#jump(next);
					return;
				}
			}
		}
		this.#align(time);
		if (this.#paused || this.#state === "ended") return;
		const end = Math.max(
			0,
			...[...this.#tracks.values()].flatMap((t) => bufferedRanges(t.buffer).map(([, e]) => e)),
		);
		const leader = this.#lead()?.video ?? video;
		if (this.#ended && time >= end - (margin ?? 0.15)) {
			for (const track of this.#tracks.values()) track.video.pause();
			this.#set("ended");
		} else if (leader.readyState >= 3 && !leader.paused) {
			this.#stalls = 0;
			this.#set("playing");
		} else if (++this.#stalls >= STALL_WATCHES) {
			this.#set("buffering");
		}
	}
}
