import {
	DAY_MS,
	type Quality,
	type ReplayCommand,
	ReplayEvent,
	type ReplayRate,
} from "@/shared/schema";
import { mediaSource } from "@/web/lib/player";
import { clampDay, covers, nextRange } from "@/web/lib/timeline";

export type ReplayState = "opening" | "playing" | "paused" | "buffering" | "ended" | "failed";

type Listener = {
	onState: (state: ReplayState, detail?: string) => void;
	onTime: (ms: number) => void;
	/** Which tracks hold footage at the playhead, each time that changes. */
	onCover?: (covered: readonly boolean[]) => void;
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

type Track = {
	video: HTMLVideoElement;
	source: MediaSource | null;
	objectUrl: string | null;
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
 * recording, another that still has footage takes over in place.
 */
export class ReplayPlayer {
	#tracks: Track[];
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
	#master = 0;
	#ended = false;
	#state: ReplayState | null = null;
	#stalls = 0;
	#covered: boolean[] = [];

	constructor(videos: readonly HTMLVideoElement[], listener: Listener, rate: ReplayRate = 1) {
		this.#listener = listener;
		this.#rate = rate;
		this.#tracks = videos.map((video) => {
			video.disableRemotePlayback = true;
			return {
				video,
				source: null,
				objectUrl: null,
				buffer: null,
				queue: [],
				clearing: false,
				landed: false,
			};
		});
	}

	start(cameras: readonly string[], quality: Quality, day: string, ms: number): void {
		this.#set("opening");
		const opened = this.#tracks.map(
			(track) =>
				new Promise<void>((resolve) => {
					const { source, managed } = mediaSource();
					track.source = source;
					if (managed) {
						track.video.srcObject = source;
					} else {
						track.objectUrl = URL.createObjectURL(source);
						track.video.src = track.objectUrl;
					}
					source.addEventListener("sourceopen", () => resolve(), { once: true });
				}),
		);
		void Promise.all(opened).then(() => {
			if (!this.#stopped) this.#connect(replayUrl(cameras, quality, day, ms));
		});
	}

	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
		const socket = this.#socket;
		this.#socket = null;
		socket?.close();
		for (const track of this.#tracks) {
			track.buffer = null;
			track.queue = [];
			const { video } = track;
			video.pause();
			video.srcObject = null;
			video.removeAttribute("src");
			video.load();
			if (track.objectUrl !== null) URL.revokeObjectURL(track.objectUrl);
			track.objectUrl = null;
		}
	}

	get paused(): boolean {
		return this.#paused;
	}

	seek(ms: number): void {
		this.#ended = false;
		this.#landing = true;
		this.#discarding = true;
		for (const track of this.#tracks) {
			track.clearing = true;
			track.landed = false;
			track.queue = [];
		}
		this.#set("buffering");
		this.#listener.onTime(ms);
		this.#say({ type: "seek", ms: clampDay(ms) });
		for (const track of this.#tracks) this.#pump(track);
	}

	setRate(value: ReplayRate): void {
		this.#rate = value;
		for (const track of this.#tracks) track.video.playbackRate = value;
		this.#say({ type: "rate", value });
	}

	setPaused(paused: boolean): void {
		this.#paused = paused;
		if (paused) {
			for (const track of this.#tracks) track.video.pause();
			this.#set("paused");
			return;
		}
		const master = this.#tracks[this.#master];
		master?.video.play().catch(() => undefined);
		if (master && !this.#landing) this.#align(master.video.currentTime, this.#ranges());
		this.#set(master && master.video.readyState >= 3 ? "playing" : "buffering");
	}

	#set(state: ReplayState, detail?: string): void {
		if (state === this.#state) return;
		this.#state = state;
		this.#listener.onState(state, detail);
	}

	#say(command: ReplayCommand): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(command));
	}

	#ranges(): Range[][] {
		return this.#tracks.map((track) => bufferedRanges(track.buffer));
	}

	#connect(url: string): void {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;

		socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
			if (this.#socket !== socket) return;
			if (typeof event.data === "string") {
				this.#event(event.data);
				return;
			}
			if (this.#discarding) return;
			const data = new Uint8Array(event.data);
			const track = this.#tracks[data[0] ?? -1];
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
				const track = this.#tracks[event.data.track];
				if (!track?.source || track.buffer) return;
				const buffer = track.source.addSourceBuffer(event.data.value);
				buffer.mode = "segments";
				buffer.addEventListener("updateend", () => this.#updated(track));
				track.buffer = buffer;
				this.#say({ type: "rate", value: this.#rate });
				this.#pump(track);
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
		if (buffer && !track.landed && !track.clearing && buffer.buffered.length > 0) {
			track.landed = true;
			const first = buffer.buffered.start(0);
			const { video } = track;
			video.playbackRate = this.#rate;
			if (this.#landing) {
				// The first picture after a start or a seek sets the playhead.
				this.#landing = false;
				this.#master = this.#tracks.indexOf(track);
				video.currentTime = first;
				if (this.#paused) {
					this.#listener.onTime(first * 1000);
					this.#set("paused");
				} else {
					video.play().catch(() => undefined);
				}
			} else {
				// A later track joins the playhead, or waits on its first picture until it gets there.
				const master = this.#tracks[this.#master];
				const time = master?.video.currentTime ?? first;
				video.currentTime = covers(bufferedRanges(buffer), time) ? time : first;
				this.#align(time, this.#ranges());
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

	/** Puts every track with footage at `time` in step with it, and parks the rest. */
	#align(time: number, ranges: readonly Range[][]): void {
		const covered = ranges.map((list) => covers(list, time));
		this.#tracks.forEach((track, i) => {
			if (i === this.#master || !track.landed) return;
			const { video } = track;
			if (!covered[i]) {
				if (!video.paused) video.pause();
				return;
			}
			if (Math.abs(video.currentTime - time) > DRIFT) video.currentTime = time;
			if (video.playbackRate !== this.#rate) video.playbackRate = this.#rate;
			const running = !this.#paused && this.#state !== "ended";
			if (running && video.paused) video.play().catch(() => undefined);
		});
		if (covered.some((value, i) => value !== this.#covered[i])) {
			this.#covered = covered;
			this.#listener.onCover?.(covered);
		}
	}

	/** Every track with footage there goes to `time`, and the first of them leads. */
	#jump(time: number, ranges: readonly Range[][]): void {
		const leader = ranges.findIndex((list) => covers(list, time));
		if (leader >= 0) this.#master = leader;
		this.#tracks.forEach((track, i) => {
			if (track.landed && covers(ranges[i] ?? [], time)) track.video.currentTime = time;
		});
		// Say where the jump landed now. Until the next watch the clock, and anything that
		// reads it like a camera step or a skip, would still be at the old spot.
		this.#listener.onTime(Math.min(DAY_MS, Math.round(time * 1000)));
	}

	#watch(): void {
		const master = this.#tracks[this.#master];
		const buffer = master?.buffer;
		if (!master || !buffer || buffer.updating || this.#landing) return;
		const video = master.video;
		const time = video.currentTime;
		const ms = Math.min(DAY_MS, Math.round(time * 1000));
		this.#say({ type: "at", ms });
		this.#listener.onTime(ms);
		const ranges = this.#ranges();
		const stalled = !video.paused && video.readyState < 3;
		const margin = stalled ? STALLED_MARGIN : undefined;
		if (!covers(ranges[this.#master] ?? [], time, margin)) {
			// This camera has nothing here. Another that does takes the lead without a jump.
			const other = ranges.findIndex(
				(list, i) => i !== this.#master && this.#tracks[i]?.landed === true && covers(list, time),
			);
			if (other >= 0) {
				this.#master = other;
				const next = this.#tracks[other];
				if (next && !this.#paused && next.video.paused) next.video.play().catch(() => undefined);
			} else {
				const all = ranges.flat().toSorted((a, b) => a[0] - b[0]);
				const next = nextRange(all, time, margin);
				if (next !== null) {
					this.#jump(next, ranges);
					return;
				}
			}
		}
		this.#align(time, ranges);
		if (this.#paused || this.#state === "ended") return;
		const end = Math.max(0, ...ranges.flat().map(([, last]) => last));
		const lead = this.#tracks[this.#master]?.video ?? video;
		if (this.#ended && time >= end - (margin ?? 0.15)) {
			for (const track of this.#tracks) track.video.pause();
			this.#set("ended");
		} else if (lead.readyState >= 3 && !lead.paused) {
			this.#stalls = 0;
			this.#set("playing");
		} else if (++this.#stalls >= STALL_WATCHES) {
			this.#set("buffering");
		}
	}
}
