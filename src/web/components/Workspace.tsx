import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { QualityChoice } from "@/shared/quality";
import { type AppState, type CameraId, uniqueSlug, ViewId } from "@/shared/schema";
import { Rail } from "@/web/components/Rail";
import { SettingsDialog, type SettingsTab } from "@/web/components/Settings";
import { TOUR_SECONDS, TopBar, type TourSeconds } from "@/web/components/TopBar";
import { Dialog } from "@/web/components/ui";
import { type Fit, Wall } from "@/web/components/Wall";
import { readPref, useMedia, writePref } from "@/web/lib/hooks";
import { saveSnapshot } from "@/web/lib/snapshot";
import {
	allRefs,
	cellsPerPage,
	initialWall,
	pageCount,
	parseSource,
	parseTarget,
	refKey,
	resolveRef,
	type ViewRef,
	wallReducer,
} from "@/web/lib/wall";

const SHORTCUTS: [string, string][] = [
	["Arrow keys", "Move between tiles"],
	["Enter", "Open the selected tile in full view"],
	["Esc", "Back to the wall"],
	["S", "Save a snapshot of the selected tile"],
	["Delete", "Clear the selected tile"],
	["[ and ]", "Previous and next page"],
	["1 to 9", "Jump to a view"],
	["T", "Start or stop the tour"],
	["F", "Full screen"],
	["B", "Show or hide the camera list"],
	["?", "This list"],
];

function refFromUrl(state: AppState): ViewRef {
	const key = new URLSearchParams(location.search).get("view");
	return allRefs(state).find((ref) => refKey(ref) === key) ?? { kind: "all" };
}

function storedSeconds(): TourSeconds {
	const stored = Number(readPref("tourSeconds"));
	return TOUR_SECONDS.find((seconds) => seconds === stored) ?? 15;
}

