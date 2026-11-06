import { describe, expect, test } from "bun:test";
import { AppState, CameraId, GroupId, ViewId } from "@/shared/schema";
import {
	buildMenu,
	foundMenu,
	type MenuCommands,
	type MenuContext,
	type MenuNode,
	type MenuSub,
	type MenuTiles,
	type TileCell,
} from "@/web/lib/menus";
import type { PlayerState } from "@/web/lib/player";
import {
	FULL_TILE,
	fillers,
	initialWall,
	type MenuTarget,
	menuId,
	neighbour,
	parseMenuTarget,
	type WallAction,
	type WallState,
	wallReducer,
} from "@/web/lib/wall";

const id = (value: string) => CameraId.parse(value);

const state = AppState.parse({
	cameras: ["a", "b", "c", "d", "e"].map((name, i) => ({
		id: name,
		name: name.toUpperCase(),
		groupId: i < 2 ? "front" : null,
		hasSub: name !== "c",
	})),
	groups: [
		{ id: "front", name: "Front" },
		{ id: "back", name: "Back" },
	],
	views: [
		{ id: "pair", name: "Pair", layout: "2", slots: ["c", "d"] },
		{ id: "quad", name: "Quad", layout: "4", slots: ["a", "b"] },
	],
});

function wallOf(patch: Partial<WallState> = {}): WallState {
	return { ...initialWall({ kind: "all" }, state), ...patch };
}

const grid: TileCell[] = [
	{ index: 0, x: 0, y: 0, w: 0.5, h: 1, camera: id("a") },
	{ index: 1, x: 0.5, y: 0, w: 0.25, h: 0.5, camera: id("b") },
	{ index: 2, x: 0.75, y: 0, w: 0.25, h: 0.5, camera: null },
];

type Harness = { ctx: MenuContext; actions: WallAction[]; commits: AppState[]; calls: string[] };

function harness(patch: Partial<MenuContext> = {}): Harness {
	const actions: WallAction[] = [];
	const commits: AppState[] = [];
	const calls: string[] = [];
	const note = (name: string) => () => {
		calls.push(name);
	};
	const run: MenuCommands = {
		dispatch: (action) => actions.push(action),
		commit: (next) => commits.push(next),
		open: note("open"),
		removeCamera: (camera) => calls.push(`remove ${camera}`),
		snapshot: note("snapshot"),
		copySnapshot: note("copySnapshot"),
		popOut: note("popOut"),
		reconnect: (cameras) => calls.push(`reconnect ${cameras.join()}`),
		choose: (camera, choice) => calls.push(`choose ${camera} ${choice}`),
		save: note("save"),
		saveAs: note("saveAs"),
		revert: note("revert"),
		toggleFit: note("toggleFit"),
		toggleTour: note("toggleTour"),
		tourEvery: note("tourEvery"),
		toggleRail: note("toggleRail"),
		toggleFullscreen: note("toggleFullscreen"),
		help: note("help"),
		addCameras: note("addCameras"),
		settings: note("settings"),
		copyLink: note("copyLink"),
		collapse: (keys) => calls.push(`collapse ${keys.join()}`),
	};
	return {
		actions,
		commits,
		calls,
		ctx: {
			state,
			wall: wallOf(),
			statuses: new Map(),
			choices: new Map(),
			pages: 1,
			fit: "fit",
			tour: false,
			tourSeconds: 15,
			railVisible: true,
			fullscreen: false,
			collapsed: new Set(),
			cells: grid,
			ratio: 16 / 9,
			can: { copyImage: true, popOut: true },
			hasFrame: () => true,
			rate: () => "HD 2.1 Mb/s",
			run,
			...patch,
		},
	};
}

function labels(nodes: readonly MenuNode[]): string[] {
	return nodes.flatMap((node) => ("label" in node ? [node.label] : []));
}

function find(nodes: readonly MenuNode[], label: string): MenuNode {
	const node = nodes.find((item) => "label" in item && item.label === label);
	if (!node) throw new Error(`No "${label}" in ${labels(nodes).join(", ")}`);
	return node;
}

function press(nodes: readonly MenuNode[], label: string): void {
	const node = find(nodes, label);
	if (node.kind !== "action") throw new Error(`"${label}" is a ${node.kind}`);
	node.run();
}

function sub(nodes: readonly MenuNode[], label: string): MenuSub {
	const node = find(nodes, label);
	if (node.kind !== "sub") throw new Error(`"${label}" is a ${node.kind}`);
	return node;
}

