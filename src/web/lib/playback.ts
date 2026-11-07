import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraId, Quality, ReplayRate, Span } from "@/shared/schema";
import { api } from "@/web/lib/api";
import { type ReplayEntry, ReplayPlayer, type ReplayState } from "@/web/lib/replay";
import { clampDay, type Moment, openingMs } from "@/web/lib/timeline";

export const STATE_NOTE: Record<ReplayState, string | null> = {
	opening: "Opening the recording",
	buffering: "Fetching video",
	playing: null,
	paused: null,
	ended: "No more footage after this. Press play to check again.",
	failed: "The replay stopped.",
};

export type Playback = {
	days: readonly string[];
	day: string | null;
	spans: readonly Span[];
	/** Milliseconds after midnight on the recorder's clock. */
	position: number;
	state: ReplayState;
	paused: boolean;
	rate: ReplayRate;
	/** Which cameras, in the order given, hold footage at the playhead. */
	/** Which pictures, by key, hold footage at the playhead. */
	covered: ReadonlyMap<number, boolean>;
	/** What to say over the picture, if anything. */
	note: string | null;
	/** True when the note is bad news rather than a wait. */
	failed: boolean;
	/** Offered when the replay stopped on its own and may work again. */
	canRetry: boolean;
	seek: (ms: number) => void;
	toggle: () => void;
	setRate: (rate: ReplayRate) => void;
	changeDay: (day: string | null) => void;
	retry: () => void;
};

/**
 * One replay of some cameras on one clock: the days and recordings they hold, where the
 * playhead is, and the player itself. However the cameras or the quality change, from a step,
 * the camera list, a page or another view, the moment stays.
 */
/** A picture that plays: a tile's index, or 0 for the one big picture, and its camera. */
export type PlaybackTrack = { key: number; camera: CameraId };

export function usePlayback({
	scope,
	tracks,
	restart,
	quality,
	at,
	video,
}: {
	/** The cameras the days and the timeline cover. Empty means nothing here can play back. */
	scope: readonly CameraId[];
	/** What plays now. These come and go on one connection, so a scroll or a page costs no restart. */
	tracks: readonly PlaybackTrack[];
	/** A change here starts a new connection, like stepping to another camera in full view. */
	restart: string;
	quality: Quality;
	/** Where to open, from a link or another view. Null opens just before the newest footage. */
	at: Moment | null;
	video: (key: number) => HTMLVideoElement | null;
}): Playback {
	const scopeKey = scope.join(",");
	const tracksKey = tracks.map(({ key, camera }) => `${key}:${camera}`).join(",");
	const hasTracks = tracks.length > 0;
	const player = useRef<ReplayPlayer | null>(null);
	const [days, setDays] = useState<readonly string[]>([]);
	const [day, setDay] = useState<string | null>(at?.day ?? null);
	const [spans, setSpans] = useState<readonly Span[] | null>(null);
	/** Where the next connection starts. Null waits for the timeline to choose. */
	const [start, setStart] = useState<number | null>(at?.ms ?? null);
	const [position, setPosition] = useState(at?.ms ?? 0);
	const [rate, setRateState] = useState<ReplayRate>(1);
	const [state, setState] = useState<ReplayState>("opening");
	const [detail, setDetail] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [covered, setCovered] = useState<ReadonlyMap<number, boolean>>(new Map());
	const [attempt, setAttempt] = useState(0);

	// A new connection opens where the old one was, so the moment stays.
	const [shown, setShown] = useState({ restart, quality, hasTracks });
	if (shown.restart !== restart || shown.quality !== quality || shown.hasTracks !== hasTracks) {
		setShown({ restart, quality, hasTracks });
		setStart((current) => (current === null ? null : position));
		setCovered(new Map());
	}

	const dayNow = useRef(day);
	dayNow.current = day;
	const rateNow = useRef(rate);
	rateNow.current = rate;
	const positionNow = useRef(position);
	positionNow.current = position;
	const tracksNow = useRef(tracks);
	tracksNow.current = tracks;
	const videoNow = useRef(video);
	videoNow.current = video;
	const entries = useCallback(
		(): ReplayEntry[] =>
			tracksNow.current.flatMap(({ key, camera }) => {
				const element = videoNow.current(key);
				return element ? [{ key, camera, video: element }] : [];
			}),
		[],
	);

	useEffect(() => {
		if (scopeKey === "") return;
		let live = true;
		api.replayDays(scopeKey.split(",")).then(
			(found) => {
				if (!live) return;
				setProblem(found.length === 0 ? "This recorder holds no footage." : null);
				setDays(found);
				const current = dayNow.current;
				if (current !== null && found.includes(current)) return;
				// A time of day means nothing on another day, so the newest footage decides.
				setStart(null);
				setDay(found.at(-1) ?? null);
			},
			(error: unknown) => {
				if (live)
					setProblem(error instanceof Error ? error.message : "The recorder did not answer");
			},
		);
		return () => {
			live = false;
		};
	}, [scopeKey]);

	useEffect(() => {
		if (scopeKey === "" || day === null) return;
		let live = true;
		setSpans(null);
		api.replaySpans(scopeKey.split(","), day).then(
			(found) => {
				if (!live) return;
				setSpans(found);
				setStart((current) => current ?? openingMs(found));
			},
			(error: unknown) => {
				if (live)
					setProblem(error instanceof Error ? error.message : "The recorder did not answer");
			},
		);
		return () => {
			live = false;
		};
	}, [scopeKey, day]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `restart` and `attempt` start over on purpose
	useEffect(() => {
		if (!hasTracks || day === null || start === null) return;
		const first = entries();
		if (first.length === 0) return;
		setPosition(start);
		const next = new ReplayPlayer(
			{
				onState: (value, text) => {
					setState(value);
					setDetail(text ?? null);
				},
				onTime: setPosition,
				onCover: setCovered,
			},
			rateNow.current,
		);
		player.current = next;
		next.start(first, quality, day, start);
		return () => {
			next.stop();
			player.current = null;
		};
	}, [restart, quality, day, start, attempt, hasTracks, entries]);

	// Cameras coming and going, from a scroll, a page or another view, keep the connection.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tracksKey` is what changed
	useEffect(() => {
		const current = player.current;
		if (!current || current.setEntries(entries())) return;
		// The socket has given out all its track numbers. A new one starts at the same moment.
		setStart(positionNow.current);
		setAttempt((value) => value + 1);
	}, [tracksKey, entries]);

	const seek = useCallback((ms: number) => player.current?.seek(clampDay(ms)), []);

	const toggle = useCallback(() => {
		const current = player.current;
		if (!current) return;
		// Footage from the last few seconds may have landed on the recorder since.
		if (state === "ended") current.seek(position);
		else current.setPaused(!current.paused);
	}, [state, position]);

	const setRate = useCallback((value: ReplayRate) => {
		setRateState(value);
		player.current?.setRate(value);
	}, []);

	const changeDay = useCallback((next: string | null) => {
		if (next === null) return;
		setStart(null);
		setDay(next);
	}, []);

	const retry = useCallback(() => {
		setStart(position);
		setAttempt((value) => value + 1);
	}, [position]);

	const failed = problem !== null || state === "failed";
	const note = problem ?? (state === "failed" ? (detail ?? STATE_NOTE.failed) : STATE_NOTE[state]);
	return {
		days,
		day,
		spans: spans ?? [],
		position,
		state,
		paused: state === "paused" || state === "ended",
		rate,
		covered,
		note,
		failed,
		canRetry: state === "failed" && problem === null,
		seek,
		toggle,
		setRate,
		changeDay,
		retry,
	};
}
