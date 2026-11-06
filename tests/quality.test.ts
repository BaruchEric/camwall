import { describe, expect, test } from "bun:test";
import { pickQuality, type TileSize } from "@/shared/quality";

const tile = (key: number, deviceWidth: number, choice: TileSize["choice"] = "auto"): TileSize => ({
	key,
	deviceWidth,
	choice,
});

describe("pickQuality", () => {
	test("small tiles stay on the small stream", () => {
		const result = pickQuality([tile(0, 400), tile(1, 400)]);
		expect([...result.values()]).toEqual(["sub", "sub"]);
	});

	test("four large tiles all get the big stream", () => {
		const result = pickQuality([0, 1, 2, 3].map((key) => tile(key, 900)));
		expect([...result.values()].every((q) => q === "main")).toBe(true);
	});

	test("nine equal tiles over the cap all stay small rather than mixing", () => {
		const result = pickQuality(Array.from({ length: 9 }, (_, key) => tile(key, 900)));
		expect([...result.values()].every((q) => q === "sub")).toBe(true);
	});

	test("the largest tile wins when the rest would break the cap", () => {
		const others = [1, 2, 3, 4, 5].map((key) => tile(key, 850));
		const result = pickQuality([tile(0, 1800), ...others]);
		expect(result.get(0)).toBe("main");
		expect(result.get(1)).toBe("sub");
	});

	test("a forced HD tile counts against the cap", () => {
		const auto = [1, 2, 3, 4].map((key) => tile(key, 900));
		const result = pickQuality([tile(0, 100, "main"), ...auto]);
		expect(result.get(0)).toBe("main");
		expect(result.get(1)).toBe("sub");
	});

	test("a forced SD tile stays small however large it is", () => {
		expect(pickQuality([tile(0, 3000, "sub")]).get(0)).toBe("sub");
	});
});