function tiles(nodes: readonly MenuNode[]): MenuTiles {
	const node = nodes.find((item) => item.kind === "tiles");
	if (node?.kind !== "tiles") throw new Error("No tile map");
	return node;
}

const tile = (index: number): MenuTarget => ({ kind: "tile", index });
const camera = (value: string): MenuTarget => ({ kind: "camera", camera: id(value) });

describe("menu targets", () => {
	test("every id parses back to what it named", () => {
		const front = GroupId.parse("front");
		const pair = { kind: "saved", id: ViewId.parse("pair") } as const;
		expect(parseMenuTarget(menuId.tile(3))).toEqual({ kind: "tile", index: 3 });
		expect(parseMenuTarget(menuId.tile(FULL_TILE))).toEqual({ kind: "tile", index: FULL_TILE });
		expect(parseMenuTarget(menuId.camera(id("a")))).toEqual({ kind: "camera", camera: id("a") });
		expect(parseMenuTarget(menuId.group(front))).toEqual({ kind: "group", group: front });
		expect(parseMenuTarget(menuId.group(null))).toEqual({ kind: "group", group: null });
		expect(parseMenuTarget(menuId.view(pair))).toEqual({ kind: "view", ref: pair });
		expect(parseMenuTarget(menuId.view({ kind: "all" }))).toEqual({
			kind: "view",
			ref: { kind: "all" },
		});
		expect(parseMenuTarget(menuId.wall)).toEqual({ kind: "wall" });
	});

	test("junk names nothing", () => {
		for (const junk of ["", "tile:x", "tile:-2", "camera:UPPER", "view:", "group:a b", "nope"]) {
			expect(parseMenuTarget(junk)).toBeNull();
		}
	});
});

describe("wall actions the menus use", () => {
	const clearing = (wall: WallState, index: number) =>
		wallReducer(wall, { type: "assign", index, camera: null });

	test("add fills an empty tile before growing the wall", () => {
		const wall = wallReducer(clearing(wallOf(), 1), { type: "add", cameras: [id("e")] });
		expect(wall.slots[1]).toBe(id("e"));
		expect(wall.slots).toHaveLength(5);
		expect(wall.selected).toBe(1);
	});

	test("add turns to the page the camera landed on", () => {
		const wall = wallReducer(wallOf({ layout: "2", slots: [id("a"), id("b")] }), {
			type: "add",
			cameras: [id("c")],
		});
		expect(wall.page).toBe(1);
		expect(wall.selected).toBe(2);
	});

	test("reveal leaves full view and turns to the tile's page", () => {
		const wall = wallReducer(wallOf({ layout: "2", focused: id("a") }), {
			type: "reveal",
			index: 3,
		});
		expect(wall).toMatchObject({ page: 1, selected: 3, focused: null });
	});

	test("tidy closes the gaps and keeps the page valid", () => {
		const wall = wallReducer(
			wallOf({ layout: "2", slots: [id("a"), null, null, id("d")], page: 1 }),
			{ type: "tidy" },
		);
		expect(wall.slots).toEqual([id("a"), id("d")]);
		expect(wall.page).toBe(0);
	});

	test("fillers offer only what fits without a new page", () => {
		const auto = clearing(wallOf(), 0);
		expect(fillers({ ...auto, slots: auto.slots }, state)).toEqual([id("a")]);
		const fixed = wallOf({ layout: "4", slots: [id("a")] });
		expect(fillers(fixed, state)).toEqual([id("b"), id("c"), id("d")]);
		expect(fillers(wallOf(), state)).toEqual([]);
	});

	test("neighbour wraps round the wall", () => {
		const wall = wallOf({ focused: id("e") });
		expect(neighbour(wall, 1)).toBe(id("a"));
		expect(neighbour(wall, -1)).toBe(id("d"));
	});
});

