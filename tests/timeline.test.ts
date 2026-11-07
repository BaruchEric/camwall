import { describe, expect, test } from "bun:test";
import type { Span } from "@/shared/schema";
import {
	barsIn,
	clockText,
	fractionOf,
	momentText,
	monthCells,
	msAt,
	nextRange,
	openingMs,
	parseMoment,
	stepDay,
	ticksIn,
	timelineWindow,
} from "@/web/lib/timeline";

const DAY = 86_400_000;

describe("clock", () => {
	test("reads as hours, minutes and seconds", () => {
		expect(clockText(36_240_000)).toBe("10:04:00");
		expect(clockText(DAY - 1)).toBe("23:59:59");
	});
});

describe("opening spot", () => {
	test("sits a minute before the newest footage", () => {
		const spans: Span[] = [
			[0, 60_000],
			[600_000, 780_000],
		];
		expect(openingMs(spans)).toBe(720_000);
	});

	test("stays inside a short last recording", () => {
		expect(openingMs([[600_000, 620_000]])).toBe(600_000);
	});

	test("is midnight on a day with nothing", () => {
		expect(openingMs([])).toBe(0);
	});
});

describe("window", () => {
	test("24 hours shows the whole day wherever the playhead is", () => {
		expect(timelineWindow(5_000_000, 24)).toEqual({ start: 0, end: DAY });
	});

	test("a zoomed window centres on the playhead and stops at the day's edges", () => {
		expect(timelineWindow(36_000_000, 1)).toEqual({ start: 34_200_000, end: 37_800_000 });
		expect(timelineWindow(0, 1).start).toBe(0);
		expect(timelineWindow(DAY, 1).end).toBe(DAY);
	});

	test("a pointer position maps to a time and back", () => {
		const window = timelineWindow(36_000_000, 1);
		expect(msAt(0.5, window)).toBe(36_000_000);
		expect(fractionOf(36_000_000, window)).toBe(0.5);
		expect(msAt(2, { start: 0, end: DAY })).toBe(DAY - 1);
	});

	test("bars are cut to the window and the rest are dropped", () => {
		const window = { start: 1000, end: 2000 };
		const bars = barsIn(
			[
				[0, 500],
				[800, 1500],
				[1900, 5000],
			],
			window,
		);
		expect(bars).toHaveLength(2);
		expect(bars[0]).toEqual({ left: 0, width: 0.5 });
		expect(bars[1]?.left).toBeCloseTo(0.9);
		expect(bars[1]?.width).toBeCloseTo(0.1);
	});

	test("ticks get finer as the window narrows", () => {
		expect(ticksIn({ start: 0, end: DAY }, true)).toHaveLength(13);
		expect(ticksIn({ start: 0, end: DAY }, false)).toHaveLength(7);
		expect(ticksIn({ start: 0, end: 3_600_000 }, true).map((t) => t.label)).toEqual([
			"00:00",
			"00:15",
			"00:30",
			"00:45",
			"01:00",
		]);
	});
});

describe("calendar", () => {
	test("a month starts under its weekday and marks recorded days", () => {
		const cells = monthCells(2026, 11, new Set(["2026-11-06"]));
		expect(cells[0]?.date).toBe(1);
		expect(cells).toHaveLength(30);
		expect(cells[5]).toEqual({ day: "2026-11-06", date: 6, recorded: true });
		expect(monthCells(2026, 10, new Set())[3]).toBeNull();
	});

	test("day steps skip days with no footage and stop at the ends", () => {
		const days = ["2026-10-30", "2026-11-02", "2026-11-03"];
		expect(stepDay(days, "2026-11-02", -1)).toBe("2026-10-30");
		expect(stepDay(days, "2026-10-30", 1)).toBe("2026-11-02");
		expect(stepDay(days, "2026-11-03", 1)).toBeNull();
	});
});

describe("gaps in the buffer", () => {
	const ranges = [
		[10, 20],
		[50, 60],
	] as const;

	test("nothing happens inside a range", () => {
		expect(nextRange(ranges, 15)).toBeNull();
	});

	test("the end of a range leads to the next one", () => {
		expect(nextRange(ranges, 19.95)).toBe(50);
		expect(nextRange(ranges, 30)).toBe(50);
	});

	test("a stalled player stops short of the end, and still gets across", () => {
		expect(nextRange(ranges, 19.6)).toBeNull();
		expect(nextRange(ranges, 19.6, 1)).toBe(50);
	});

	test("the end of the last range goes nowhere", () => {
		expect(nextRange(ranges, 59.95)).toBeNull();
	});
});

describe("moment links", () => {
	test("go there and back", () => {
		const moment = { day: "2026-11-07", ms: 51_022_000 };
		expect(momentText(moment)).toBe("2026-11-07T14:10:22");
		expect(parseMoment(momentText(moment))).toEqual(moment);
	});

	test("refuse anything that is not a time of day", () => {
		for (const junk of [
			null,
			"",
			"2026-11-07",
			"2026-11-07T24:00:00",
			"2026-11-07T14:60:00",
			"2026-02-30T10:00:00",
			"x",
		]) {
			expect(parseMoment(junk)).toBeNull();
		}
	});
});
