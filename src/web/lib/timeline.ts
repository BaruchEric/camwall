import { DAY_MS, type Span } from "@/shared/schema";

export const SKIP_MS = 10_000;
/** A replay opens this far before the newest footage, on the bet that it just happened. */
export const OPEN_BEFORE_END_MS = 60_000;
export const ZOOM_HOURS = [24, 6, 1] as const;
export type ZoomHours = (typeof ZOOM_HOURS)[number];

const HOUR_MS = 3_600_000;

const pad = (value: number) => String(value).padStart(2, "0");

export function clockText(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export function dayText(day: string): string {
	const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
	return new Date(year, month - 1, date).toLocaleDateString([], {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function clampDay(ms: number): number {
	return Math.min(DAY_MS - 1, Math.max(0, Math.round(ms)));
}

/** Where a replay of this day opens: just before the newest footage, or midnight if none. */
export function openingMs(spans: readonly Span[]): number {
	const last = spans.at(-1);
	if (!last) return 0;
	return Math.max(last[0], last[1] - OPEN_BEFORE_END_MS);
}

export type TimelineWindow = { start: number; end: number };

/** The stretch of the day on show: all of it, or `hours` around the playhead. */
export function timelineWindow(position: number, hours: ZoomHours): TimelineWindow {
	const size = hours * HOUR_MS;
	const start = Math.min(DAY_MS - size, Math.max(0, position - size / 2));
	return { start, end: start + size };
}

export function msAt(fraction: number, { start, end }: TimelineWindow): number {
	return clampDay(start + Math.min(1, Math.max(0, fraction)) * (end - start));
}

export function fractionOf(ms: number, { start, end }: TimelineWindow): number {
	return (ms - start) / (end - start);
}

export type Bar = { left: number; width: number };

/** The recorded stretches that fall inside the window, as fractions of its width. */
export function barsIn(spans: readonly Span[], window: TimelineWindow): Bar[] {
	return spans.flatMap(([from, to]) => {
		const start = Math.max(from, window.start);
		const end = Math.min(to, window.end);
		if (end <= start) return [];
		const left = fractionOf(start, window);
		return [{ left, width: fractionOf(end, window) - left }];
	});
}

export type Tick = { ms: number; left: number; label: string };

/** Hour marks for a wide window, quarter hours for a narrow one. */
export function ticksIn(window: TimelineWindow, wide: boolean): Tick[] {
	const span = window.end - window.start;
	const step = span > 6 * HOUR_MS ? (wide ? 2 : 4) * HOUR_MS : span > HOUR_MS ? HOUR_MS : 900_000;
	const ticks: Tick[] = [];
	for (let ms = Math.ceil(window.start / step) * step; ms <= window.end; ms += step) {
		ticks.push({ ms, left: fractionOf(ms, window), label: clockText(ms).slice(0, 5) });
	}
	return ticks;
}

export type MonthCell = { day: string; date: number; recorded: boolean } | null;

/** A month as calendar rows, Sunday first, with blanks around it. */
export function monthCells(year: number, month: number, days: ReadonlySet<string>): MonthCell[] {
	const first = new Date(year, month - 1, 1).getDay();
	const length = new Date(year, month, 0).getDate();
	const cells: MonthCell[] = Array.from({ length: first }, () => null);
	for (let date = 1; date <= length; date++) {
		const day = `${year}-${pad(month)}-${pad(date)}`;
		cells.push({ day, date, recorded: days.has(day) });
	}
	return cells;
}

/** The day before or after this one that holds footage. */
export function stepDay(days: readonly string[], day: string, delta: 1 | -1): string | null {
	const later = days.filter((candidate) => candidate > day);
	const earlier = days.filter((candidate) => candidate < day);
	return (delta > 0 ? later[0] : earlier.at(-1)) ?? null;
}

/**
 * Where to jump when the playhead reaches a gap in the buffer, or null to stay. `margin` is how
 * close to a stretch's end counts as the end. A decoder holds back its last few frames until
 * more arrive, so a stalled player stops short of the end and needs a wider margin.
 */
export function nextRange(
	ranges: readonly (readonly [number, number])[],
	time: number,
	margin = 0.1,
): number | null {
	const inside = ranges.some(([start, end]) => time >= start - 0.05 && time < end - margin);
	if (inside) return null;
	return ranges.find(([start]) => start > time)?.[0] ?? null;
}
