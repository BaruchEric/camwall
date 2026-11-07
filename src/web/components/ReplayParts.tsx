import {
	CalendarDays,
	Camera as CameraIcon,
	ChevronLeft,
	ChevronRight,
	Pause,
	Play,
	RotateCcw,
	RotateCw,
	X,
} from "lucide-react";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { REPLAY_RATES, type Span } from "@/shared/schema";
import { Menu } from "@/web/components/ui";
import type { Playback } from "@/web/lib/playback";
import {
	barsIn,
	clockText,
	dayText,
	fractionOf,
	monthCells,
	msAt,
	SKIP_MS,
	stepDay,
	ticksIn,
	timelineWindow,
	ZOOM_HOURS,
	type ZoomHours,
} from "@/web/lib/timeline";

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

export function Timeline({
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

/** The notice over a picture or a wall: a wait, or a failure with a way to try again. */
export function PlaybackNote({ playback }: { playback: Playback }) {
	if (!playback.note) return null;
	return (
		<div className={playback.failed ? "picture-note picture-note-lost" : "picture-note"}>
			{playback.note}
			{playback.canRetry && (
				<button type="button" className="button button-quiet" onClick={playback.retry}>
					Try again
				</button>
			)}
		</div>
	);
}

/** The controls under playback: day, transport, speed and zoom, then whatever the view adds. */
export function ReplayBar({
	playback,
	zoom,
	onZoom,
	quality,
	onQuality,
	clock,
	onSnapshot,
	closeLabel,
	onClose,
	children,
}: {
	playback: Playback;
	zoom: ZoomHours;
	onZoom: (zoom: ZoomHours) => void;
	/** What the picture quality chip says, and what pressing it does. */
	quality: string;
	onQuality: () => void;
	/** Shows the day and time in the bar, for a view with no stamp on its picture. */
	clock: boolean;
	onSnapshot: (() => void) | null;
	closeLabel: string;
	onClose: () => void;
	children?: ReactNode;
}) {
	const { day, days, position, paused } = playback;
	return (
		<div className="replay-bar">
			<span className="replay-group">
				<button
					type="button"
					className="tool"
					aria-label="Previous day"
					title="Previous day with footage"
					disabled={day === null || stepDay(days, day, -1) === null}
					onClick={() => day && playback.changeDay(stepDay(days, day, -1))}
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
									playback.changeDay(picked);
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
					onClick={() => day && playback.changeDay(stepDay(days, day, 1))}
				>
					<ChevronRight size={17} />
				</button>
			</span>
			{clock && (
				<time className="replay-clock">
					{day ? dayText(day) : ""} {clockText(position)}
				</time>
			)}
			<span className="replay-group replay-transport">
				<button
					type="button"
					className="tool"
					aria-label="Back 10 seconds"
					title="Back 10 seconds (Left)"
					onClick={() => playback.seek(position - SKIP_MS)}
				>
					<RotateCcw size={17} />
				</button>
				<button
					type="button"
					className="replay-play"
					aria-label={paused ? "Play" : "Pause"}
					title="Play or pause (Space)"
					onClick={playback.toggle}
				>
					{paused ? <Play size={20} /> : <Pause size={20} />}
				</button>
				<button
					type="button"
					className="tool"
					aria-label="Forward 10 seconds"
					title="Forward 10 seconds (Right)"
					onClick={() => playback.seek(position + SKIP_MS)}
				>
					<RotateCw size={17} />
				</button>
			</span>
			<fieldset className="replay-group" aria-label="Playback speed">
				{REPLAY_RATES.map((value) => (
					<button
						key={value}
						type="button"
						className={value === playback.rate ? "chip chip-on" : "chip"}
						onClick={() => playback.setRate(value)}
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
						onClick={() => onZoom(hours)}
					>
						{hours} h
					</button>
				))}
			</fieldset>
			<span className="topbar-gap" />
			{children}
			<button
				type="button"
				className="chip"
				title="Picture quality"
				aria-label={`Picture quality: ${quality}. Change it.`}
				onClick={onQuality}
			>
				{quality}
			</button>
			{onSnapshot && (
				<button
					type="button"
					className="tool"
					aria-label="Save a snapshot"
					title="Save a snapshot (S)"
					onClick={onSnapshot}
				>
					<CameraIcon size={17} />
				</button>
			)}
			<button
				type="button"
				className="tool"
				aria-label={closeLabel}
				title={`${closeLabel} (Esc)`}
				onClick={onClose}
			>
				<X size={17} />
			</button>
		</div>
	);
}

/** Space, Left, Right, S and Esc, plus whatever else the view hands in. */
export function usePlaybackKeys(
	playback: Playback,
	keys: Record<string, (() => void) | undefined>,
): void {
	const { toggle, seek, position } = playback;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
			// A menu or a dialog on top owns the keys, Space included.
			if (typing || document.querySelector("dialog[open], .ctx")) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const run = keys[event.key];
			if (run) run();
			else if (event.key === " ") toggle();
			else if (event.key === "ArrowLeft") seek(position - SKIP_MS);
			else if (event.key === "ArrowRight") seek(position + SKIP_MS);
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [toggle, seek, position, keys]);
}
