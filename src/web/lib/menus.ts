import {
	ArrowLeftRight,
	Camera as CameraIcon,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	ChevronUp,
	CircleHelp,
	ClipboardCopy,
	Copy,
	Expand,
	Eye,
	FolderInput,
	FolderOpen,
	FolderPlus,
	Grid2x2Plus,
	LayoutGrid,
	Link,
	type LucideIcon,
	Maximize2,
	Minimize2,
	MoveDown,
	MoveUp,
	PanelLeft,
	Pencil,
	PictureInPicture2,
	Play,
	Plus,
	RectangleHorizontal,
	RefreshCw,
	Replace,
	RotateCcw,
	Save,
	Scan,
	Settings,
	Shrink,
	Square,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { LAYOUT_IDS, LAYOUT_LABELS, LAYOUTS, type LayoutId } from "@/shared/layouts";
import type { QualityChoice } from "@/shared/quality";
import {
	type AppState,
	type CameraId,
	type Group,
	GroupId,
	type PublicCamera,
	uniqueSlug,
	type View,
	ViewId,
} from "@/shared/schema";
import type { Fit } from "@/web/components/Wall";
import type { PlayerState } from "@/web/lib/player";
import { STATE_TEXT } from "@/web/lib/status";
import {
	allRefs,
	FULL_TILE,
	fillers,
	type MenuTarget,
	neighbour,
	pageCount,
	refKey,
	resolveRef,
	TOUR_SECONDS,
	type TourSeconds,
	type ViewRef,
	type WallAction,
	type WallState,
} from "@/web/lib/wall";

const MAX_GROUPS = 64;
const MAX_VIEWS = 64;
/** A filter box earns its place once a list stops fitting on screen comfortably. */
const FILTER_FROM = 10;
/** An empty tile lists this many cameras directly, and the rest one level down. */
const INLINE_CAMERAS = 6;

export type TileCell = {
	index: number;
	/** Position and size as fractions of the wall, so a small copy can be drawn from them. */
	x: number;
	y: number;
	w: number;
	h: number;
	camera: CameraId | null;
};

/** What sits at a row's left edge. A row has one of these, never two. */
type MenuMark =
	| { icon?: LucideIcon; tally?: never; glyph?: never }
	/** A camera's tally light. */
	| { tally: PlayerState; icon?: never; glyph?: never }
	| { glyph: LayoutId; icon?: never; tally?: never };

export type MenuAction = MenuMark & {
	kind: "action";
	label: string;
	note?: string | undefined;
	keys?: string | undefined;
	checked?: boolean;
	danger?: boolean;
	disabled?: boolean;
	/** Needs a second press, which shows this text. */
	confirm?: string;
	run: () => void;
};

export type MenuSub = {
	kind: "sub";
	label: string;
	icon?: LucideIcon;
	note?: string | undefined;
	/** Placeholder of a box that narrows the list. */
	filter?: string | undefined;
	items: MenuNode[];
};

/** A row that turns into a text box in place. */
export type MenuName = {
	kind: "name";
	label: string;
	icon?: LucideIcon;
	value: string;
	placeholder: string;
	save: (name: string) => void;
};

/** One choice from a few, picked without closing the menu. */
export type MenuSegment = {
	kind: "segment";
	label: string;
	value: string;
	options: { id: string; label: string }[];
	pick: (id: string) => void;
};

/** A small copy of the wall. Pressing a tile on it sends something there. */
export type MenuTiles = {
	kind: "tiles";
	label: string;
	/** Width over height of the wall. */
	ratio: number;
	cells: readonly TileCell[];
	/** The tile this menu is about, if any, which cannot be picked. */
	here: readonly number[];
	describe: (cell: TileCell) => string;
	pick: (cell: TileCell) => void;
};

export type MenuNode =
	| MenuAction
	| MenuSub
	| MenuName
	| MenuSegment
	| MenuTiles
	| { kind: "section"; label: string }
	| { kind: "rule" };

export type MenuHead = { name: string; info: string; state?: PlayerState };

export type MenuSpec = { head: MenuHead | null; nodes: MenuNode[] };

export type MenuCommands = {
	dispatch: (action: WallAction) => void;
	commit: (next: AppState) => void;
	open: (ref: ViewRef) => void;
	removeCamera: (camera: CameraId) => void;
	snapshot: (index: number) => void;
	copySnapshot: (index: number) => void;
	popOut: (index: number) => void;
	reconnect: (cameras: readonly CameraId[]) => void;
	choose: (camera: CameraId, choice: QualityChoice) => void;
	save: () => void;
	saveAs: (name: string) => void;
	revert: () => void;
	toggleFit: () => void;
	toggleTour: () => void;
	tourEvery: (seconds: TourSeconds) => void;
	toggleRail: () => void;
	toggleFullscreen: () => void;
	help: () => void;
	addCameras: () => void;
	settings: () => void;
	copyLink: (ref: ViewRef) => void;
	collapse: (keys: readonly string[]) => void;
};

export type MenuContext = {
	state: AppState;
	wall: WallState;
	statuses: ReadonlyMap<CameraId, PlayerState>;
	choices: ReadonlyMap<CameraId, QualityChoice>;
	pages: number;
	fit: Fit;
	tour: boolean;
	tourSeconds: TourSeconds;
	railVisible: boolean;
	fullscreen: boolean;
	collapsed: ReadonlySet<string>;
	/** The wall as it stood when the menu opened. Empty when no tiles are showing. */
	cells: readonly TileCell[];
	ratio: number;
	can: { copyImage: boolean; popOut: boolean };
	/** Whether a tile has a picture to save yet. */
	hasFrame: (index: number) => boolean;
	rate: (index: number) => string | null;
	run: MenuCommands;
};

const RULE: MenuNode = { kind: "rule" };

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function move<T extends { id: string }>(list: readonly T[], id: string, delta: number): T[] {
	const next = [...list];
	const from = next.findIndex((item) => item.id === id);
	const [item] = next.splice(from, 1);
	if (item) next.splice(from + delta, 0, item);
	return next;
}

function renameCamera(state: AppState, id: CameraId, name: string): AppState {
	return { ...state, cameras: state.cameras.map((c) => (c.id === id ? { ...c, name } : c)) };
}

function fileCamera(state: AppState, id: CameraId, groupId: GroupId | null): AppState {
	return { ...state, cameras: state.cameras.map((c) => (c.id === id ? { ...c, groupId } : c)) };
}

function newGroup(state: AppState, name: string): { state: AppState; id: GroupId } {
	const id = GroupId.parse(uniqueSlug(name, new Set(state.groups.map((g) => g.id))));
	return { state: { ...state, groups: [...state.groups, { id, name }] }, id };
}

/** The names the rail folds its sections under. */
function groupKeys(state: AppState): string[] {
	return [...state.groups.map((g) => g.id), "ungrouped"];
}

function cameraOf(ctx: MenuContext, id: CameraId | null | undefined): PublicCamera | undefined {
	return ctx.state.cameras.find((c) => c.id === id);
}

function tally(ctx: MenuContext, id: CameraId): PlayerState {
	return ctx.statuses.get(id) ?? "idle";
}

/** Leaves out the rule at either end and doubled rules, which appear when a run of items hides. */
function tidyRules(nodes: readonly MenuNode[]): MenuNode[] {
	const kept: MenuNode[] = [];
	for (const node of nodes) {
		if (node.kind === "rule" && (kept.length === 0 || kept.at(-1)?.kind === "rule")) continue;
		kept.push(node);
	}
	if (kept.at(-1)?.kind === "rule") kept.pop();
	return kept;
}

/** Cameras the wall lacks come first, since those are the ones worth bringing in. */
function cameraChoices(
	ctx: MenuContext,
	{
		except,
		onPick,
		shownNote,
	}: {
		except: CameraId | null;
		onPick: (camera: CameraId, at: number) => void;
		shownNote: string;
	},
): MenuNode[] {
	const row = (camera: PublicCamera, at: number): MenuNode => ({
		kind: "action",
		label: camera.name,
		tally: tally(ctx, camera.id),
		note: at >= 0 ? shownNote : undefined,
		run: () => onPick(camera.id, at),
	});
	const placed = ctx.state.cameras
		.filter((c) => c.id !== except)
		.map((camera) => ({ camera, at: ctx.wall.slots.indexOf(camera.id) }));
	const absent = placed.filter((p) => p.at < 0);
	const shown = placed.filter((p) => p.at >= 0);
	if (absent.length === 0 || shown.length === 0) {
		return placed.map((p) => row(p.camera, p.at));
	}
	return [
		{ kind: "section", label: "Not on this wall" },
		...absent.map((p) => row(p.camera, p.at)),
		{ kind: "section", label: "On this wall" },
		...shown.map((p) => row(p.camera, p.at)),
	];
}

function filterFor(ctx: MenuContext): string | undefined {
	return ctx.state.cameras.length >= FILTER_FROM ? "Find a camera" : undefined;
}

function layoutMenu(ctx: MenuContext): MenuNode {
	const { wall, run } = ctx;
	const shown = wall.slots.filter((slot) => slot !== null).length;
	const best = LAYOUT_IDS.find((id) => LAYOUTS[id].cells.length >= shown);
	const label = (id: LayoutId) => (id === "auto" ? "Fit all" : LAYOUT_LABELS[id]);
	const row = (id: LayoutId): MenuNode => {
		const pages = pageCount({ layout: id, slots: wall.slots });
		return {
			kind: "action",
			label: label(id),
			glyph: id,
			checked: wall.layout === id,
			note: id === best ? "Best fit" : pages > 1 ? `${pages} pages` : undefined,
			run: () => run.dispatch({ type: "layout", layout: id }),
		};
	};
	return {
		kind: "sub",
		label: "Layout",
		icon: LayoutGrid,
		note: label(wall.layout),
		items: [row("auto"), ...LAYOUT_IDS.map(row)],
	};
}

function gapItems(ctx: MenuContext): MenuNode[] {
	const { wall, state, run } = ctx;
	const items: MenuNode[] = [];
	const spare = fillers(wall, state);
	if (spare.length > 0) {
		items.push({
			kind: "action",
			label: `Fill ${count(spare.length, "empty tile")}`,
			icon: Grid2x2Plus,
			run: () => run.dispatch({ type: "add", cameras: spare }),
		});
	}
	if (wall.slots.includes(null)) {
		items.push({
			kind: "action",
			label: "Close the gaps",
			icon: Shrink,
			run: () => run.dispatch({ type: "tidy" }),
		});
	}
	return items;
}

function groupPicker(ctx: MenuContext, camera: PublicCamera): MenuNode {
	const { state, run } = ctx;
	const row = (id: GroupId | null, label: string): MenuNode => ({
		kind: "action",
		label,
		checked: camera.groupId === id,
		run: () => run.commit(fileCamera(state, camera.id, id)),
	});
	const name = state.groups.find((g) => g.id === camera.groupId)?.name;
	const items: MenuNode[] = [row(null, "No group"), ...state.groups.map((g) => row(g.id, g.name))];
	if (state.groups.length < MAX_GROUPS) {
		items.push(RULE, {
			kind: "name",
			label: "New group",
			icon: FolderPlus,
			value: "",
			placeholder: "Group name",
			save: (group) => {
				const made = newGroup(state, group);
				run.commit(fileCamera(made.state, camera.id, made.id));
			},
		});
	}
	return { kind: "sub", label: "Move to group", icon: FolderInput, note: name, items };
}

function renameItem(ctx: MenuContext, camera: PublicCamera): MenuNode {
	return {
		kind: "name",
		label: "Rename camera",
		icon: Pencil,
		value: camera.name,
		placeholder: "Camera name",
		save: (name) => ctx.run.commit(renameCamera(ctx.state, camera.id, name)),
	};
}

function groupWallItem(ctx: MenuContext, camera: PublicCamera): MenuNode[] {
	const group = ctx.state.groups.find((g) => g.id === camera.groupId);
	if (!group) return [];
	const ref: ViewRef = { kind: "group", id: group.id };
	if (refKey(ref) === refKey(ctx.wall.ref)) return [];
	return [
		{
			kind: "action",
			label: `Open ${group.name}`,
			icon: FolderOpen,
			run: () => ctx.run.open(ref),
		},
	];
}

function picture(ctx: MenuContext, camera: PublicCamera): MenuNode {
	const options = [
		{ id: "auto", label: "Auto" },
		{ id: "main", label: "HD" },
	];
	if (camera.hasSub) options.push({ id: "sub", label: "SD" });
	return {
		kind: "segment",
		label: "Picture",
		value: ctx.choices.get(camera.id) ?? "auto",
		options,
		pick: (id) => {
			if (id === "auto" || id === "main" || id === "sub") ctx.run.choose(camera.id, id);
		},
	};
}

function liveInfo(ctx: MenuContext, index: number, state: PlayerState): string {
	return (state === "live" && ctx.rate(index)) || STATE_TEXT[state];
}

function emptyTileMenu(index: number, ctx: MenuContext): MenuSpec {
	const { wall, run } = ctx;
	const choices = cameraChoices(ctx, {
		except: null,
		shownNote: "Moves here",
		onPick: (camera, at) =>
			run.dispatch(at >= 0 ? { type: "swap", a: at, b: index } : { type: "assign", index, camera }),
	});
	const rows = choices.filter((node) => node.kind === "action");
	const absent = rows.filter((row) => row.note === undefined).slice(0, INLINE_CAMERAS);
	const short: MenuNode[] = [];
	if (absent.length > 0) short.push({ kind: "section", label: "Not on this wall" }, ...absent);
	short.push({
		kind: "sub",
		label: "All cameras",
		icon: Plus,
		filter: filterFor(ctx),
		items: choices,
	});
	return {
		head: { name: "Empty tile", info: `Tile ${index + 1}` },
		nodes: tidyRules([
			...(rows.length <= INLINE_CAMERAS ? choices : short),
			RULE,
			...gapItems(ctx),
			layoutMenu(ctx),
			...(wall.edited ? saveItems(ctx) : []),
		]),
	};
}

function tileMenu(index: number, ctx: MenuContext): MenuSpec {
	const { wall, run, cells } = ctx;
	const full = index === FULL_TILE;
	const camera = cameraOf(ctx, full ? wall.focused : wall.slots[index]);
	if (!camera) return emptyTileMenu(index, ctx);

	const status = tally(ctx, camera.id);
	const lost = status === "retrying";
	const ready = ctx.hasFrame(index);
	const here = cells.find((cell) => cell.index === index);
	const largest = cells.toSorted((a, b) => b.w * b.h - a.w * a.h)[0];
	const smaller = here && largest && largest.w * largest.h > here.w * here.h;
	const others = cells.filter((cell) => cell.index !== index);

	const nodes: MenuNode[] = [];
	if (lost) {
		nodes.push({
			kind: "action",
			label: "Reconnect now",
			icon: RefreshCw,
			run: () => run.reconnect([camera.id]),
		});
	}
	nodes.push(
		full
			? {
					kind: "action",
					label: "Back to the wall",
					icon: Minimize2,
					keys: "Esc",
					run: () => run.dispatch({ type: "focus", camera: null }),
				}
			: {
					kind: "action",
					label: "Open full view",
					icon: Maximize2,
					keys: "Enter",
					run: () => run.dispatch({ type: "focus", camera: camera.id }),
				},
	);
	if (full && wall.slots.filter((slot) => slot !== null).length > 1) {
		const step = (delta: number) => run.dispatch({ type: "focus", camera: neighbour(wall, delta) });
		nodes.push(
			{
				kind: "action",
				label: "Next camera",
				icon: ChevronRight,
				keys: "Right",
				run: () => step(1),
			},
			{
				kind: "action",
				label: "Previous camera",
				icon: ChevronLeft,
				keys: "Left",
				run: () => step(-1),
			},
		);
	}
	nodes.push(picture(ctx, camera), RULE, {
		kind: "action",
		label: "Save snapshot",
		icon: CameraIcon,
		keys: "S",
		disabled: !ready,
		note: ready ? undefined : "No picture yet",
		run: () => run.snapshot(index),
	});
	if (ctx.can.copyImage) {
		nodes.push({
			kind: "action",
			label: "Copy snapshot",
			icon: ClipboardCopy,
			disabled: !ready,
			run: () => run.copySnapshot(index),
		});
	}
	if (ctx.can.popOut) {
		nodes.push({
			kind: "action",
			label: "Pop out picture",
			icon: PictureInPicture2,
			disabled: !ready,
			run: () => run.popOut(index),
		});
	}
	if (!full) {
		nodes.push(RULE);
		if (smaller) {
			nodes.push({
				kind: "action",
				label: "Move to the large tile",
				icon: Maximize2,
				run: () => run.dispatch({ type: "swap", a: index, b: largest.index }),
			});
		}
		nodes.push({
			kind: "sub",
			label: "Replace with",
			icon: Replace,
			filter: filterFor(ctx),
			items: cameraChoices(ctx, {
				except: camera.id,
				shownNote: "Swaps",
				onPick: (next, at) =>
					run.dispatch(
						at >= 0 ? { type: "swap", a: index, b: at } : { type: "assign", index, camera: next },
					),
			}),
		});
		if (others.length > 0) {
			nodes.push({
				kind: "sub",
				label: "Swap with",
				icon: ArrowLeftRight,
				items: [
					{
						kind: "tiles",
						label: "Pick a tile",
						ratio: ctx.ratio,
						cells,
						here: [index],
						describe: (cell) => {
							const name = cameraOf(ctx, cell.camera)?.name;
							return name ? `Swap with ${name}` : `Move to empty tile ${cell.index + 1}`;
						},
						pick: (cell) => run.dispatch({ type: "swap", a: index, b: cell.index }),
					},
				],
			});
		}
		nodes.push({
			kind: "action",
			label: "Clear tile",
			icon: X,
			keys: "Del",
			run: () => run.dispatch({ type: "assign", index, camera: null }),
		});
	}
	nodes.push(
		RULE,
		...groupWallItem(ctx, camera),
		groupPicker(ctx, camera),
		renameItem(ctx, camera),
	);

	return {
		head: {
			name: camera.name,
			info: liveInfo(ctx, index, status),
			state: status,
		},
		nodes: tidyRules(nodes),
	};
}

function cameraMenu(id: CameraId, ctx: MenuContext): MenuSpec {
	const { wall, state, run, cells } = ctx;
	const camera = cameraOf(ctx, id);
	if (!camera) return { head: null, nodes: [] };
	const at = wall.slots.indexOf(id);
	const status = tally(ctx, id);
	const group = state.groups.find((g) => g.id === camera.groupId);

	const nodes: MenuNode[] = [];
	if (cells.length > 0) {
		nodes.push(
			{
				kind: "tiles",
				label: "Put on a tile",
				ratio: ctx.ratio,
				cells,
				here: cells.filter((cell) => cell.camera === id).map((cell) => cell.index),
				describe: (cell) => {
					const name = cameraOf(ctx, cell.camera)?.name;
					if (!name) return `Put on empty tile ${cell.index + 1}`;
					return at >= 0 ? `Swap with ${name}` : `Replace ${name}`;
				},
				pick: (cell) =>
					run.dispatch(
						at >= 0
							? { type: "swap", a: at, b: cell.index }
							: { type: "assign", index: cell.index, camera: id },
					),
			},
			RULE,
		);
	}
	nodes.push({
		kind: "action",
		label: "Open full view",
		icon: Maximize2,
		run: () => run.dispatch({ type: "focus", camera: id }),
	});
	nodes.push(
		at >= 0
			? {
					kind: "action",
					label: "Show on the wall",
					icon: Eye,
					run: () => run.dispatch({ type: "reveal", index: at }),
				}
			: {
					kind: "action",
					label: "Add to this wall",
					icon: Plus,
					run: () => run.dispatch({ type: "add", cameras: [id] }),
				},
	);
	nodes.push(
		RULE,
		...groupWallItem(ctx, camera),
		groupPicker(ctx, camera),
		renameItem(ctx, camera),
		RULE,
		{
			kind: "action",
			label: "Remove camera",
			icon: Trash2,
			danger: true,
			confirm: "Click again to remove",
			run: () => run.removeCamera(id),
		},
	);
	return {
		head: { name: camera.name, info: group?.name ?? STATE_TEXT[status], state: status },
		nodes: tidyRules(nodes),
	};
}

function jumpKey(state: AppState, ref: ViewRef): string | undefined {
	const at = allRefs(state).findIndex((r) => refKey(r) === refKey(ref));
	return at >= 0 && at < 9 ? String(at + 1) : undefined;
}

function reorderItems<T extends Group | View>(
	list: readonly T[],
	item: T,
	apply: (next: T[]) => void,
): MenuNode[] {
	const at = list.findIndex((other) => other.id === item.id);
	const rows: MenuNode[] = [];
	if (at > 0) {
		rows.push({
			kind: "action",
			label: "Move up",
			icon: MoveUp,
			run: () => apply(move(list, item.id, -1)),
		});
	}
	if (at < list.length - 1) {
		rows.push({
			kind: "action",
			label: "Move down",
			icon: MoveDown,
			run: () => apply(move(list, item.id, 1)),
		});
	}
	return rows;
}

function groupMenu(id: GroupId | null, ctx: MenuContext): MenuSpec {
	const { state, wall, run, collapsed, statuses } = ctx;
	const group = state.groups.find((g) => g.id === id);
	const cameras = state.cameras.filter((c) => c.groupId === id);
	const live = cameras.filter((c) => statuses.get(c.id) === "live").length;
	const named = group !== undefined || state.groups.length > 0;
	const ref: ViewRef = group
		? { kind: "group", id: group.id }
		: named
			? { kind: "ungrouped" }
			: { kind: "all" };
	const name = group?.name ?? (named ? "Ungrouped" : "Cameras");
	const key = group?.id ?? "ungrouped";
	const missing = cameras.filter((c) => !wall.slots.includes(c.id)).map((c) => c.id);
	const open = refKey(ref) === refKey(wall.ref);
	const others = groupKeys(state).filter((k) => k !== key);

	const nodes: MenuNode[] = [
		{
			kind: "action",
			label: open ? "Back to this wall" : "Open wall",
			icon: LayoutGrid,
			keys: jumpKey(state, ref),
			disabled: cameras.length === 0,
			run: () => run.open(ref),
		},
	];
	if (!open && missing.length > 0) {
		nodes.push({
			kind: "action",
			label: `Add ${count(missing.length, "camera")} to this wall`,
			icon: Plus,
			run: () => run.dispatch({ type: "add", cameras: missing }),
		});
	}
	nodes.push(RULE, {
		kind: "action",
		label: collapsed.has(key) ? "Show cameras" : "Hide cameras",
		icon: collapsed.has(key) ? ChevronDown : ChevronUp,
		run: () =>
			run.collapse(
				collapsed.has(key) ? [...collapsed].filter((k) => k !== key) : [...collapsed, key],
			),
	});
	if (others.length > 0) {
		nodes.push({
			kind: "action",
			label: "Hide the others",
			icon: ChevronsDownUp,
			run: () => run.collapse(others),
		});
	}
	if (group) {
		nodes.push(
			RULE,
			{
				kind: "name",
				label: "Rename group",
				icon: Pencil,
				value: group.name,
				placeholder: "Group name",
				save: (next) =>
					run.commit({
						...state,
						groups: state.groups.map((g) => (g.id === group.id ? { ...g, name: next } : g)),
					}),
			},
			...reorderItems(state.groups, group, (groups) => run.commit({ ...state, groups })),
			RULE,
			{
				kind: "action",
				label: "Remove group",
				icon: Trash2,
				note: cameras.length > 0 ? "Keeps its cameras" : undefined,
				danger: true,
				confirm: "Click again to remove",
				run: () => {
					if (open) run.open({ kind: "all" });
					run.commit({
						...state,
						groups: state.groups.filter((g) => g.id !== group.id),
						cameras: state.cameras.map((c) =>
							c.groupId === group.id ? { ...c, groupId: null } : c,
						),
					});
				},
			},
		);
	}
	return {
		head: {
			name,
			info: live > 0 ? `${live} of ${cameras.length} live` : count(cameras.length, "camera"),
		},
		nodes: tidyRules(nodes),
	};
}

function savedViewMenu(view: View, ctx: MenuContext): MenuSpec {
	const { state, wall, run } = ctx;
	const ref: ViewRef = { kind: "saved", id: view.id };
	const open = refKey(ref) === refKey(wall.ref);
	const nodes: MenuNode[] = [
		{
			kind: "action",
			label: open ? "Back to this view" : "Open view",
			icon: LayoutGrid,
			keys: jumpKey(state, ref),
			run: () => run.open(ref),
		},
	];
	if (open && wall.edited) {
		nodes.push({ kind: "action", label: "Save changes", icon: Save, run: run.save });
		nodes.push({ kind: "action", label: "Revert changes", icon: Undo2, run: run.revert });
	} else if (!open) {
		nodes.push({
			kind: "action",
			label: "Replace with this wall",
			icon: Replace,
			confirm: "Click again to replace",
			run: () =>
				run.commit({
					...state,
					views: state.views.map((v) =>
						v.id === view.id ? { ...v, layout: wall.layout, slots: wall.slots } : v,
					),
				}),
		});
	}
	nodes.push(RULE, {
		kind: "action",
		label: "Copy link",
		icon: Link,
		run: () => run.copyLink(ref),
	});
	if (state.views.length < MAX_VIEWS) {
		nodes.push({
			kind: "action",
			label: "Duplicate view",
			icon: Copy,
			run: () => {
				const name = `${view.name.slice(0, 55)} copy`;
				const id = ViewId.parse(uniqueSlug(name, new Set(state.views.map((v) => v.id))));
				run.commit({ ...state, views: [...state.views, { ...view, id, name }] });
			},
		});
	}
	nodes.push(
		{
			kind: "name",
			label: "Rename view",
			icon: Pencil,
			value: view.name,
			placeholder: "View name",
			save: (name) =>
				run.commit({
					...state,
					views: state.views.map((v) => (v.id === view.id ? { ...v, name } : v)),
				}),
		},
		...reorderItems(state.views, view, (views) => run.commit({ ...state, views })),
		RULE,
		{
			kind: "action",
			label: "Remove view",
			icon: Trash2,
			danger: true,
			confirm: "Click again to remove",
			run: () => {
				if (open) run.open({ kind: "all" });
				run.commit({ ...state, views: state.views.filter((v) => v.id !== view.id) });
			},
		},
	);
	return {
		head: { name: view.name, info: count(view.slots.filter(Boolean).length, "camera") },
		nodes: tidyRules(nodes),
	};
}

function viewMenu(ref: ViewRef, ctx: MenuContext): MenuSpec {
	const { state, run } = ctx;
	if (ref.kind === "saved") {
		const view = state.views.find((v) => v.id === ref.id);
		return view ? savedViewMenu(view, ctx) : { head: null, nodes: [] };
	}
	if (ref.kind === "group") return groupMenu(ref.id, ctx);
	if (ref.kind === "ungrouped") return groupMenu(null, ctx);
	return {
		head: { name: "All cameras", info: count(state.cameras.length, "camera") },
		nodes: [
			{
				kind: "action",
				label: "Open wall",
				icon: LayoutGrid,
				keys: jumpKey(state, ref),
				run: () => run.open(ref),
			},
			{ kind: "action", label: "Copy link", icon: Link, run: () => run.copyLink(ref) },
		],
	};
}

function saveItems(ctx: MenuContext): MenuNode[] {
	const { state, wall, run } = ctx;
	const saved = wall.ref.kind === "saved";
	const items: MenuNode[] = [];
	if (saved) items.push({ kind: "action", label: "Save changes", icon: Save, run: run.save });
	if (state.views.length < MAX_VIEWS) {
		items.push({
			kind: "name",
			label: "Save as view",
			icon: Plus,
			value: "",
			placeholder: "View name",
			save: run.saveAs,
		});
	}
	items.push({ kind: "action", label: "Revert changes", icon: Undo2, run: run.revert });
	return items;
}

function wallMenu(ctx: MenuContext): MenuSpec {
	const { state, wall, run, pages, fit, tour, tourSeconds, railVisible, fullscreen } = ctx;
	const shown = wall.slots.filter((slot) => slot !== null).length;
	const name = resolveRef(wall.ref, state)?.name ?? "All cameras";
	const view: MenuNode[] = [
		{
			kind: "action",
			label: fullscreen ? "Leave full screen" : "Full screen",
			icon: Expand,
			keys: "F",
			run: run.toggleFullscreen,
		},
		{
			kind: "action",
			label: railVisible ? "Hide camera list" : "Show camera list",
			icon: PanelLeft,
			keys: "B",
			run: run.toggleRail,
		},
		{
			kind: "action",
			label: "Keyboard shortcuts",
			icon: CircleHelp,
			keys: "?",
			run: run.help,
		},
	];

	if (state.cameras.length === 0) {
		return {
			head: { name: "No cameras yet", info: "" },
			nodes: [
				{ kind: "action", label: "Add cameras", icon: Plus, run: run.addCameras },
				RULE,
				...view,
			],
		};
	}

	const nodes: MenuNode[] = [];
	if (tour) {
		nodes.push({
			kind: "action",
			label: "Stop tour",
			icon: Square,
			keys: "T",
			run: run.toggleTour,
		});
	}
	if (wall.edited && !wall.focused) nodes.push(...saveItems(ctx), RULE);
	if (wall.focused) {
		nodes.push({
			kind: "action",
			label: "Back to the wall",
			icon: Minimize2,
			keys: "Esc",
			run: () => run.dispatch({ type: "focus", camera: null }),
		});
	} else {
		nodes.push(layoutMenu(ctx), {
			kind: "action",
			label: fit === "fit" ? "Fill each tile" : "Show the whole picture",
			icon: fit === "fit" ? Scan : RectangleHorizontal,
			run: run.toggleFit,
		});
		nodes.push(...gapItems(ctx));
		if (pages > 1) {
			nodes.push(
				{
					kind: "action",
					label: "Next page",
					icon: ChevronRight,
					keys: "]",
					run: () => run.dispatch({ type: "page", page: wall.page + 1 }),
				},
				{
					kind: "action",
					label: "Previous page",
					icon: ChevronLeft,
					keys: "[",
					run: () => run.dispatch({ type: "page", page: wall.page - 1 }),
				},
			);
		}
	}
	nodes.push(RULE);
	if (!tour) {
		nodes.push({ kind: "action", label: "Start tour", icon: Play, keys: "T", run: run.toggleTour });
	}
	nodes.push(
		{
			kind: "segment",
			label: "Seconds",
			value: String(tourSeconds),
			options: TOUR_SECONDS.map((seconds) => ({ id: String(seconds), label: String(seconds) })),
			pick: (id) => {
				const seconds = TOUR_SECONDS.find((s) => String(s) === id);
				if (seconds) run.tourEvery(seconds);
			},
		},
		RULE,
		{ kind: "action", label: "Copy link", icon: Link, run: () => run.copyLink(wall.ref) },
		...view,
		{ kind: "action", label: "Settings", icon: Settings, run: run.settings },
	);
	return {
		head: {
			name,
			info: pages > 1 ? `Page ${wall.page + 1} of ${pages}` : count(shown, "camera"),
		},
		nodes: tidyRules(nodes),
	};
}

function railMenu(ctx: MenuContext): MenuSpec {
	const { state, run, collapsed } = ctx;
	const keys = groupKeys(state);
	const nodes: MenuNode[] = [
		{ kind: "action", label: "Add cameras", icon: Plus, run: run.addCameras },
	];
	if (state.groups.length < MAX_GROUPS) {
		nodes.push({
			kind: "name",
			label: "New group",
			icon: FolderPlus,
			value: "",
			placeholder: "Group name",
			save: (name) => run.commit(newGroup(state, name).state),
		});
	}
	nodes.push(RULE);
	if (collapsed.size > 0) {
		nodes.push({
			kind: "action",
			label: "Show all cameras",
			icon: ChevronsUpDown,
			run: () => run.collapse([]),
		});
	}
	if (collapsed.size < keys.length && state.groups.length > 0) {
		nodes.push({
			kind: "action",
			label: "Hide all cameras",
			icon: ChevronsDownUp,
			run: () => run.collapse(keys),
		});
	}
	nodes.push(
		RULE,
		{ kind: "action", label: "Hide camera list", icon: PanelLeft, keys: "B", run: run.toggleRail },
		{ kind: "action", label: "Settings", icon: Settings, run: run.settings },
	);
	return { head: null, nodes: tidyRules(nodes) };
}

function healthMenu(ctx: MenuContext): MenuSpec {
	const { statuses, wall, run } = ctx;
	const entries = [...statuses];
	const live = entries.filter(([, state]) => state === "live").length;
	const lost = entries.filter(([, state]) => state === "retrying").map(([id]) => id);
	const nodes: MenuNode[] = [];
	if (lost.length > 0) {
		nodes.push({
			kind: "action",
			label: `Reconnect ${count(lost.length, "lost camera")}`,
			icon: RefreshCw,
			run: () => run.reconnect(lost),
		});
		nodes.push({ kind: "section", label: "No signal" });
		for (const id of lost) {
			const at = wall.slots.indexOf(id);
			nodes.push({
				kind: "action",
				label: cameraOf(ctx, id)?.name ?? id,
				tally: "retrying",
				note: "Show",
				disabled: at < 0,
				run: () => run.dispatch({ type: "reveal", index: at }),
			});
		}
		nodes.push(RULE);
	}
	nodes.push({
		kind: "action",
		label: "Reconnect everything",
		icon: RotateCcw,
		run: () => run.reconnect(entries.map(([id]) => id)),
	});
	return {
		head: {
			name: lost.length > 0 ? `${lost.length} lost` : "All live",
			info: `${live} of ${entries.length} live`,
			state: lost.length > 0 ? "retrying" : "live",
		},
		nodes,
	};
}

export function buildMenu(target: MenuTarget, ctx: MenuContext): MenuSpec {
	switch (target.kind) {
		case "tile":
			return tileMenu(target.index, ctx);
		case "camera":
			return cameraMenu(target.camera, ctx);
		case "group":
			return groupMenu(target.group, ctx);
		case "view":
			return viewMenu(target.ref, ctx);
		case "wall":
			return wallMenu(ctx);
		case "rail":
			return railMenu(ctx);
		case "health":
			return healthMenu(ctx);
		default: {
			const _exhaustive: never = target;
			return _exhaustive;
		}
	}
}

/** Ticks for the channels a recorder listed, which live in the Add cameras form. */
export function foundMenu({
	name,
	total,
	picked,
	onlyThis,
	all,
	none,
	invert,
}: {
	name: string;
	total: number;
	picked: number;
	onlyThis: () => void;
	all: () => void;
	none: () => void;
	invert: () => void;
}): MenuSpec {
	return {
		head: { name, info: `${picked} of ${total} ticked` },
		nodes: [
			{ kind: "action", label: "Tick only this one", run: onlyThis },
			{ kind: "action", label: "Tick all", disabled: picked === total, run: all },
			{ kind: "action", label: "Tick none", disabled: picked === 0, run: none },
			{ kind: "action", label: "Swap ticks", run: invert },
		],
	};
}
