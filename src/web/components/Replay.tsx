import {
	CalendarDays,
	Camera as CameraIcon,
	ChevronLeft,
	ChevronRight,
	Pause,
	Play,
	RotateCcw,
	RotateCw,
	SkipBack,
	SkipForward,
	X,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type CameraId,
	type PublicCamera,
	type Quality,
	REPLAY_RATES,
	type Span,
} from "@/shared/schema";
import { Menu } from "@/web/components/ui";
import { api } from "@/web/lib/api";
import { useMedia } from "@/web/lib/hooks";
import { ReplayPlayer, type ReplayState } from "@/web/lib/replay";
import { saveSnapshot } from "@/web/lib/snapshot";
import {
	barsIn,
	clampDay,
	clockText,
	dayText,
	fractionOf,
	monthCells,
	msAt,
	openingMs,
	SKIP_MS,
	stepDay,
	ticksIn,
	timelineWindow,
	ZOOM_HOURS,
	type ZoomHours,
} from "@/web/lib/timeline";

type Rate = (typeof REPLAY_RATES)[number];

const STATE_NOTE: Record<ReplayState, string | null> = {
	opening: "Opening the recording",
	buffering: "Fetching video",
	playing: null,
	paused: null,
	ended: "No more footage after this. Press play to check again.",
	failed: "The replay stopped.",
};

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function CalendarPanel({
	days,
	day,
	onPick,
}: {
	days: readonly string[];
	day: string;
	onPick: (day: string) => void;
}) {
	const [year = 2000, month = 1] = day.split("-").map(Number);
	const [shown, setShown] = useState({ year, month });
	const recorded = useMemo(() => new Set(days), [days]);
	const cells = monthCells(shown.year, shown.month, recorded);
	const turn = (delta: number) =>
		setShown(({ year: y, month: m }) => {
			const next = new Date(y, m - 1 + delta, 1);
			return { year: next.getFullYear(), month: next.getMonth() + 1 };
		});
	const title = new Date(shown.year, shown.month - 1, 1).toLocaleDateString([], {
		month: "long",
		year: "numeric",
	});
	return (
		<div className="replay-calendar">
			<div className="replay-calendar-head">
				<button type="button" className="tool" aria-label="Previous month" onClick={() => turn(-1)}>
					<ChevronLeft size={16} />
				</button>
				<span>{title}</span>
				<button type="button" className="tool" aria-label="Next month" onClick={() => turn(1)}>
					<ChevronRight size={16} />
				</button>
			</div>
			<div className="replay-calendar-grid">
				{WEEKDAYS.map((name) => (
					<span key={name} className="replay-weekday">
						{name}
					</span>
				))}
				{cells.map((cell, i) =>
					cell ? (
						<button
							key={cell.day}
							type="button"
							className={cell.day === day ? "replay-date replay-date-on" : "replay-date"}
							disabled={!cell.recorded}
							onClick={() => onPick(cell.day)}
						>
							{cell.date}
						</button>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: blanks never move
						<span key={`blank-${i}`} />
					),
				)}
			</div>
		</div>
	);
}

function Timeline({
	spans,
	position,
	zoom,
	wide,
	onSeek,
}: {
	spans: readonly Span[];
	position: number;
	zoom: ZoomHours;
	wide: boolean;
	onSeek: (ms: number) => void;
}) {
	const bar = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	// A drag holds the window still, or the bar would slide away under the pointer.
	const frozen = useRef(timelineWindow(position, zoom));
	if (!dragging) frozen.current = timelineWindow(position, zoom);
	const window = frozen.current;

	const fractionAt = (event: ReactPointerEvent) => {
		const box = bar.current?.getBoundingClientRect();
		return box ? (event.clientX - box.left) / box.width : 0;
	};
	const bars = barsIn(spans, window);
	const head = fractionOf(hover ?? position, window);
	return (
		<div
			ref={bar}
			className="replay-timeline"
			role="slider"
			tabIndex={0}
			aria-label="Time of day"
			aria-valuemin={0}
			aria-valuemax={86400}
			aria-valuenow={Math.floor(position / 1000)}
			aria-valuetext={clockText(position)}
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				setDragging(true);
				setHover(msAt(fractionAt(event), window));
			}}
			onPointerMove={(event) => setHover(msAt(fractionAt(event), window))}
			onPointerUp={(event) => {
				setDragging(false);
				onSeek(msAt(fractionAt(event), window));
			}}
			onPointerCancel={() => setDragging(false)}
			onPointerLeave={() => {
				if (!dragging) setHover(null);
			}}
		>
			<div className="replay-track">
				{bars.map((item) => (
					<span
						key={item.left}
						className="replay-span"
						style={{ left: `${item.left * 100}%`, width: `${item.width * 100}%` }}
					/>
				))}
			</div>
			{ticksIn(window, wide).map((tick) => (
				<span key={tick.ms} className="replay-tick" style={{ left: `${tick.left * 100}%` }}>
					{tick.label}
				</span>
			))}
			<span className="replay-head" style={{ left: `${fractionOf(position, window) * 100}%` }} />
			{hover !== null && (
				<span className="replay-hover" style={{ left: `${head * 100}%` }}>
					{clockText(hover)}
				</span>
			)}
		</div>
	);
}

