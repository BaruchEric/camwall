import { LAYOUTS, type LayoutId } from "@/shared/layouts";
import { type AppState, CameraId, GroupId, type View, ViewId } from "@/shared/schema";

export type ViewRef =
	| { kind: "all" }
	| { kind: "group"; id: GroupId }
	| { kind: "ungrouped" }
	| { kind: "saved"; id: ViewId };

export type Slot = CameraId | null;

/** The tile in full view. It sits outside the wall's slots. */
export const FULL_TILE = -1;

export const TOUR_SECONDS = [5, 10, 15, 30, 60] as const;
export type TourSeconds = (typeof TOUR_SECONDS)[number];

export type WallState = {
	ref: ViewRef;
	layout: LayoutId;
	slots: Slot[];
	page: number;
	/** Index into slots. */
	selected: number | null;
	focused: CameraId | null;
	/** True once the layout or slots no longer match what the view stores. */
	edited: boolean;
};

export type Resolved = { name: string; layout: LayoutId; slots: Slot[]; saved: View | null };

export function refKey(ref: ViewRef): string {
	switch (ref.kind) {
		case "all":
			return "all";
		case "ungrouped":
			return "ungrouped";
		case "group":
			return `group:${ref.id}`;
		case "saved":
			return `view:${ref.id}`;
		default: {
			const _exhaustive: never = ref;
			return _exhaustive;
		}
	}
}

export function allRefs(state: AppState): ViewRef[] {
	const refs: ViewRef[] = [{ kind: "all" }];
	for (const group of state.groups) refs.push({ kind: "group", id: group.id });
	if (state.groups.length > 0 && state.cameras.some((c) => c.groupId === null)) {
		refs.push({ kind: "ungrouped" });
	}
	for (const view of state.views) refs.push({ kind: "saved", id: view.id });
	return refs;
}

export function resolveRef(ref: ViewRef, state: AppState): Resolved | null {
	switch (ref.kind) {
		case "all":
			return {
				name: "All cameras",
				layout: "auto",
				slots: state.cameras.map((c) => c.id),
				saved: null,
			};
		case "ungrouped":
			return {
				name: "Ungrouped",
				layout: "auto",
				slots: state.cameras.filter((c) => c.groupId === null).map((c) => c.id),
				saved: null,
			};
		case "group": {
			const group = state.groups.find((g) => g.id === ref.id);
			if (!group) return null;
			return {
				name: group.name,
				layout: "auto",
				slots: state.cameras.filter((c) => c.groupId === ref.id).map((c) => c.id),
				saved: null,
			};
		}
		case "saved": {
			const view = state.views.find((v) => v.id === ref.id);
			return view ? { name: view.name, layout: view.layout, slots: view.slots, saved: view } : null;
		}
		default: {
			const _exhaustive: never = ref;
			return _exhaustive;
		}
	}
}

export function initialWall(ref: ViewRef, state: AppState): WallState {
	const resolved = resolveRef(ref, state) ?? resolveRef({ kind: "all" }, state);
	return {
		ref: resolved === null || resolveRef(ref, state) === null ? { kind: "all" } : ref,
		layout: resolved?.layout ?? "auto",
		slots: resolved?.slots ?? [],
		page: 0,
		selected: null,
		focused: null,
		edited: false,
	};
}

/** How many tiles one page holds. Auto puts everything on one page. */
export function cellsPerPage(wall: Pick<WallState, "layout" | "slots">): number {
	return wall.layout === "auto"
		? Math.max(wall.slots.length, 1)
		: LAYOUTS[wall.layout].cells.length;
}

export function pageCount(wall: Pick<WallState, "layout" | "slots">): number {
	return Math.max(1, Math.ceil(wall.slots.length / cellsPerPage(wall)));
}

