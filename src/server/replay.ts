import {
	DvrConnection as Connection,
	type DvrConnection,
	dateId,
	mergeSpans,
	moveReplay,
	openReplay,
	type RecorderAddress,
	type ReplayTarget,
	readChannelSpans,
} from "@/server/dvr/client";
import {
	Code,
	type Message,
	parseStatus,
	parseVideo,
	REPLAY,
	type VideoFrame,
} from "@/server/dvr/protocol";
import { codecOf, findParameterSets, fragment, initSegment } from "@/server/fmp4";
import { log } from "@/server/log";
import {
	DAY_MS,
	type Quality,
	type ReplayCommand,
	type ReplayEvent,
	type Span,
} from "@/shared/schema";

const TICK_MS = 20;
/** Pulls per tick: about 13 times real time, so a buffer fills fast and then waits. */
const PULLS = 16;
/** Seconds of video kept ahead of the viewer's playhead, at normal speed. */
const LEAD_MS = 6000;
/** Past this much recorder time with no frame, the channel has stopped recording. */
const QUIET_MS = 2000;
/** The clock has reached the end of what exists if this many pulls do not move it. */
const STUCK_PULLS = 400;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const SPANS_REFRESH_MS = 10_000;
const FALLBACK_FRAME_MS = 67;
/** Longer than any frame gap within one recording, so this marks a jump. */
const MAX_FRAME_MS = 1000;

export type ReplayOutput = {
	event: (event: ReplayEvent) => void;
	/** Video for one track: the place its camera holds in the viewer's list. */
	bytes: (track: number, data: Uint8Array) => void;
	/** Bytes still waiting to reach the viewer. */
	queued: () => number;
	close: () => void;
};

/** A recorder channel, and the tracks that show it. Two tiles may show one channel. */
export type ReplayChannel = { channel: number; tracks: readonly number[] };

export type ReplayRequest = {
	address: RecorderAddress;
	channels: readonly ReplayChannel[];
	quality: Quality;
	day: string;
	ms: number;
};

/** Where playback should go from `clock`. Null means nothing is recorded after it. */
export function nextRecorded(spans: readonly Span[], clock: number): number | null {
	const span = spans.find(([, end]) => end > clock);
	if (!span) return null;
	return Math.max(span[0], clock);
}

type ChannelState = {
	tracks: readonly number[];
	started: boolean;
	/** True from a seek until this channel's first key frame after it. */
	settling: boolean;
	held: VideoFrame | null;
	sequence: number;
};

/**
 * Feeds one viewer from one recorder. The recorder plays every channel asked for on one clock,
 * and only moves when it is pulled, which makes this loop the throttle: it pulls until the
 * viewer has enough, so pausing needs no message at all.
 */
export class ReplaySession {
	#request: ReplayRequest;
	#out: ReplayOutput;
	#connection: DvrConnection | null = null;
	#target: ReplayTarget | null = null;
	#channels: Map<number, ChannelState>;
	#timer: ReturnType<typeof setInterval> | undefined;
	#stopped = false;
	#rate = 1;
	#playhead: number;
	#clock: number;
	#lastClock = -1;
	#stuck = 0;
	/** The newest frame from any channel since the last move. */
	#lastFrameMs: number | null = null;
	#moving = false;
	#queuedMove: { ms: number; announce: boolean } | null = null;
	#ended = false;
	/** Every channel's recordings, joined. Silence is skipped only where all of them are quiet. */
	#spans: Span[] | null = null;
	#spansAt = 0;

