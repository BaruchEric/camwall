import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraId, Quality, ReplayRate, Span } from "@/shared/schema";
import { api } from "@/web/lib/api";
import { ReplayPlayer, type ReplayState } from "@/web/lib/replay";
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
	covered: readonly boolean[];
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
export function usePlayback({
	cameras,
	quality,
	at,
	videos,
}: {
	/** In the order of `videos`. Empty means nothing on screen can play back. */
	cameras: readonly CameraId[];
	quality: Quality;
	/** Where to open, from a link or another view. Null opens just before the newest footage. */
	at: Moment | null;
	videos: () => readonly (HTMLVideoElement | null)[];
}): Playback {
	const key = cameras.join(",");
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
	const [covered, setCovered] = useState<readonly boolean[]>([]);
	const [attempt, setAttempt] = useState(0);

	const [shown, setShown] = useState({ key, quality });
	if (shown.key !== key || shown.quality !== quality) {
		setShown({ key, quality });
		setStart((current) => (current === null ? null : position));
		setCovered([]);
	}

	const dayNow = useRef(day);
	dayNow.current = day;
	const rateNow = useRef(rate);
	rateNow.current = rate;
	const videosNow = useRef(videos);
	videosNow.current = videos;

	useEffect(() => {
		if (key === "") return;
		let live = true;
		api.replayDays(key.split(",")).then(
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
	}, [key]);

	useEffect(() => {
		if (key === "" || day === null) return;
		let live = true;
		setSpans(null);
		api.replaySpans(key.split(","), day).then(
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
	}, [key, day]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how Try again reconnects
	useEffect(() => {
		if (key === "" || day === null || start === null) return;
		const elements = videosNow.current();
		const ready = elements.filter((element) => element !== null);
		if (ready.length !== elements.length || ready.length === 0) return;
		setPosition(start);
		const next = new ReplayPlayer(
			ready,
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
		next.start(key.split(","), quality, day, start);
		return () => {
			next.stop();
			player.current = null;
		};
	}, [key, quality, day, start, attempt]);

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