describe("tile menu", () => {
	test("the head reports the tile's live rate", () => {
		const { ctx } = harness({ statuses: new Map<CameraId, PlayerState>([[id("a"), "live"]]) });
		expect(buildMenu(tile(0), ctx).head).toEqual({
			name: "A",
			info: "HD 2.1 Mb/s",
			state: "live",
		});
	});

	test("a lost camera leads with reconnecting", () => {
		const { ctx, calls } = harness({
			statuses: new Map<CameraId, PlayerState>([[id("a"), "retrying"]]),
		});
		const menu = buildMenu(tile(0), ctx);
		expect(labels(menu.nodes)[0]).toBe("Reconnect now");
		press(menu.nodes, "Reconnect now");
		expect(calls).toEqual(["reconnect a"]);
		expect(labels(buildMenu(tile(1), ctx).nodes)).not.toContain("Reconnect now");
	});

	test("snapshots wait for a picture", () => {
		const { ctx } = harness({ hasFrame: () => false });
		const save = find(buildMenu(tile(0), ctx).nodes, "Save snapshot");
		expect(save).toMatchObject({ disabled: true, note: "No picture yet" });
	});

	test("copying and popping out appear only where the browser can", () => {
		const { ctx } = harness({ can: { copyImage: false, popOut: false } });
		const shown = labels(buildMenu(tile(0), ctx).nodes);
		expect(shown).not.toContain("Copy snapshot");
		expect(shown).not.toContain("Pop out picture");
	});

	test("SD is offered only with a small stream", () => {
		const { ctx } = harness();
		const options = (index: number) => {
			const node = find(buildMenu(tile(index), ctx).nodes, "Picture");
			return node.kind === "segment" ? node.options.map((o) => o.label) : [];
		};
		expect(options(0)).toEqual(["Auto", "HD", "SD"]);
		expect(options(2)).toEqual(["Auto", "HD"]);
	});

	test("a smaller tile can move to the large one, and the large one cannot", () => {
		const { ctx, actions } = harness();
		expect(labels(buildMenu(tile(0), ctx).nodes)).not.toContain("Move to the large tile");
		press(buildMenu(tile(1), ctx).nodes, "Move to the large tile");
		expect(actions).toEqual([{ type: "swap", a: 1, b: 0 }]);
	});

	test("replacing lists absent cameras first and swaps ones already shown", () => {
		const wall = wallOf({ slots: [id("a"), id("b"), null] });
		const { ctx, actions } = harness({ wall });
		const list = sub(buildMenu(tile(0), ctx).nodes, "Replace with").items;
		expect(labels(list)).toEqual(["Not on this wall", "C", "D", "E", "On this wall", "B"]);
		press(list, "C");
		press(list, "B");
		expect(actions).toEqual([
			{ type: "assign", index: 0, camera: id("c") },
			{ type: "swap", a: 0, b: 1 },
		]);
	});

	test("the swap map marks this tile and describes the others", () => {
		const { ctx, actions } = harness();
		const map = tiles(sub(buildMenu(tile(0), ctx).nodes, "Swap with").items);
		expect(map.here).toEqual([0]);
		const [, filled, empty] = grid;
		if (!filled || !empty) throw new Error("grid is short");
		expect(map.describe(filled)).toBe("Swap with B");
		expect(map.describe(empty)).toBe("Move to empty tile 3");
		map.pick(filled);
		expect(actions).toEqual([{ type: "swap", a: 0, b: 1 }]);
	});

	test("full view steps through cameras and has no wall edits", () => {
		const { ctx } = harness({ wall: wallOf({ focused: id("b") }), cells: [] });
		const shown = labels(buildMenu(tile(FULL_TILE), ctx).nodes);
		expect(shown.slice(0, 3)).toEqual(["Back to the wall", "Next camera", "Previous camera"]);
		for (const gone of ["Clear tile", "Replace with", "Swap with"]) {
			expect(shown).not.toContain(gone);
		}
	});

	test("a grouped camera offers its group's wall, unless that is open", () => {
		const { ctx } = harness();
		expect(labels(buildMenu(tile(0), ctx).nodes)).toContain("Open Front");
		const inside = harness({
			wall: initialWall({ kind: "group", id: GroupId.parse("front") }, state),
		});
		expect(labels(buildMenu(tile(0), inside.ctx).nodes)).not.toContain("Open Front");
	});

	test("moving to a new group creates it and files the camera together", () => {
		const { ctx, commits } = harness();
		const picker = sub(buildMenu(tile(0), ctx).nodes, "Move to group").items;
		const name = find(picker, "New group");
		if (name.kind !== "name") throw new Error("not a name row");
		name.save("Roof");
		expect(commits[0]?.groups.map((g) => g.name)).toEqual(["Front", "Back", "Roof"]);
		expect(commits[0]?.cameras[0]?.groupId).toBe(GroupId.parse("roof"));
	});
});

describe("empty tile menu", () => {
	const wall = wallOf({ slots: [id("a"), null, id("c")] });

	test("offers what the wall lacks, then ways to close the hole", () => {
		const { ctx, actions } = harness({ wall });
		const { nodes } = buildMenu(tile(1), ctx);
		expect(labels(nodes).slice(0, 3)).toEqual(["Not on this wall", "B", "D"]);
		expect(labels(nodes)).toContain("Fill 1 empty tile");
		expect(labels(nodes)).toContain("Close the gaps");
		press(nodes, "B");
		expect(actions).toEqual([{ type: "assign", index: 1, camera: id("b") }]);
	});

	test("a camera already on the wall moves here instead of doubling up", () => {
		const { ctx, actions } = harness({ wall });
		press(buildMenu(tile(1), ctx).nodes, "C");
		expect(actions).toEqual([{ type: "swap", a: 2, b: 1 }]);
	});
});

