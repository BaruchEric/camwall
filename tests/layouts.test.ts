import { describe, expect, test } from "bun:test";
import { autoGrid, type FixedLayoutId, fitColumns, LAYOUT_IDS, LAYOUTS } from "@/shared/layouts";

const box = { width: 1600, height: 900, ratio: 16 / 9, gap: 3, chrome: 26 };

describe("fixed layouts", () => {
	test.each([...LAYOUT_IDS])("%s covers its grid exactly once", (id: FixedLayoutId) => {
		const { cols, rows, cells } = LAYOUTS[id];
		const hits = new Map<string, number>();
		for (const cell of cells) {
			for (let x = cell.x; x < cell.x + cell.w; x++) {
				for (let y = cell.y; y < cell.y + cell.h; y++) {
					hits.set(`${x},${y}`, (hits.get(`${x},${y}`) ?? 0) + 1);
				}
			}
		}
		expect(hits.size).toBe(cols * rows);
		expect([...hits.values()].every((count) => count === 1)).toBe(true);
	});

	test.each([...LAYOUT_IDS])("%s has as many tiles as its name says", (id: FixedLayoutId) => {
		expect(LAYOUTS[id].cells.length).toBe(Number(id));
	});

	test("the large tile comes first, so it gets the first camera", () => {
		expect(LAYOUTS["6"].cells[0]).toEqual({ x: 0, y: 0, w: 2, h: 2 });
		expect(LAYOUTS["13"].cells[0]).toEqual({ x: 1, y: 1, w: 2, h: 2 });
	});
});

describe("fit", () => {
	test("a wide window spreads cameras across", () => {
		expect(fitColumns({ ...box, count: 2 })).toBe(2);
	});

	test("a tall window stacks them", () => {
		expect(fitColumns({ ...box, width: 500, height: 1000, count: 2 })).toBe(1);
	});

	test("28 cameras on a 16:9 window use 6 or 7 columns", () => {
		expect([6, 7]).toContain(fitColumns({ ...box, count: 28 }));
	});

	test("autoGrid makes one cell per camera", () => {
		expect(autoGrid({ ...box, count: 7 }).cells.length).toBe(7);
	});

	test("autoGrid survives no cameras", () => {
		expect(autoGrid({ ...box, count: 0 }).cells.length).toBe(1);
	});
});
