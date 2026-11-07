import { DAY_MS, type Quality, type ReplayCommand, ReplayEvent } from "@/shared/schema";
import { mediaSource } from "@/web/lib/player";
import { clampDay, nextRange } from "@/web/lib/timeline";

export type ReplayState = "opening" | "playing" | "paused" | "buffering" | "ended" | "failed";

type Listener = {
	onState: (state: ReplayState, detail?: string) => void;
	onTime: (ms: number) => void;
};

const WATCH_MS = 200;
/** A blip this short between two appends is not worth a message on the picture. */
const STALL_WATCHES = 3;
/** Seconds. The decoder keeps up to 16 frames back, which is about one second at 15 fps. */
const STALLED_MARGIN = 1.2;
/** Seconds of played video kept behind the playhead, so a short step back is instant. */
const KEEP = 30;

function bufferedRanges(buffer: SourceBuffer): [number, number][] {
	const { buffered } = buffer;
	const ranges: [number, number][] = [];
	for (let i = 0; i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
	return ranges;
}

function replayUrl(camera: string, quality: Quality, day: string, ms: number): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const query = new URLSearchParams({ day, ms: String(clampDay(ms)) });
	return `${scheme}://${location.host}/ws/replay/${camera}/${quality}?${query}`;
}

/** Plays one replay socket into one video element. Timestamps are the recorder's time of day. */
export class ReplayPlayer {
	#video: HTMLVideoElement;
	#listener: Listener;
	#socket: WebSocket | null = null;
	#buffer: SourceBuffer | null = null;
	#queue: ArrayBuffer[] = [];
	#objectUrl: string | null = null;
	#timer: ReturnType<typeof setInterval> | undefined;
	#paused = false;
	#rate = 1;
	/** Drops everything from the old spot until the server says the seek is done. */
	#discarding = false;
	#clearing = false;
	/** The next video to arrive sets the playhead. */
	#landing = true;
	#ended = false;
	#state: ReplayState | null = null;
	#stalls = 0;

	constructor(video: HTMLVideoElement, listener: Listener) {
		this.#video = video;
		this.#listener = listener;
		video.disableRemotePlayback = true;
	}

	start(camera: string, quality: Quality, day: string, ms: number): void {
		this.#set("opening");
		const { source, managed } = mediaSource();
		if (managed) {
			this.#video.srcObject = source;
		} else {
			this.#objectUrl = URL.createObjectURL(source);
			this.#video.src = this.#objectUrl;
		}
		source.addEventListener(
			"sourceopen",
			() => this.#connect(source, replayUrl(camera, quality, day, ms)),
			{ once: true },
		);
	}

	stop(): void {
		clearInterval(this.#timer);
		const socket = this.#socket;
		this.#socket = null;
		socket?.close();
		this.#buffer = null;
		this.#queue = [];
		const video = this.#video;
		video.pause();
		video.srcObject = null;
		video.removeAttribute("src");
		video.load();
		if (this.#objectUrl !== null) URL.revokeObjectURL(this.#objectUrl);
		this.#objectUrl = null;
	}

	get paused(): boolean {
		return this.#paused;
	}

	seek(ms: number): void {
		this.#ended = false;
		this.#landing = true;
		this.#discarding = true;
		this.#clearing = true;
		this.#queue = [];
		this.#set("buffering");
		this.#listener.onTime(ms);
		this.#say({ type: "seek", ms: clampDay(ms) });
		this.#pump();
	}

	setRate(value: 1 | 2 | 4 | 8): void {
		this.#rate = value;
		this.#video.playbackRate = value;
		this.#say({ type: "rate", value });
	}

	setPaused(paused: boolean): void {
		this.#paused = paused;
		if (paused) {
			this.#video.pause();
			this.#set("paused");
		} else {
			this.#video.play().catch(() => undefined);
			this.#set(this.#video.readyState >= 3 ? "playing" : "buffering");
		}
	}

	#set(state: ReplayState, detail?: string): void {
		if (state === this.#state) return;
		this.#state = state;
		this.#listener.onState(state, detail);
	}

	#say(command: ReplayCommand): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(command));
	}

	#connect(source: MediaSource, url: string): void {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;

		socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
			if (this.#socket !== socket) return;
			if (typeof event.data === "string") {
				this.#event(source, event.data);
				return;
			}
			if (this.#discarding) return;
			this.#queue.push(event.data);
			this.#pump();
		};

		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#set("failed", "The connection to Camwall dropped.");
		};

		this.#timer = setInterval(() => this.#watch(), WATCH_MS);
	}

	#event(source: MediaSource, text: string): void {
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
				const buffer = source.addSourceBuffer(event.data.value);
				buffer.mode = "segments";
				buffer.addEventListener("updateend", () => this.#updated());
				this.#buffer = buffer;
				this.#say({ type: "rate", value: this.#rate as 1 | 2 | 4 | 8 });
				this.#pump();
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

	#updated(): void {
		const buffer = this.#buffer;
		if (buffer && this.#landing && !this.#clearing && buffer.buffered.length > 0) {
			this.#landing = false;
			const first = buffer.buffered.start(0);
			this.#video.currentTime = first;
			this.#video.playbackRate = this.#rate;
			if (this.#paused) {
				this.#listener.onTime(first * 1000);
				this.#set("paused");
			} else {
				this.#video.play().catch(() => undefined);
			}
		}
		this.#pump();
	}

	#pump(): void {
		const buffer = this.#buffer;
		if (!buffer || buffer.updating) return;
		if (this.#clearing) {
			this.#clearing = false;
			if (buffer.buffered.length > 0) {
				buffer.remove(0, buffer.buffered.end(buffer.buffered.length - 1));
				return;
			}
		}
		const ranges = bufferedRanges(buffer);
		const oldest = ranges[0]?.[0];
		const time = this.#video.currentTime;
		if (oldest !== undefined && time - oldest > KEEP * 2) {
			buffer.remove(oldest, time - KEEP);
			return;
		}
		if (this.#queue.length === 0) return;
		const data = new Uint8Array(this.#queue.reduce((sum, part) => sum + part.byteLength, 0));
		let offset = 0;
		for (const part of this.#queue) {
			data.set(new Uint8Array(part), offset);
			offset += part.byteLength;
		}
		this.#queue = [];
		try {
			buffer.appendBuffer(data);
		} catch {
			this.#set("failed", "This browser could not take the video.");
		}
	}

	#watch(): void {
		const buffer = this.#buffer;
		if (!buffer || buffer.updating || this.#landing) return;
		const video = this.#video;
		const time = video.currentTime;
		const ms = Math.min(DAY_MS, Math.round(time * 1000));
		this.#say({ type: "at", ms });
		this.#listener.onTime(ms);
		const ranges = bufferedRanges(buffer);
		const stalled = !video.paused && video.readyState < 3;
		const margin = stalled ? STALLED_MARGIN : undefined;
		const next = nextRange(ranges, time, margin);
		if (next !== null) {
			video.currentTime = next;
			return;
		}
		if (this.#paused || this.#state === "ended") return;
		const end = ranges.at(-1)?.[1] ?? 0;
		if (this.#ended && time >= end - (margin ?? 0.15)) {
			video.pause();
			this.#set("ended");
		} else if (video.readyState >= 3 && !video.paused) {
			this.#stalls = 0;
			this.#set("playing");
		} else if (++this.#stalls >= STALL_WATCHES) {
			this.#set("buffering");
		}
	}
}
