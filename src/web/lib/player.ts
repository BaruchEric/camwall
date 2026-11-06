export type PlayerState = "idle" | "waiting" | "connecting" | "live" | "retrying";

export type PlayerStats = { kbps: number; width: number; height: number };

type Listener = {
	onState: (state: PlayerState) => void;
	onStats: (stats: PlayerStats) => void;
};

/** Recorders can take seconds to open a channel, so opens run in small batches. */
const MAX_OPENING = 4;
/** Seconds behind the live edge before the picture jumps forward. */
const LATE = 2.5;
/** Seconds of video kept behind the playhead. */
const KEEP = 4;
/** No data for this long means the connection is dead even if the socket says otherwise. */
const STALL_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

const CODECS = ["avc1.640029", "avc1.64002A", "avc1.640033", "avc1.4D4029", "avc1.42E029"];

let opening = 0;
const waiting: MsePlayer[] = [];

function openNext(): void {
	while (opening < MAX_OPENING) {
		const next = waiting.shift();
		if (!next) return;
		if (next.ready) {
			opening++;
			next.open();
		}
	}
}

function mediaSource(): { source: MediaSource; managed: boolean } {
	if ("ManagedMediaSource" in window) return { source: new ManagedMediaSource(), managed: true };
	return { source: new MediaSource(), managed: false };
}

function supported(type: string): boolean {
	return "ManagedMediaSource" in window
		? ManagedMediaSource.isTypeSupported(type)
		: MediaSource.isTypeSupported(type);
}

function isControl(value: unknown): value is { type: string; value?: unknown } {
	return typeof value === "object" && value !== null && "type" in value;
}

function parseControl(text: string): { type: string; value?: unknown } | null {
	try {
		const value: unknown = JSON.parse(text);
		return isControl(value) ? value : null;
	} catch {
		return null;
	}
}

/** Plays one go2rtc MSE stream into one video element, and keeps it near the live edge. */
export class MsePlayer {
	#video: HTMLVideoElement;
	#url: string;
	#listener: Listener;
	#wanted = false;
	#socket: WebSocket | null = null;
	#holdsSlot = false;
	#attempts = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#watchTimer: ReturnType<typeof setInterval> | undefined;
	#lastData = 0;
	#bytes = 0;
	#objectUrl: string | null = null;

	constructor(video: HTMLVideoElement, url: string, listener: Listener) {
		this.#video = video;
		this.#url = url;
		this.#listener = listener;
		video.disableRemotePlayback = true;
	}

	get ready(): boolean {
		return this.#wanted && this.#socket === null;
	}

	start(): void {
		if (this.#wanted) return;
		this.#wanted = true;
		this.#attempts = 0;
		this.#listener.onState("waiting");
		waiting.push(this);
		openNext();
	}

	stop(): void {
		if (!this.#wanted) return;
		this.#wanted = false;
		clearTimeout(this.#retryTimer);
		const index = waiting.indexOf(this);
		if (index >= 0) waiting.splice(index, 1);
		this.#teardown();
		this.#listener.onState("idle");
	}

	open(): void {
		this.#holdsSlot = true;
		this.#listener.onState("connecting");
		const { source, managed } = mediaSource();
		if (managed) {
			this.#video.srcObject = source;
		} else {
			this.#objectUrl = URL.createObjectURL(source);
			this.#video.src = this.#objectUrl;
		}
		source.addEventListener("sourceopen", () => this.#attach(source), { once: true });
	}

	#release(): void {
		if (!this.#holdsSlot) return;
		this.#holdsSlot = false;
		opening--;
		openNext();
	}

	#teardown(): void {
		clearInterval(this.#watchTimer);
		const socket = this.#socket;
		this.#socket = null;
		socket?.close();
		this.#release();
		const video = this.#video;
		video.pause();
		video.srcObject = null;
		video.removeAttribute("src");
		video.load();
		if (this.#objectUrl !== null) URL.revokeObjectURL(this.#objectUrl);
		this.#objectUrl = null;
	}

	#attach(source: MediaSource): void {
		if (!this.#wanted) {
			this.#release();
			return;
		}
		const socket = new WebSocket(this.#url);
		socket.binaryType = "arraybuffer";
		this.#socket = socket;
		this.#lastData = Date.now();
		this.#bytes = 0;

		const video = this.#video;
		const queue: ArrayBuffer[] = [];
		let buffer: SourceBuffer | null = null;

		const pump = () => {
			if (this.#socket !== socket || !buffer || buffer.updating) return;
			// Seek and play come before the append. A busy stream always has data
			// queued, so anything placed after the append would never run.
			const { buffered } = buffer;
			if (buffered.length > 0) {
				const first = buffered.start(0);
				const end = buffered.end(buffered.length - 1);
				if (video.currentTime < first || end - video.currentTime > LATE) {
					video.currentTime = Math.max(first, end - 0.3);
				}
				if (video.paused) video.play().catch(() => undefined);
				if (video.currentTime - first > KEEP + 2) {
					buffer.remove(first, video.currentTime - KEEP);
					return;
				}
			}
			if (queue.length === 0) return;
			const data = new Uint8Array(queue.reduce((sum, part) => sum + part.byteLength, 0));
			let offset = 0;
			for (const part of queue) {
				data.set(new Uint8Array(part), offset);
				offset += part.byteLength;
			}
			queue.length = 0;
			try {
				buffer.appendBuffer(data);
			} catch {
				this.#reconnect();
			}
		};

		socket.onopen = () => {
			const codecs = CODECS.filter((codec) => supported(`video/mp4; codecs="${codec}"`));
			socket.send(JSON.stringify({ type: "mse", value: codecs.join() }));
		};

		socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
			if (this.#socket !== socket) return;
			this.#lastData = Date.now();
			if (typeof event.data === "string") {
				const message = parseControl(event.data);
				if (message?.type === "error") {
					this.#reconnect();
				} else if (message?.type === "mse" && typeof message.value === "string") {
					buffer = source.addSourceBuffer(message.value);
					buffer.mode = "segments";
					buffer.addEventListener("updateend", pump);
				}
				return;
			}
			if (this.#holdsSlot) {
				this.#release();
				this.#attempts = 0;
				this.#listener.onState("live");
			}
			this.#bytes += event.data.byteLength;
			queue.push(event.data);
			pump();
		};

		socket.onclose = () => {
			if (this.#socket === socket) this.#reconnect();
		};

		let lastTick = Date.now();
		this.#watchTimer = setInterval(() => {
			const now = Date.now();
			if (now - this.#lastData > STALL_MS) {
				this.#reconnect();
				return;
			}
			const seconds = (now - lastTick) / 1000;
			lastTick = now;
			this.#listener.onStats({
				kbps: Math.round((this.#bytes * 8) / 1000 / seconds),
				width: video.videoWidth,
				height: video.videoHeight,
			});
			this.#bytes = 0;
		}, 2000);
	}

	#reconnect(): void {
		this.#teardown();
		if (!this.#wanted) return;
		this.#listener.onState("retrying");
		const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** this.#attempts);
		this.#attempts++;
		clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => {
			if (!this.#wanted) return;
			waiting.push(this);
			openNext();
		}, delay);
	}
}