	constructor(request: ReplayRequest, out: ReplayOutput) {
		this.#request = request;
		this.#out = out;
		this.#playhead = request.ms;
		this.#clock = request.ms;
		this.#channels = new Map(
			request.channels.map(({ channel, tracks }) => [
				channel,
				{ tracks, started: false, settling: true, held: null, sequence: 0 },
			]),
		);
	}

	async start(): Promise<void> {
		const { address, quality, day, ms } = this.#request;
		try {
			const connection = await Connection.open(address);
			if (this.#stopped) {
				connection.close();
				return;
			}
			this.#connection = connection;
			connection.onPush = (message) => this.#receive(message);
			connection.onClose = (reason) => this.#lost(reason);
			const id = await dateId(connection, day);
			if (id === 0) throw new Error("The recorder has nothing for that day");
			this.#target = { id, channels: [...this.#channels.keys()], quality };
			void this.#refreshSpans();
			await openReplay(connection, this.#target, ms);
			this.#timer = setInterval(() => this.#tick(), TICK_MS);
		} catch (error) {
			this.#fail(error);
		}
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		clearInterval(this.#timer);
		this.#connection?.close();
	}

	handle(command: ReplayCommand): void {
		switch (command.type) {
			case "at":
				this.#playhead = command.ms;
				break;
			case "rate":
				this.#rate = command.value;
				break;
			case "seek":
				this.#move(command.ms, true);
				break;
			default: {
				const _exhaustive: never = command;
				throw new Error(`Unknown command ${String(_exhaustive)}`);
			}
		}
	}

	#fail(error: unknown): void {
		if (this.#stopped) return;
		const value = error instanceof Error ? error.message : "The replay stopped";
		this.#out.event({ type: "error", value });
		this.stop();
		this.#out.close();
	}

	#lost(reason: string): void {
		if (this.#stopped) return;
		log.warn("replay lost its recorder", { reason });
		this.#fail(new Error(reason));
	}

	async #refreshSpans(): Promise<void> {
		this.#spansAt = Date.now();
		const { address, day } = this.#request;
		try {
			const found = await readChannelSpans(address, day, [...this.#channels.keys()]);
			this.#spans = mergeSpans([...found.values()].flat());
		} catch (error) {
			log.warn("replay could not read the timeline", { error: String(error) });
		}
	}

	#move(ms: number, announce: boolean): void {
		if (this.#moving) {
			this.#queuedMove = { ms, announce: announce || this.#queuedMove?.announce === true };
			return;
		}
		void this.#moveNow(ms, announce);
	}

	async #moveNow(ms: number, announce: boolean): Promise<void> {
		const connection = this.#connection;
		const target = this.#target;
		if (!connection || !target) return;
		this.#moving = true;
		for (const channel of this.#channels.values()) {
			channel.settling = true;
			channel.held = null;
		}
		this.#ended = false;
		this.#stuck = 0;
		this.#clock = ms;
		this.#lastFrameMs = null;
		if (announce) this.#playhead = ms;
		try {
			await moveReplay(connection, target, ms);
		} catch (error) {
			this.#fail(error);
			return;
		}
		// Frames ahead of this point in the stream were already on their way from the old spot.
		this.#moving = false;
		if (announce) this.#out.event({ type: "seeked", ms });
		const queued = this.#queuedMove;
		this.#queuedMove = null;
		if (queued) void this.#moveNow(queued.ms, queued.announce);
	}

	#receive(message: Message): void {
		if (message.type === REPLAY && message.code === Code.pull) {
			this.#clock = parseStatus(message.body).ms;
			return;
		}
		const frame = parseVideo(message);
		const channel = frame ? this.#channels.get(frame.channel) : undefined;
		if (!frame || !channel || this.#moving) return;
		if (channel.settling) {
			if (!frame.key) return;
			channel.settling = false;
		}
		if (!channel.started && !this.#begin(channel, frame)) return;
		this.#lastFrameMs = Math.max(this.#lastFrameMs ?? 0, frame.ms);
		const held = channel.held;
		channel.held = frame;
		if (held) this.#emit(channel, held, frame.ms - held.ms);
	}

	#begin(channel: ChannelState, frame: VideoFrame): boolean {
		const sets = findParameterSets(frame.data);
		if (!sets) return false;
		channel.started = true;
		const value = `video/mp4; codecs="${codecOf(sets.sps)}"`;
		const init = initSegment({ ...sets, width: frame.width, height: frame.height });
		for (const track of channel.tracks) {
			this.#out.event({ type: "mse", track, value });
			this.#out.bytes(track, init);
		}
		return true;
	}

	#emit(channel: ChannelState, frame: VideoFrame, gap: number): void {
		channel.sequence++;
		const data = fragment({
			sequence: channel.sequence,
			dts: frame.ms,
			duration: gap > 0 && gap <= MAX_FRAME_MS ? gap : FALLBACK_FRAME_MS,
			key: frame.key,
			data: frame.data,
		});
		for (const track of channel.tracks) this.#out.bytes(track, data);
	}

	#finish(): void {
		if (this.#ended) return;
		this.#ended = true;
		for (const channel of this.#channels.values()) {
			const held = channel.held;
			channel.held = null;
			if (held) this.#emit(channel, held, FALLBACK_FRAME_MS);
		}
		this.#out.event({ type: "end" });
	}

	/** A channel that records on motion is silent for hours, so silence is skipped, not played. */
	#skipSilence(): boolean {
		if (this.#spans === null) return false;
		const silent = this.#clock - (this.#lastFrameMs ?? this.#clock) > QUIET_MS;
		if (this.#lastFrameMs !== null && !silent) return false;
		const next = nextRecorded(this.#spans, this.#clock);
		if (next === null) {
			if (Date.now() - this.#spansAt > SPANS_REFRESH_MS) void this.#refreshSpans();
			else this.#finish();
			return true;
		}
		if (next <= this.#clock + QUIET_MS) return false;
		this.#move(next, false);
		return true;
	}

	#tick(): void {
		const connection = this.#connection;
		if (!connection || this.#moving || this.#ended) return;
		if (this.#out.queued() > MAX_QUEUED_BYTES) return;
		if (this.#clock >= DAY_MS - 1) {
			this.#finish();
			return;
		}
		const ahead = this.#lastFrameMs === null ? 0 : this.#lastFrameMs - this.#playhead;
		if (ahead >= LEAD_MS * this.#rate) return;
		if (this.#skipSilence()) return;
		this.#stuck = this.#clock === this.#lastClock ? this.#stuck + PULLS : 0;
		this.#lastClock = this.#clock;
		if (this.#stuck >= STUCK_PULLS) {
			this.#finish();
			return;
		}
		for (let i = 0; i < PULLS; i++) connection.send(REPLAY, Code.pull);
	}
}

/**
 * One viewer's replay across however many recorders its cameras sit on, one session each. A
 * seek counts as done, and the footage as over, only once every recorder has said so.
 */
export class ReplayMux {
	#sessions: ReplaySession[];
	#out: ReplayOutput;
	#seeking = new Set<ReplaySession>();
	#ended = new Set<ReplaySession>();

	constructor(requests: readonly ReplayRequest[], out: ReplayOutput) {
		this.#out = out;
		this.#sessions = requests.map((request) => {
			const session: ReplaySession = new ReplaySession(request, {
				...out,
				event: (event) => this.#event(session, event),
			});
			return session;
		});
	}

	start(): Promise<void> {
		return Promise.all(this.#sessions.map((session) => session.start())).then(() => undefined);
	}

	stop(): void {
		for (const session of this.#sessions) session.stop();
	}

	handle(command: ReplayCommand): void {
		if (command.type === "seek") {
			this.#seeking = new Set(this.#sessions);
			this.#ended.clear();
		}
		for (const session of this.#sessions) session.handle(command);
	}

	#event(session: ReplaySession, event: ReplayEvent): void {
		switch (event.type) {
			case "seeked":
				this.#seeking.delete(session);
				if (this.#seeking.size === 0) this.#out.event(event);
				return;
			case "end":
				this.#ended.add(session);
				if (this.#ended.size === this.#sessions.length) this.#out.event(event);
				return;
			default:
				this.#out.event(event);
		}
	}
}
