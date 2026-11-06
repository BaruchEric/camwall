export type Cell = { x: number; y: number; w: number; h: number };

export type GridSpec = { cols: number; rows: number; cells: Cell[] };

/** Fixed arrangements. "auto" is separate: it sizes itself to the cameras and the window. */
export const LAYOUT_IDS = ["1", "2", "4", "6", "8", "9", "10", "13", "16", "25"] as const;
export type FixedLayoutId = (typeof LAYOUT_IDS)[number];
export type LayoutId = FixedLayoutId | "auto";

function even(cols: number, rows: number): GridSpec {
	const cells: Cell[] = [];
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) cells.push({ x, y, w: 1, h: 1 });
	}
	return { cols, rows, cells };
}

/** Large cells first, then every grid square they leave free, in reading order. */
function featured(cols: number, rows: number, large: Cell[]): GridSpec {
	const taken = (x: number, y: number) =>
		large.some((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
	const rest = even(cols, rows).cells.filter((c) => !taken(c.x, c.y));
	return { cols, rows, cells: [...large, ...rest] };
}

export const LAYOUTS: Record<FixedLayoutId, GridSpec> = {
	"1": even(1, 1),
	"2": even(2, 1),
	"4": even(2, 2),
	"6": featured(3, 3, [{ x: 0, y: 0, w: 2, h: 2 }]),
	"8": featured(4, 4, [{ x: 0, y: 0, w: 3, h: 3 }]),
	"9": even(3, 3),
	"10": featured(4, 4, [
		{ x: 0, y: 0, w: 2, h: 2 },
		{ x: 2, y: 0, w: 2, h: 2 },
	]),
	"13": featured(4, 4, [{ x: 1, y: 1, w: 2, h: 2 }]),
	"16": even(4, 4),
	"25": even(5, 5),
};

export const LAYOUT_LABELS: Record<FixedLayoutId, string> = {
	"1": "Single",
	"2": "Side by side",
	"4": "2 by 2",
	"6": "1 large, 5 small",
	"8": "1 large, 7 small",
	"9": "3 by 3",
	"10": "2 large, 8 small",
	"13": "1 centered, 12 around",
	"16": "4 by 4",
	"25": "5 by 5",
};

export type FitInput = {
	count: number;
	width: number;
	height: number;
	ratio: number;
	gap: number;
	/** Height each tile spends on its label strip, which the picture does not get. */
	chrome: number;
};

/** Picks the column count that makes tiles largest inside the given box. */
export function fitColumns({ count, width, height, ratio, gap, chrome }: FitInput): number {
	let best = 1;
	let bestWidth = 0;
	for (let cols = 1; cols <= Math.max(count, 1); cols++) {
		const rows = Math.ceil(count / cols);
		const byWidth = (width - gap * (cols - 1)) / cols;
		const byHeight = ((height - gap * (rows - 1)) / rows - chrome) * ratio;
		const tile = Math.min(byWidth, byHeight);
		if (tile > bestWidth) {
			bestWidth = tile;
			best = cols;
		}
	}
	return best;
}

export function autoGrid(input: FitInput): GridSpec {
	const cols = fitColumns(input);
	const rows = Math.max(1, Math.ceil(input.count / cols));
	const cells = even(cols, rows).cells.slice(0, Math.max(input.count, 1));
	return { cols, rows, cells };
}