describe("rail menus", () => {
	test("a camera on the wall can be shown, and one off it can be added", () => {
		const { ctx, actions } = harness({ wall: wallOf({ slots: [id("a"), id("b")] }) });
		const on = labels(buildMenu(camera("b"), ctx).nodes);
		expect(on).toContain("Show on the wall");
		expect(on).not.toContain("Add to this wall");
		press(buildMenu(camera("e"), ctx).nodes, "Add to this wall");
		press(buildMenu(camera("b"), ctx).nodes, "Show on the wall");
		expect(actions).toEqual([
			{ type: "add", cameras: [id("e")] },
			{ type: "reveal", index: 1 },
		]);
	});

	test("the tile map replaces for an absent camera and swaps for a shown one", () => {
		const { ctx, actions } = harness({ wall: wallOf({ slots: [id("a"), id("b"), null] }) });
		const [first] = grid;
		if (!first) throw new Error("grid is short");
		const away = tiles(buildMenu(camera("e"), ctx).nodes);
		expect(away.describe(first)).toBe("Replace A");
		away.pick(first);
		const shown = tiles(buildMenu(camera("b"), ctx).nodes);
		expect(shown.here).toEqual([1]);
		expect(shown.describe(first)).toBe("Swap with A");
		shown.pick(first);
		expect(actions).toEqual([
			{ type: "assign", index: 0, camera: id("e") },
			{ type: "swap", a: 1, b: 0 },
		]);
	});

	test("removing a camera asks twice and comes last", () => {
		const { ctx, calls } = harness();
		const { nodes } = buildMenu(camera("a"), ctx);
		expect(nodes.at(-1)).toMatchObject({
			label: "Remove camera",
			danger: true,
			confirm: "Click again to remove",
		});
		press(nodes, "Remove camera");
		expect(calls).toEqual(["remove a"]);
	});

	test("a stream address never reaches a menu", () => {
		const { ctx } = harness();
		const text = JSON.stringify(buildMenu(camera("a"), ctx).nodes);
		expect(text).not.toContain("rtsp");
	});

	test("a group adds its missing cameras to the open wall", () => {
		const { ctx, actions } = harness({ wall: wallOf({ slots: [id("a"), id("c")] }) });
		const { nodes } = buildMenu({ kind: "group", group: GroupId.parse("front") }, ctx);
		press(nodes, "Add 1 camera to this wall");
		expect(actions).toEqual([{ type: "add", cameras: [id("b")] }]);
	});

	test("removing a group keeps its cameras and leaves its wall", () => {
		const front = GroupId.parse("front");
		const { ctx, commits, calls } = harness({
			wall: initialWall({ kind: "group", id: front }, state),
		});
		press(buildMenu({ kind: "group", group: front }, ctx).nodes, "Remove group");
		expect(calls).toEqual(["open"]);
		expect(commits[0]?.groups.map((g) => g.name)).toEqual(["Back"]);
		expect(commits[0]?.cameras.filter((c) => c.groupId === null)).toHaveLength(5);
	});

	test("the first group moves down only and the last moves up only", () => {
		const { ctx, commits } = harness();
		const first = buildMenu({ kind: "group", group: GroupId.parse("front") }, ctx).nodes;
		const last = buildMenu({ kind: "group", group: GroupId.parse("back") }, ctx).nodes;
		expect(labels(first)).not.toContain("Move up");
		expect(labels(last)).not.toContain("Move down");
		press(first, "Move down");
		expect(commits[0]?.groups.map((g) => g.name)).toEqual(["Back", "Front"]);
	});

	test("a view shows its jump key and saves when it is open and edited", () => {
		const ref = { kind: "saved", id: ViewId.parse("pair") } as const;
		const closed = harness();
		const away = buildMenu({ kind: "view", ref }, closed.ctx).nodes;
		// All cameras, Front, Back, Ungrouped, then this view.
		expect(find(away, "Open view")).toMatchObject({ keys: "5" });
		expect(labels(away)).toContain("Replace with this wall");
		const open = harness({ wall: { ...initialWall(ref, state), edited: true } });
		const here = labels(buildMenu({ kind: "view", ref }, open.ctx).nodes);
		expect(here).toContain("Save changes");
		expect(here).not.toContain("Replace with this wall");
	});

	test("duplicating a view gives it a fresh id", () => {
		const { ctx, commits } = harness();
		const ref = { kind: "saved", id: ViewId.parse("pair") } as const;
		press(buildMenu({ kind: "view", ref }, ctx).nodes, "Duplicate view");
		expect(commits[0]?.views.at(-1)).toMatchObject({ id: "pair-copy", name: "Pair copy" });
	});
});