export type WallAction =
	| { type: "open"; ref: ViewRef; state: AppState }
	| { type: "sync"; state: AppState }
	| { type: "layout"; layout: LayoutId }
	| { type: "page"; page: number }
	| { type: "select"; index: number | null }
	| { type: "focus"; camera: CameraId | null }
	| { type: "assign"; index: number; camera: Slot }
	| { type: "add"; cameras: readonly CameraId[] }
	| { type: "swap"; a: number; b: number }
	| { type: "reveal"; index: number }
	| { type: "tidy" }
	| { type: "saved"; ref: ViewRef };

function withSlot(slots: readonly Slot[], index: number, camera: Slot): Slot[] {
	const next = [...slots];
	while (next.length <= index) next.push(null);
	next[index] = camera;
	return next;
}

/** Fills empty slots first, then adds to the end, so a new camera never pushes another along. */
function withCameras(slots: readonly Slot[], cameras: readonly CameraId[]): Slot[] {
	const next = [...slots];
	for (const camera of cameras) {
		const free = next.indexOf(null);
		if (free >= 0) next[free] = camera;
		else next.push(camera);
	}
	return next;
}

/** The camera before or after this one in full view, wrapping at the ends. */
export function neighbour(wall: WallState, delta: number): CameraId | null {
	const shown = wall.slots.filter((slot) => slot !== null);
	if (wall.focused === null) return null;
	const at = shown.indexOf(wall.focused);
	return shown[(at + delta + shown.length) % shown.length] ?? null;
}

/** Cameras that would fill the wall's empty tiles, without adding a page. */
export function fillers(wall: WallState, state: AppState): CameraId[] {
	const shown = new Set(wall.slots);
	const unused = state.cameras.map((c) => c.id).filter((id) => !shown.has(id));
	const room = pageCount(wall) * cellsPerPage(wall) - wall.slots.filter(Boolean).length;
	return wall.layout === "auto"
		? unused.slice(0, wall.slots.filter((slot) => slot === null).length)
		: unused.slice(0, room);
}

