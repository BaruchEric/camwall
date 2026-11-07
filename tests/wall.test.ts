import { describe, expect, test } from "bun:test";
import { AppState, CameraId } from "@/shared/schema";
import {
	allRefs,
	initialWall,
	pageCount,
	parseSource,
	parseTarget,
	refKey,
	wallReducer,
} from "@/web/lib/wall";

const state = AppState.parse({
	recorders: [],
	cameras: ["a", "b", "c", "d", "e"].map((id, i) => ({
		id,
		name: id.toUpperCase(),
		groupId: i < 2 ? "front" : null,
		hasSub: true,
		hasReplay: false,
	})),
	groups: [{ id: "front", name: "Front" }],
	views: [{ id: "pair", name: "Pair", layout: "2", slots: ["c", "d"] }],
});

const id = (value: string) => CameraId.parse(value);

describe("views", () => {
	test("refs run all, groups, ungrouped, saved", () => {
		expect(allRefs(state).map(refKey)).toEqual(["all", "group:front", "ungrouped", "view:pair"]);
	});

	test("a group wall holds only its cameras", () => {
		const wall = initialWall({ kind: "group", id: state.groups[0]?.id ?? never() }, state);
		expect(wall.slots).toEqual([id("a"), id("b")]);
	});

	test("a view that no longer exists falls back to all cameras", () => {
		const gone = AppState.parse({ ...state, views: [] });
		const ref = { kind: "saved", id: state.views[0]?.id ?? never() } as const;
		expect(initialWall(ref, gone).ref).toEqual({ kind: "all" });
	});
});

function never(): never {
	throw new Error("fixture is missing an entry");
}

describe("pages", () => {
	const wall = wallReducer(initialWall({ kind: "all" }, state), { type: "layout", layout: "2" });

	test("extra cameras spill onto more pages", () => {
		expect(pageCount(wall)).toBe(3);
	});

	test("paging wraps both ways", () => {
		expect(wallReducer(wall, { type: "page", page: -1 }).page).toBe(2);
		expect(wallReducer(wall, { type: "page", page: 3 }).page).toBe(0);
	});

	test("auto keeps everything on one page", () => {
		expect(pageCount(initialWall({ kind: "all" }, state))).toBe(1);
	});
});

describe("edits", () => {
	const wall = initialWall({ kind: "all" }, state);

	test("assign replaces one slot and marks the wall edited", () => {
		const next = wallReducer(wall, { type: "assign", index: 1, camera: id("e") });
		expect(next.slots[1]).toBe(id("e"));
		expect(next.edited).toBe(true);
	});

	test("assign past the end grows the list with gaps", () => {
		const next = wallReducer(wall, { type: "assign", index: 7, camera: id("a") });
		expect(next.slots.length).toBe(8);
		expect(next.slots[6]).toBe(null);
	});

	test("swap trades two tiles", () => {
		const next = wallReducer(wall, { type: "swap", a: 0, b: 4 });
		expect(next.slots[0]).toBe(id("e"));
		expect(next.slots[4]).toBe(id("a"));
	});

	test("a removed camera leaves an edited wall as a gap", () => {
		const edited = wallReducer(wall, { type: "layout", layout: "4" });
		const smaller = AppState.parse({ ...state, cameras: state.cameras.slice(1) });
		expect(wallReducer(edited, { type: "sync", state: smaller }).slots[0]).toBe(null);
	});

	test("an untouched wall follows the camera list", () => {
		const smaller = AppState.parse({ ...state, cameras: state.cameras.slice(1) });
		expect(wallReducer(wall, { type: "sync", state: smaller }).slots.length).toBe(4);
	});

	test("full view closes when its camera goes away", () => {
		const focused = wallReducer(wall, { type: "focus", camera: id("a") });
		const smaller = AppState.parse({ ...state, cameras: state.cameras.slice(1) });
		expect(wallReducer(focused, { type: "sync", state: smaller }).focused).toBe(null);
	});
});

describe("drag ids", () => {
	test("read back what the components write", () => {
		expect(parseSource("camera:front-door")).toEqual({ kind: "camera", camera: id("front-door") });
		expect(parseSource("tile:3")).toEqual({ kind: "tile", index: 3 });
		expect(parseTarget("tile:0")).toEqual({ kind: "tile", index: 0 });
		expect(parseTarget("ungrouped")).toEqual({ kind: "group", group: null });
	});

	test("refuse anything else", () => {
		expect(parseSource("tile:x")).toBe(null);
		expect(parseSource("camera:NOT VALID")).toBe(null);
		expect(parseTarget("something")).toBe(null);
	});
});