export function ReplayView({
	camera,
	cameras,
	onCamera,
	onClose,
}: {
	camera: CameraId;
	cameras: readonly PublicCamera[];
	onCamera: (camera: CameraId) => void;
	onClose: () => void;
}) {
	const video = useRef<HTMLVideoElement>(null);
	const player = useRef<ReplayPlayer | null>(null);
	const [days, setDays] = useState<readonly string[]>([]);
	const [day, setDay] = useState<string | null>(null);
	const [spans, setSpans] = useState<readonly Span[] | null>(null);
	/** Where the next connection starts. Null waits for the timeline to choose. */
	const [start, setStart] = useState<number | null>(null);
	const [position, setPosition] = useState(0);
	const [quality, setQuality] = useState<Quality>("main");
	const [rate, setRate] = useState<Rate>(1);
	const [state, setState] = useState<ReplayState>("opening");
	const [detail, setDetail] = useState<string | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [zoom, setZoom] = useState<ZoomHours>(24);
	const [attempt, setAttempt] = useState(0);
	const wide = useMedia("(min-width: 900px)");

	const here = cameras.findIndex((c) => c.id === camera);
	const name = cameras[here]?.name ?? "Camera";

	useEffect(() => {
		let live = true;
		api.replayDays(camera).then(
			(found) => {
				if (!live) return;
				setProblem(found.length === 0 ? "This recorder holds no footage." : null);
				setDays(found);
				setDay((current) =>
					current !== null && found.includes(current) ? current : (found.at(-1) ?? null),
				);
			},
			(error: unknown) => {
				if (live)
					setProblem(error instanceof Error ? error.message : "The recorder did not answer");
			},
		);
		return () => {
			live = false;
		};
	}, [camera]);

	useEffect(() => {
		if (day === null) return;
		let live = true;
		setSpans(null);
		api.replaySpans(camera, day).then(
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
	}, [camera, day]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how Try again reconnects
	useEffect(() => {
		const element = video.current;
		if (!element || day === null || start === null) return;
		setPosition(start);
		const next = new ReplayPlayer(element, {
			onState: (value, text) => {
				setState(value);
				setDetail(text ?? null);
			},
			onTime: setPosition,
		});
		player.current = next;
		next.start(camera, quality, day, start);
		return () => {
			next.stop();
			player.current = null;
		};
	}, [camera, quality, day, start, attempt]);

	useEffect(() => {
		player.current?.setRate(rate);
	}, [rate]);

	const seek = useCallback((ms: number) => player.current?.seek(clampDay(ms)), []);

	const toggle = useCallback(() => {
		const current = player.current;
		if (!current) return;
		// Footage from the last few seconds may have landed on the recorder since.
		if (state === "ended") current.seek(position);
		else current.setPaused(!current.paused);
	}, [state, position]);

	const changeDay = useCallback((next: string | null) => {
		if (next === null) return;
		setStart(null);
		setDay(next);
	}, []);

	/** The next connection opens here, unless the timeline has not chosen a spot yet. */
	const holdPosition = useCallback(
		() => setStart((current) => (current === null ? null : position)),
		[position],
	);

	/** Keeps the moment on screen, which is how you follow someone from camera to camera. */
	const stepCamera = useCallback(
		(delta: number) => {
			const next = cameras[(here + delta + cameras.length) % cameras.length];
			if (!next || next.id === camera) return;
			holdPosition();
			onCamera(next.id);
		},
		[cameras, here, camera, holdPosition, onCamera],
	);

	const changeQuality = () => {
		holdPosition();
		setQuality((value) => (value === "main" ? "sub" : "main"));
	};

	const snapshot = useCallback(() => {
		if (video.current) saveSnapshot({ video: video.current, name });
	}, [name]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)
			) {
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			switch (event.key) {
				case " ":
					toggle();
					break;
				case "ArrowLeft":
					seek(position - SKIP_MS);
					break;
				case "ArrowRight":
					seek(position + SKIP_MS);
					break;
				case "[":
					stepCamera(-1);
					break;
				case "]":
					stepCamera(1);
					break;
				case "s":
					snapshot();
					break;
				case "Escape":
					onClose();
					break;
				default:
					return;
			}
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle, seek, position, stepCamera, snapshot, onClose]);

	const note = problem ?? (state === "failed" ? (detail ?? STATE_NOTE.failed) : STATE_NOTE[state]);
	const paused = state === "paused" || state === "ended";

	return (
		<section className="replay" aria-label={`Recordings from ${name}`}>
			<div className="replay-picture">
				<video ref={video} muted playsInline aria-label={name} onClick={toggle} />
				{note && (
					<div
						className={
							state === "failed" || problem ? "picture-note picture-note-lost" : "picture-note"
						}
					>
						{note}
						{state === "failed" && !problem && (
							<button
								type="button"
								className="button button-quiet"
								onClick={() => {
									setStart(position);
									setAttempt((value) => value + 1);
								}}
							>
								Try again
							</button>
						)}
					</div>
				)}
				<div className="replay-stamp">
					<span>{name}</span>
					<time>
						{day ? dayText(day) : ""} {clockText(position)}
					</time>
				</div>
			</div>
			<Timeline spans={spans ?? []} position={position} zoom={zoom} wide={wide} onSeek={seek} />
			<div className="replay-bar">
				<span className="replay-group">
					<button
						type="button"
						className="tool"
						aria-label="Previous day"
						title="Previous day with footage"
						disabled={day === null || stepDay(days, day, -1) === null}
						onClick={() => day && changeDay(stepDay(days, day, -1))}
					>
						<ChevronLeft size={17} />
					</button>
					<Menu label="Pick a day" align="start" button={<CalendarDays size={17} />}>
						{(close) =>
							day && (
								<CalendarPanel
									days={days}
									day={day}
									onPick={(picked) => {
										close();
										changeDay(picked);
									}}
								/>
							)
						}
					</Menu>
					<button
						type="button"
						className="tool"
						aria-label="Next day"
						title="Next day with footage"
						disabled={day === null || stepDay(days, day, 1) === null}
						onClick={() => day && changeDay(stepDay(days, day, 1))}
					>
						<ChevronRight size={17} />
					</button>
				</span>
				<span className="replay-group replay-transport">
					<button
						type="button"
						className="tool"
						aria-label="Back 10 seconds"
						title="Back 10 seconds (Left)"
						onClick={() => seek(position - SKIP_MS)}
					>
						<RotateCcw size={17} />
					</button>
					<button
						type="button"
						className="replay-play"
						aria-label={paused ? "Play" : "Pause"}
						title="Play or pause (Space)"
						onClick={toggle}
					>
						{paused ? <Play size={20} /> : <Pause size={20} />}
					</button>
					<button
						type="button"
						className="tool"
						aria-label="Forward 10 seconds"
						title="Forward 10 seconds (Right)"
						onClick={() => seek(position + SKIP_MS)}
					>
						<RotateCw size={17} />
					</button>
				</span>
				<fieldset className="replay-group" aria-label="Playback speed">
					{REPLAY_RATES.map((value) => (
						<button
							key={value}
							type="button"
							className={value === rate ? "chip chip-on" : "chip"}
							onClick={() => setRate(value)}
						>
							{value}x
						</button>
					))}
				</fieldset>
				<fieldset className="replay-group" aria-label="Timeline zoom">
					{ZOOM_HOURS.map((hours) => (
						<button
							key={hours}
							type="button"
							className={hours === zoom ? "chip chip-on" : "chip"}
							onClick={() => setZoom(hours)}
						>
							{hours} h
						</button>
					))}
				</fieldset>
				<span className="topbar-gap" />
				<span className="replay-group">
					<button
						type="button"
						className="tool"
						aria-label="Previous camera, same moment"
						title="Previous camera, same moment ([)"
						onClick={() => stepCamera(-1)}
					>
						<SkipBack size={17} />
					</button>
					<select
						className="field replay-camera"
						aria-label="Camera"
						value={camera}
						onChange={(event) => {
							const next = cameras.find((c) => c.id === event.target.value);
							if (next) {
								holdPosition();
								onCamera(next.id);
							}
						}}
					>
						{cameras.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
					<button
						type="button"
						className="tool"
						aria-label="Next camera, same moment"
						title="Next camera, same moment (])"
						onClick={() => stepCamera(1)}
					>
						<SkipForward size={17} />
					</button>
				</span>
				<button
					type="button"
					className="chip"
					title="Picture quality"
					aria-label={`Picture quality: ${quality === "main" ? "HD" : "SD"}. Change it.`}
					onClick={changeQuality}
				>
					{quality === "main" ? "HD" : "SD"}
				</button>
				<button
					type="button"
					className="tool"
					aria-label="Save a snapshot"
					title="Save a snapshot (S)"
					onClick={snapshot}
				>
					<CameraIcon size={17} />
				</button>
				<button
					type="button"
					className="tool"
					aria-label="Back to live"
					title="Back to live (Esc)"
					onClick={onClose}
				>
					<X size={17} />
				</button>
			</div>
		</section>
	);
}