export function wallReducer(wall: WallState, action: WallAction): WallState {
	switch (action.type) {
		case "open":
			return initialWall(action.ref, action.state);
		case "sync": {
			const known = new Set(action.state.cameras.map((c) => c.id));
			const focused = wall.focused !== null && known.has(wall.focused) ? wall.focused : null;
			if (!wall.edited) {
				const fresh = initialWall(wall.ref, action.state);
				const page = Math.min(wall.page, pageCount(fresh) - 1);
				return { ...fresh, page, selected: wall.selected, focused };
			}
			const slots = wall.slots.map((s) => (s !== null && known.has(s) ? s : null));
			return { ...wall, slots, focused };
		}
		case "layout":
			return { ...wall, layout: action.layout, page: 0, selected: null, edited: true };
		case "page": {
			const pages = pageCount(wall);
			return { ...wall, page: (action.page + pages) % pages, selected: null };
		}
		case "select":
			return { ...wall, selected: action.index };
		case "focus":
			return { ...wall, focused: action.camera };
		case "assign":
			return {
				...wall,
				slots: withSlot(wall.slots, action.index, action.camera),
				selected: action.index,
				edited: true,
			};
		case "add": {
			const slots = withCameras(wall.slots, action.cameras);
			const [only] = action.cameras;
			if (only === undefined || action.cameras.length > 1) {
				return { ...wall, slots, edited: true };
			}
			const index = slots.indexOf(only);
			const page = Math.floor(index / cellsPerPage({ layout: wall.layout, slots }));
			return { ...wall, slots, page, selected: index, focused: null, edited: true };
		}
		case "reveal":
			return {
				...wall,
				page: Math.floor(action.index / cellsPerPage(wall)),
				selected: action.index,
				focused: null,
			};
		case "tidy": {
			const slots = wall.slots.filter((slot) => slot !== null);
			const page = Math.min(wall.page, pageCount({ layout: wall.layout, slots }) - 1);
			return { ...wall, slots, page, selected: null, edited: true };
		}
		case "swap": {
			const first = wall.slots[action.a] ?? null;
			const second = wall.slots[action.b] ?? null;
			const slots = withSlot(withSlot(wall.slots, action.a, second), action.b, first);
			return { ...wall, slots, selected: action.b, edited: true };
		}
		case "saved":
			return { ...wall, ref: action.ref, edited: false };
		default: {
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}

export type DragSource = { kind: "camera"; camera: CameraId } | { kind: "tile"; index: number };

export type DropTarget = { kind: "tile"; index: number } | { kind: "group"; group: GroupId | null };

export const dragId = {
	camera: (id: CameraId) => `camera:${id}`,
	tile: (index: number) => `tile:${index}`,
	group: (id: GroupId | null) => (id === null ? "ungrouped" : `group:${id}`),
};

function tileIndex(id: string): number | null {
	if (!id.startsWith("tile:")) return null;
	const index = Number(id.slice(5));
	return Number.isInteger(index) && index >= 0 ? index : null;
}

/** What a right click landed on. Elements name it in `data-menu`, the way drags use `dragId`. */
export type MenuTarget =
	| { kind: "tile"; index: number }
	| { kind: "camera"; camera: CameraId }
	| { kind: "group"; group: GroupId | null }
	| { kind: "view"; ref: ViewRef }
	| { kind: "wall" }
	| { kind: "rail" }
	| { kind: "health" }
	/** Footage in playback: one camera's tile on the playback wall, or the whole of it. */
	| { kind: "replay"; camera: CameraId | null };

export const menuId = {
	tile: (index: number) => `tile:${index}`,
	camera: (id: CameraId) => `camera:${id}`,
	group: (id: GroupId | null) => (id === null ? "ungrouped" : `group:${id}`),
	view: (ref: ViewRef) => refKey(ref),
	wall: "wall",
	rail: "rail",
	health: "health",
	replay: "replay",
	replayTile: (id: CameraId) => `replay:${id}`,
};

export function parseMenuTarget(id: string): MenuTarget | null {
	if (id === "wall" || id === "rail" || id === "health") return { kind: id };
	if (id === "replay") return { kind: "replay", camera: null };
	if (id === "ungrouped") return { kind: "group", group: null };
	if (id === "all") return { kind: "view", ref: { kind: "all" } };
	const [kind, value] = id.split(/:(.*)/);
	if (kind === "tile") {
		const index = Number(value);
		return Number.isInteger(index) && index >= FULL_TILE ? { kind: "tile", index } : null;
	}
	if (kind === "camera") {
		const camera = CameraId.safeParse(value);
		return camera.success ? { kind: "camera", camera: camera.data } : null;
	}
	if (kind === "replay") {
		const camera = CameraId.safeParse(value);
		return camera.success ? { kind: "replay", camera: camera.data } : null;
	}
	if (kind === "group") {
		const group = GroupId.safeParse(value);
		return group.success ? { kind: "group", group: group.data } : null;
	}
	if (kind === "view") {
		const view = ViewId.safeParse(value);
		return view.success ? { kind: "view", ref: { kind: "saved", id: view.data } } : null;
	}
	return null;
}

export function parseSource(id: string | number): DragSource | null {
	const text = String(id);
	const index = tileIndex(text);
	if (index !== null) return { kind: "tile", index };
	const camera = CameraId.safeParse(text.replace(/^camera:/, ""));
	return text.startsWith("camera:") && camera.success
		? { kind: "camera", camera: camera.data }
		: null;
}

export function parseTarget(id: string | number): DropTarget | null {
	const text = String(id);
	if (text === "ungrouped") return { kind: "group", group: null };
	const index = tileIndex(text);
	if (index !== null) return { kind: "tile", index };
	const group = GroupId.safeParse(text.replace(/^group:/, ""));
	return text.startsWith("group:") && group.success ? { kind: "group", group: group.data } : null;
}
