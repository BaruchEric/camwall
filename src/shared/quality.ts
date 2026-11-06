import type { Quality } from "@/shared/schema";

export type QualityChoice = "auto" | Quality;

export type TileSize = { key: number; deviceWidth: number; choice: QualityChoice };

/** Below this width the small stream, scaled up, looks the same as the big one. */
export const MAIN_MIN_WIDTH = 800;
/** Each big stream costs about nine small ones, in bandwidth and in browser decoders. */
export const MAIN_CAP = 4;

/**
 * Gives the big stream to the largest tiles. A tie at the cap goes to nobody, so tiles
 * of the same size never show two different sharpnesses side by side.
 */
export function pickQuality(tiles: readonly TileSize[]): Map<number, Quality> {
	const result = new Map<number, Quality>();
	let used = 0;
	for (const tile of tiles) {
		if (tile.choice !== "auto") {
			result.set(tile.key, tile.choice);
			if (tile.choice === "main") used++;
		}
	}
	const candidates = tiles
		.filter((t) => t.choice === "auto" && t.deviceWidth >= MAIN_MIN_WIDTH)
		.toSorted((a, b) => b.deviceWidth - a.deviceWidth);
	const widths = [...new Set(candidates.map((t) => t.deviceWidth))];
	for (const width of widths) {
		const tied = candidates.filter((t) => t.deviceWidth === width);
		if (used + tied.length > MAIN_CAP) break;
		for (const tile of tied) result.set(tile.key, "main");
		used += tied.length;
	}
	for (const tile of tiles) {
		if (!result.has(tile.key)) result.set(tile.key, "sub");
	}
	return result;
}