describe("wall menu", () => {
	test("offers saving only once the wall has changed", () => {
		const { ctx } = harness();
		expect(labels(buildMenu({ kind: "wall" }, ctx).nodes)).not.toContain("Save as view");
		const edited = harness({ wall: wallOf({ edited: true }) });
		expect(labels(buildMenu({ kind: "wall" }, edited.ctx).nodes).slice(0, 2)).toEqual([
			"Save as view",
			"Revert changes",
		]);
	});

	test("a running tour leads with stopping it", () => {
		const { ctx } = harness({ tour: true });
		const shown = labels(buildMenu({ kind: "wall" }, ctx).nodes);
		expect(shown[0]).toBe("Stop tour");
		expect(shown).not.toContain("Start tour");
	});

	test("paging appears only with more than one page", () => {
		const { ctx } = harness({ pages: 3 });
		expect(buildMenu({ kind: "wall" }, ctx).head?.info).toBe("Page 1 of 3");
		expect(labels(buildMenu({ kind: "wall" }, ctx).nodes)).toContain("Next page");
		expect(labels(buildMenu({ kind: "wall" }, harness().ctx).nodes)).not.toContain("Next page");
	});

	test("layouts name the best fit and how many pages the others take", () => {
		const { ctx } = harness();
		const list = sub(buildMenu({ kind: "wall" }, ctx).nodes, "Layout").items;
		expect(find(list, "1 large, 5 small")).toMatchObject({ note: "Best fit" });
		expect(find(list, "2 by 2")).toMatchObject({ note: "2 pages" });
		expect(find(list, "Fit all")).toMatchObject({ checked: true });
	});

	test("with no cameras it points at adding some", () => {
		const empty = AppState.parse({ cameras: [], groups: [], views: [] });
		const { ctx } = harness({ state: empty, wall: initialWall({ kind: "all" }, empty) });
		expect(labels(buildMenu({ kind: "wall" }, ctx).nodes)[0]).toBe("Add cameras");
	});

	test("no menu starts, ends or doubles a rule", () => {
		const targets: MenuTarget[] = [
			tile(0),
			camera("a"),
			{ kind: "wall" },
			{ kind: "rail" },
			{ kind: "group", group: null },
			{ kind: "group", group: GroupId.parse("front") },
		];
		for (const target of targets) {
			const { nodes } = buildMenu(target, harness().ctx);
			expect(nodes[0]?.kind).not.toBe("rule");
			expect(nodes.at(-1)?.kind).not.toBe("rule");
			nodes.forEach((node, i) => {
				if (node.kind === "rule") expect(nodes[i + 1]?.kind).not.toBe("rule");
			});
		}
	});
});

describe("health menu", () => {
	const statuses = new Map<CameraId, PlayerState>([
		[id("a"), "live"],
		[id("b"), "retrying"],
		[id("c"), "retrying"],
	]);

	test("names the lost cameras and reconnects only those", () => {
		const { ctx, calls, actions } = harness({ statuses });
		const menu = buildMenu({ kind: "health" }, ctx);
		expect(menu.head).toMatchObject({ name: "2 lost", info: "1 of 3 live" });
		press(menu.nodes, "Reconnect 2 lost cameras");
		press(menu.nodes, "B");
		expect(calls).toEqual(["reconnect b,c"]);
		expect(actions).toEqual([{ type: "reveal", index: 1 }]);
	});

	test("reconnecting everything covers the live ones too", () => {
		const { ctx, calls } = harness({ statuses });
		press(buildMenu({ kind: "health" }, ctx).nodes, "Reconnect everything");
		expect(calls).toEqual(["reconnect a,b,c"]);
	});
});

describe("found channels", () => {
	test("all and none grey out when they would change nothing", () => {
		const noop = () => undefined;
		const menu = foundMenu({
			name: "Channel 1",
			total: 4,
			picked: 4,
			onlyThis: noop,
			all: noop,
			none: noop,
			invert: noop,
		});
		expect(menu.head?.info).toBe("4 of 4 ticked");
		expect(find(menu.nodes, "Tick all")).toMatchObject({ disabled: true });
		expect(find(menu.nodes, "Tick none")).toMatchObject({ disabled: false });
	});
});