export function Workspace({
	state,
	commit,
	onLoaded,
}: {
	state: AppState;
	commit: (next: AppState) => void;
	onLoaded: (next: AppState) => void;
}) {
	const [wall, dispatch] = useReducer(wallReducer, undefined, () =>
		initialWall(refFromUrl(state), state),
	);
	const [fit, setFit] = useState<Fit>(() => (readPref("fit") === "fill" ? "fill" : "fit"));
	const [railOpen, setRailOpen] = useState(() => readPref("rail") !== "closed");
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [tour, setTour] = useState(false);
	const [tourSeconds, setTourSeconds] = useState<TourSeconds>(storedSeconds);
	const [settings, setSettings] = useState<SettingsTab | null>(null);
	const [help, setHelp] = useState(false);
	const [naming, setNaming] = useState(false);
	const [choices, setChoices] = useState<ReadonlyMap<CameraId, QualityChoice>>(new Map());
	const [dragging, setDragging] = useState<string | null>(null);
	const box = useRef<HTMLDivElement>(null);
	const compact = useMedia("(max-width: 720px)");

	useEffect(() => dispatch({ type: "sync", state }), [state]);

	const key = refKey(wall.ref);
	useEffect(() => {
		const url = new URL(location.href);
		url.searchParams.set("view", key);
		history.replaceState(null, "", url);
	}, [key]);

	const cameras = useMemo(() => new Map(state.cameras.map((c) => [c.id, c])), [state.cameras]);
	const resolved = resolveRef(wall.ref, state);
	const pages = compact ? 1 : pageCount(wall);

	const open = useCallback(
		(ref: ViewRef) => {
			dispatch({ type: "open", ref, state });
			setDrawerOpen(false);
		},
		[state],
	);

	const stepTour = useCallback(() => {
		if (wall.page + 1 < pages) {
			dispatch({ type: "page", page: wall.page + 1 });
			return;
		}
		const refs = allRefs(state);
		const here = refs.findIndex((ref) => refKey(ref) === key);
		const next = refs[(here + 1) % refs.length];
		if (next) dispatch({ type: "open", ref: next, state });
	}, [wall.page, pages, state, key]);

	useEffect(() => {
		if (!tour) return;
		const timer = setInterval(stepTour, tourSeconds * 1000);
		return () => clearInterval(timer);
	}, [tour, tourSeconds, stepTour]);

	const toggleRail = useCallback(() => {
		if (compact) {
			setDrawerOpen((value) => !value);
			return;
		}
		setRailOpen((value) => {
			writePref("rail", value ? "closed" : "open");
			return !value;
		});
	}, [compact]);

	const fullscreen = useCallback(() => {
		if (document.fullscreenElement) void document.exitFullscreen();
		else void document.documentElement.requestFullscreen();
	}, []);

	const snapshot = useCallback(
		(index: number) => {
			const camera = wall.slots[index];
			const video = box.current?.querySelector(`[data-tile="${index}"] video`);
			if (camera && video instanceof HTMLVideoElement) {
				saveSnapshot({ video, name: cameras.get(camera)?.name ?? camera });
			}
		},
		[wall.slots, cameras],
	);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
			if (typing || document.querySelector("dialog[open]")) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;

			const first = wall.page * cellsPerPage(wall);
			const last = first + cellsPerPage(wall) - 1;
			const step = (delta: number) => {
				if (wall.focused) {
					const shown = wall.slots.filter((slot) => slot !== null);
					const at = shown.indexOf(wall.focused);
					const next = shown[(at + delta + shown.length) % shown.length];
					if (next) dispatch({ type: "focus", camera: next });
					return;
				}
				const from = wall.selected ?? first - delta;
				dispatch({
					type: "select",
					index: Math.min(last, Math.max(first, from + delta)),
				});
			};

			switch (event.key) {
				case "ArrowRight":
				case "ArrowDown":
					step(1);
					break;
				case "ArrowLeft":
				case "ArrowUp":
					step(-1);
					break;
				case "Enter": {
					const camera = wall.selected === null ? null : wall.slots[wall.selected];
					if (!camera) return;
					dispatch({ type: "focus", camera });
					break;
				}
				case "Escape":
					if (wall.focused) dispatch({ type: "focus", camera: null });
					else dispatch({ type: "select", index: null });
					break;
				case "Delete":
				case "Backspace":
					if (wall.selected === null) return;
					dispatch({ type: "assign", index: wall.selected, camera: null });
					break;
				case "[":
					dispatch({ type: "page", page: wall.page - 1 });
					break;
				case "]":
					dispatch({ type: "page", page: wall.page + 1 });
					break;
				case "s":
					if (wall.selected !== null) snapshot(wall.selected);
					break;
				case "t":
					setTour((value) => !value);
					break;
				case "f":
					fullscreen();
					break;
				case "b":
					toggleRail();
					break;
				case "?":
					setHelp(true);
					break;
				default: {
					const number = Number(event.key);
					const ref = Number.isInteger(number) && number > 0 ? allRefs(state)[number - 1] : null;
					if (!ref) return;
					open(ref);
				}
			}
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [wall, state, open, snapshot, fullscreen, toggleRail]);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
	);

	const sourceCamera = (id: string | number): CameraId | null => {
		const source = parseSource(id);
		if (source?.kind === "camera") return source.camera;
		if (source?.kind === "tile") return wall.slots[source.index] ?? null;
		return null;
	};

	const onDragStart = (event: DragStartEvent) => {
		const camera = sourceCamera(event.active.id);
		setDragging(camera ? (cameras.get(camera)?.name ?? null) : null);
	};

	const onDragEnd = ({ active, over }: DragEndEvent) => {
		setDragging(null);
		const source = parseSource(active.id);
		const target = over ? parseTarget(over.id) : null;
		if (!source || !target) return;
		if (target.kind === "tile") {
			if (source.kind === "tile") {
				if (source.index !== target.index) {
					dispatch({ type: "swap", a: source.index, b: target.index });
				}
			} else {
				dispatch({ type: "assign", index: target.index, camera: source.camera });
			}
			return;
		}
		const camera = sourceCamera(active.id);
		if (camera === null) return;
		commit({
			...state,
			cameras: state.cameras.map((c) => (c.id === camera ? { ...c, groupId: target.group } : c)),
		});
	};

	const pickCamera = (camera: CameraId) => {
		setDrawerOpen(false);
		if (wall.selected !== null && !wall.focused) {
			dispatch({ type: "assign", index: wall.selected, camera });
		} else {
			dispatch({ type: "focus", camera });
		}
	};

	const saveCurrent = () => {
		const saved = resolved?.saved;
		if (!saved) return;
		commit({
			...state,
			views: state.views.map((v) =>
				v.id === saved.id ? { ...v, layout: wall.layout, slots: wall.slots } : v,
			),
		});
		dispatch({ type: "saved", ref: wall.ref });
	};

	const saveAs = (name: string) => {
		const id = ViewId.parse(uniqueSlug(name, new Set(state.views.map((v) => v.id))));
		commit({
			...state,
			views: [...state.views, { id, name, layout: wall.layout, slots: wall.slots }],
		});
		dispatch({ type: "saved", ref: { kind: "saved", id } });
		setNaming(false);
	};

	const shell = ["app"];
	if (!railOpen) shell.push("app-no-rail");
	const title = wall.focused
		? (cameras.get(wall.focused)?.name ?? "Camera")
		: (resolved?.name ?? "All cameras");

	return (
		<DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
			<div className={shell.join(" ")}>
				{compact && drawerOpen && (
					<button
						type="button"
						className="scrim"
						aria-label="Close the camera list"
						onClick={() => setDrawerOpen(false)}
					/>
				)}
				<Rail
					state={state}
					current={key}
					open={compact ? drawerOpen : railOpen}
					dragging={dragging !== null}
					onOpen={open}
					onPick={pickCamera}
					onAdd={() => setSettings("Add cameras")}
					onSettings={() => setSettings("Cameras")}
				/>
				<TopBar
					title={title}
					edited={wall.edited && !wall.focused}
					savedView={resolved?.saved != null}
					layout={wall.layout}
					page={wall.page}
					pages={wall.focused ? 1 : pages}
					fit={fit}
					tour={tour}
					tourSeconds={tourSeconds}
					onRail={toggleRail}
					onPage={(page) => dispatch({ type: "page", page })}
					onLayout={(layout) => dispatch({ type: "layout", layout })}
					onFit={() =>
						setFit((value) => {
							const next = value === "fit" ? "fill" : "fit";
							writePref("fit", next);
							return next;
						})
					}
					onTour={() => setTour((value) => !value)}
					onTourSeconds={(seconds) => {
						setTourSeconds(seconds);
						writePref("tourSeconds", String(seconds));
					}}
					onSave={saveCurrent}
					onSaveAs={() => setNaming(true)}
					onRevert={() => open(wall.ref)}
					onFullscreen={fullscreen}
					onHelp={() => setHelp(true)}
				/>
				<main className={compact && !wall.focused ? "wall wall-scroll" : "wall"} ref={box}>
					{state.cameras.length === 0 ? (
						<div className="empty">
							<h2>Add your first camera</h2>
							<p>
								Point Camwall at a recorder and it lists every channel, or paste one RTSP address.
							</p>
							<button
								type="button"
								className="button button-primary"
								onClick={() => setSettings("Add cameras")}
							>
								Add cameras
							</button>
						</div>
					) : (
						<Wall
							box={box}
							wall={wall}
							cameras={cameras}
							fit={fit}
							compact={compact}
							choices={choices}
							onSelect={(index) =>
								dispatch({ type: "select", index: wall.selected === index ? null : index })
							}
							onFocus={(camera) => dispatch({ type: "focus", camera })}
							onClear={(index) => dispatch({ type: "assign", index, camera: null })}
							onChoice={(camera, choice) =>
								setChoices((previous) => new Map(previous).set(camera, choice))
							}
						/>
					)}
				</main>
			</div>
			<DragOverlay dropAnimation={null}>
				{dragging && <div className="drag-chip">{dragging}</div>}
			</DragOverlay>
			{settings && (
				<SettingsDialog
					state={state}
					initialTab={settings}
					commit={commit}
					onLoaded={onLoaded}
					onClose={() => setSettings(null)}
				/>
			)}
			{help && (
				<Dialog title="Keyboard shortcuts" onClose={() => setHelp(false)}>
					<dl className="keys">
						{SHORTCUTS.map(([keys, action]) => (
							<div key={keys}>
								<dt>{keys}</dt>
								<dd>{action}</dd>
							</div>
						))}
					</dl>
				</Dialog>
			)}
			{naming && (
				<Dialog title="Save as view" onClose={() => setNaming(false)}>
					<form
						className="form-stack"
						onSubmit={(event) => {
							event.preventDefault();
							const data = new FormData(event.currentTarget).get("name");
							if (typeof data === "string" && data.trim() !== "") saveAs(data.trim());
						}}
					>
						<label>
							View name
							<input className="field" name="name" required maxLength={60} autoFocus />
						</label>
						<button type="submit" className="button button-primary">
							Save view
						</button>
					</form>
				</Dialog>
			)}
		</DndContext>
	);
}
