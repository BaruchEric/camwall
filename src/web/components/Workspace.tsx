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
import { type MenuTrigger, triggerAt, useMenuTriggers } from "@/web/components/ContextMenu";
import { WallMenu, type WallMenuContext } from "@/web/components/ContextMenuHost";
import { Rail } from "@/web/components/Rail";
import { type ReplayControls, ReplayView } from "@/web/components/Replay";
import { SettingsDialog, type SettingsTab } from "@/web/components/Settings";
import { type Mode, TopBar } from "@/web/components/TopBar";
import { Dialog } from "@/web/components/ui";
import { type Fit, Wall } from "@/web/components/Wall";
import { api } from "@/web/lib/api";
import { readPref, useMedia, writePref } from "@/web/lib/hooks";
import type { MenuSpec, ReplayMenu, TileCell } from "@/web/lib/menus";
import { canCopyImage, copySnapshot, copyText, saveSnapshot } from "@/web/lib/snapshot";
import { type Moment, momentText, parseMoment } from "@/web/lib/timeline";
import {
	allRefs,
	cellsPerPage,
	FULL_TILE,
	initialWall,
	menuId,
	neighbour,
	pageCount,
	parseSource,
	parseTarget,
	refKey,
	resolveRef,
	TOUR_SECONDS,
	type TourSeconds,
	type ViewRef,
	wallReducer,
} from "@/web/lib/wall";

const SHORTCUTS: { title: string; keys: [string, string][] }[] = [
	{
		title: "Live",
		keys: [
			["Arrow keys", "Move between tiles"],
			["Enter", "Open the selected tile in full view"],
			["Esc", "Back to the wall"],
			["S", "Save a snapshot of the selected tile"],
			["P", "Play back recordings, starting with the selected tile"],
			["Delete", "Clear the selected tile"],
			["[ and ]", "Previous and next page"],
			["T", "Start or stop the tour"],
		],
	},
	{
		title: "Playback",
		keys: [
			["Space", "Play or pause"],
			["Left and Right", "Back or forward 10 seconds"],
			["[ and ]", "Previous or next camera, same moment"],
			["S", "Save a snapshot"],
			["P or Esc", "Back to live"],
		],
	},
	{
		title: "Anywhere",
		keys: [
			["1 to 9", "Jump to a view"],
			["F", "Full screen"],
			["B", "Show or hide the camera list"],
			["?", "This list"],
			["Right click", "Actions for whatever is under the pointer"],
			["Shift+F10", "The same actions for the selected tile"],
			["Shift + right click", "The browser's own menu"],
		],
	},
];

/** Where the wall's tiles sit right now, read from the page so it matches what is on screen. */
function readCells(box: HTMLElement | null): { cells: TileCell[]; ratio: number } {
	const wall = box?.querySelector(".wall-box:not(.wall-full)");
	if (!box || !wall || box.classList.contains("wall-scroll")) return { cells: [], ratio: 16 / 9 };
	const outer = wall.getBoundingClientRect();
	const cells: TileCell[] = [];
	for (const tile of wall.querySelectorAll<HTMLElement>("[data-tile]")) {
		const inner = tile.getBoundingClientRect();
		const index = Number(tile.dataset.tile);
		cells.push({
			index,
			x: (inner.left - outer.left) / outer.width,
			y: (inner.top - outer.top) / outer.height,
			w: inner.width / outer.width,
			h: inner.height / outer.height,
			camera: null,
		});
	}
	return { cells, ratio: outer.width / outer.height };
}

type OpenMenu = MenuTrigger & {
	cells: TileCell[];
	ratio: number;
	/** Set when a form supplies its own items, which skips the wall's menus. */
	spec: MenuSpec | null;
};

function refFromUrl(state: AppState): ViewRef {
	const key = new URLSearchParams(location.search).get("view");
	return allRefs(state).find((ref) => refKey(ref) === key) ?? { kind: "all" };
}

/** A link can open playback: ?replay=<camera>, and &at=2026-11-07T14:03:22 for one moment. */
function replayFromUrl(state: AppState): { camera: CameraId | null; at: Moment | null } {
	const params = new URLSearchParams(location.search);
	const camera = state.cameras.find((c) => c.id === params.get("replay") && c.hasReplay);
	return { camera: camera?.id ?? null, at: camera ? parseMoment(params.get("at")) : null };
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
	const [menu, setMenu] = useState<OpenMenu | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [restarts, setRestarts] = useState<ReadonlyMap<CameraId, number>>(new Map());
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [linked] = useState(() => replayFromUrl(state));
	const [replay, setReplay] = useState<CameraId | null>(linked.camera);
	/** Where playback opens. Only a link sets it, and leaving playback forgets it. */
	const [replayAt, setReplayAt] = useState<Moment | null>(linked.at);
	const replayControls = useRef<ReplayControls>(null);
	const box = useRef<HTMLDivElement>(null);
	const compact = useMedia("(max-width: 720px)");

	useEffect(() => dispatch({ type: "sync", state }), [state]);

	const cameras = useMemo(() => new Map(state.cameras.map((c) => [c.id, c])), [state.cameras]);
	const resolved = resolveRef(wall.ref, state);
	const pages = compact ? 1 : pageCount(wall);
	// A camera whose recorder was unlinked in Settings has nothing left to play.
	const replayCamera = replay !== null && cameras.get(replay)?.hasReplay ? replay : null;
	const canReplay = state.cameras.some((c) => c.hasReplay);

	const key = refKey(wall.ref);
	useEffect(() => {
		const url = new URL(location.href);
		url.searchParams.set("view", key);
		if (replayCamera) url.searchParams.set("replay", replayCamera);
		else url.searchParams.delete("replay");
		// A moment is for opening a link. Kept, it would send a reload back to it.
		url.searchParams.delete("at");
		history.replaceState(null, "", url);
	}, [key, replayCamera]);

	const leaveReplay = useCallback(() => {
		setReplay(null);
		setReplayAt(null);
	}, []);

	/** Playback starts with the camera you are looking at, if it has footage. */
	const replayTarget = (): CameraId | null => {
		const recorded = (id: CameraId | null | undefined) =>
			id && cameras.get(id)?.hasReplay ? id : null;
		return (
			recorded(wall.focused) ??
			recorded(wall.selected === null ? null : wall.slots[wall.selected]) ??
			wall.slots.find((id) => recorded(id) !== null) ??
			state.cameras.find((c) => c.hasReplay)?.id ??
			null
		);
	};

	const changeMode = (mode: Mode) => {
		if (mode === "live") {
			leaveReplay();
			return;
		}
		const camera = replayTarget();
		if (camera) setReplay(camera);
	};

	const open = useCallback(
		(ref: ViewRef) => {
			leaveReplay();
			dispatch({ type: "open", ref, state });
			setDrawerOpen(false);
		},
		[state, leaveReplay],
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

	// The tour waits while a menu is open, so the wall does not change under it.
	const touring = tour && menu === null && replayCamera === null;
	useEffect(() => {
		if (!touring) return;
		const timer = setInterval(stepTour, tourSeconds * 1000);
		return () => clearInterval(timer);
	}, [touring, tourSeconds, stepTour]);

	useEffect(() => {
		if (toast === null) return;
		const timer = setTimeout(() => setToast(null), 2400);
		return () => clearTimeout(timer);
	}, [toast]);

	useEffect(() => {
		const update = () => setIsFullscreen(document.fullscreenElement !== null);
		document.addEventListener("fullscreenchange", update);
		return () => document.removeEventListener("fullscreenchange", update);
	}, []);

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

	const tileVideo = useCallback((index: number) => {
		const video = box.current?.querySelector(`[data-tile="${index}"] video`);
		return video instanceof HTMLVideoElement ? video : null;
	}, []);

	const snapshot = useCallback(
		(index: number) => {
			const camera = index === FULL_TILE ? wall.focused : wall.slots[index];
			const video = tileVideo(index);
			if (camera && video) saveSnapshot({ video, name: cameras.get(camera)?.name ?? camera });
		},
		[wall.slots, wall.focused, cameras, tileVideo],
	);

	const openMenu = useCallback((trigger: MenuTrigger, spec: MenuSpec | null = null) => {
		const { target } = trigger;
		if (target.kind === "tile" && target.index !== FULL_TILE) {
			dispatch({ type: "select", index: target.index });
		}
		setMenu({ ...trigger, ...readCells(box.current), spec });
	}, []);

	const closeMenu = useCallback(() => setMenu(null), []);

	useMenuTriggers({
		open: openMenu,
		busy: () => dragging !== null,
		keyboardAnchor: () => {
			if (replayCamera) return box.current?.querySelector(".replay") ?? box.current;
			const tile = wall.focused ? FULL_TILE : wall.selected;
			return (tile !== null && box.current?.querySelector(`[data-tile="${tile}"]`)) || box.current;
		},
	});

	// A menu speaks about one wall, so it goes when that wall does.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these are the triggers
	useEffect(() => setMenu(null), [key, wall.page, wall.focused, replayCamera]);

	useEffect(() => {
		const anchor = menu?.anchor;
		anchor?.setAttribute("data-menu-open", "");
		return () => anchor?.removeAttribute("data-menu-open");
	}, [menu?.anchor]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target;
			const typing =
				target instanceof HTMLElement &&
				(target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
			if (typing || menu || document.querySelector("dialog[open]")) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;

			// Playback has its own keys. These are the ones that belong to the whole page.
			const jump = Number(event.key);
			const ref = Number.isInteger(jump) && jump > 0 ? allRefs(state)[jump - 1] : null;
			switch (event.key) {
				case "f":
					fullscreen();
					event.preventDefault();
					return;
				case "b":
					toggleRail();
					event.preventDefault();
					return;
				case "?":
					setHelp(true);
					event.preventDefault();
					return;
				default:
					if (ref) {
						open(ref);
						event.preventDefault();
						return;
					}
			}
			if (replayCamera) {
				if (event.key === "p") {
					leaveReplay();
					event.preventDefault();
				}
				return;
			}

			const first = wall.page * cellsPerPage(wall);
			const last = first + cellsPerPage(wall) - 1;
			const step = (delta: number) => {
				if (wall.focused) {
					const next = neighbour(wall, delta);
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
					if (wall.focused) snapshot(FULL_TILE);
					else if (wall.selected !== null) snapshot(wall.selected);
					break;
				case "p": {
					const camera = replayTarget();
					if (!camera) return;
					setReplay(camera);
					break;
				}
				case "t":
					setTour((value) => !value);
					break;
				default:
					return;
			}
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

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

	const onDragEnd = ({ active, over, delta, activatorEvent }: DragEndEvent) => {
		setDragging(null);
		// Holding a finger still lifts a tile before the menu timer fires, so letting go
		// without moving asks for the menu. A drag that goes somewhere still drags.
		const touched = "TouchEvent" in window && activatorEvent instanceof TouchEvent;
		if (touched && Math.hypot(delta.x, delta.y) < 8) {
			const touch = activatorEvent.touches[0];
			const element = activatorEvent.target;
			if (touch && element instanceof Element) {
				const trigger = triggerAt(element, touch.clientX, touch.clientY);
				if (trigger) openMenu(trigger);
			}
			return;
		}
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
		if (replayCamera) {
			if (!cameras.get(camera)?.hasReplay) {
				setToast(`${cameras.get(camera)?.name ?? "That camera"} has no recorder linked`);
				return;
			}
			setDrawerOpen(false);
			setReplay(camera);
			return;
		}
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

	const toggleFit = () =>
		setFit((value) => {
			const next = value === "fit" ? "fill" : "fit";
			writePref("fit", next);
			return next;
		});

	const tourEvery = (seconds: TourSeconds) => {
		setTourSeconds(seconds);
		writePref("tourSeconds", String(seconds));
	};

	const toggleGroup = (name: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (!next.delete(name)) next.add(name);
			return next;
		});

	const report = (work: Promise<boolean>, done: string, failed: string) => {
		work.then(
			(ok) => setToast(ok ? done : failed),
			() => setToast(failed),
		);
	};

	const copyMoment = () => {
		const status = replayControls.current?.status();
		if (!status?.day) return;
		const url = new URL(location.href);
		url.searchParams.set("replay", status.camera);
		url.searchParams.set("at", momentText({ day: status.day, ms: status.position }));
		report(copyText(url.href), "Link copied", "Copying the link failed");
	};

	const replayMenu = (camera: CameraId): ReplayMenu => {
		const controls = () => replayControls.current;
		const video = () => controls()?.video() ?? null;
		return {
			read: () =>
				controls()?.status() ?? {
					camera,
					day: null,
					position: 0,
					playing: false,
					rate: 1,
					quality: "main",
					hasFrame: false,
				},
			run: {
				toggle: () => controls()?.toggle(),
				skip: (ms) => controls()?.skip(ms),
				rate: (rate) => controls()?.setRate(rate),
				quality: (quality) => controls()?.setQuality(quality),
				step: (delta) => controls()?.step(delta),
				snapshot: () => {
					const element = video();
					if (element) saveSnapshot({ video: element, name: cameras.get(camera)?.name ?? camera });
				},
				copySnapshot: () => {
					const element = video();
					if (element) {
						report(copySnapshot(element), "Snapshot copied", "Copying the snapshot failed");
					}
				},
				copyLink: copyMoment,
				live: () => {
					leaveReplay();
					dispatch({ type: "focus", camera });
				},
				leave: leaveReplay,
			},
		};
	};

	const menuContext: WallMenuContext = {
		state,
		wall,
		choices,
		pages: wall.focused ? 1 : pages,
		fit,
		tour,
		tourSeconds,
		railVisible: compact ? drawerOpen : railOpen,
		fullscreen: isFullscreen,
		collapsed,
		can: {
			copyImage: canCopyImage(),
			popOut: document.pictureInPictureEnabled === true,
		},
		hasFrame: (index) => (tileVideo(index)?.videoWidth ?? 0) > 0,
		replay: replayCamera ? replayMenu(replayCamera) : null,
		run: {
			// These change the wall, and Settings or playback would hide the result.
			dispatch: (action) => {
				setSettings(null);
				leaveReplay();
				dispatch(action);
			},
			commit,
			open: (ref) => {
				setSettings(null);
				open(ref);
			},
			removeCamera: (camera) => {
				api.removeCamera(camera).then(onLoaded, () => setToast("That camera stayed: no answer."));
			},
			replay: (camera) => {
				setSettings(null);
				setReplay(camera);
			},
			snapshot,
			copySnapshot: (index) => {
				const video = tileVideo(index);
				if (video) report(copySnapshot(video), "Snapshot copied", "Copying the snapshot failed");
			},
			popOut: (index) => {
				tileVideo(index)
					?.requestPictureInPicture()
					.catch(() => setToast("This browser refused to pop out the picture"));
			},
			reconnect: (list) => {
				setRestarts((previous) => {
					const next = new Map(previous);
					for (const camera of list) next.set(camera, (next.get(camera) ?? 0) + 1);
					return next;
				});
			},
			choose: (camera, choice) => setChoices((previous) => new Map(previous).set(camera, choice)),
			save: saveCurrent,
			saveAs,
			revert: () => open(wall.ref),
			toggleFit,
			toggleTour: () => setTour((value) => !value),
			tourEvery,
			toggleRail,
			toggleFullscreen: fullscreen,
			help: () => setHelp(true),
			addCameras: () => setSettings("Add cameras"),
			settings: () => setSettings("Cameras"),
			copyLink: (ref) => {
				const url = new URL(location.href);
				url.searchParams.set("view", refKey(ref));
				report(copyText(url.href), "Link copied", "Copying the link failed");
			},
			collapse: (keys) => setCollapsed(new Set(keys)),
		},
	};

	const shell = ["app"];
	if (!railOpen) shell.push("app-no-rail");
	const title = replayCamera
		? (cameras.get(replayCamera)?.name ?? "Camera")
		: wall.focused
			? (cameras.get(wall.focused)?.name ?? "Camera")
			: (resolved?.name ?? "All cameras");
	const titleMenu = replayCamera
		? menuId.replay
		: wall.focused
			? menuId.camera(wall.focused)
			: menuId.view(wall.ref);

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
					replay={replayCamera}
					dragging={dragging !== null}
					collapsed={collapsed}
					onToggle={toggleGroup}
					onOpen={open}
					onPick={pickCamera}
					onAdd={() => setSettings("Add cameras")}
					onSettings={() => setSettings("Cameras")}
				/>
				<TopBar
					mode={replayCamera ? "replay" : "live"}
					canReplay={canReplay}
					onMode={changeMode}
					title={title}
					titleMenu={titleMenu}
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
					onFit={toggleFit}
					onTour={() => setTour((value) => !value)}
					onTourSeconds={tourEvery}
					onSave={saveCurrent}
					onSaveAs={() => setNaming(true)}
					onRevert={() => open(wall.ref)}
					onFullscreen={fullscreen}
					onHelp={() => setHelp(true)}
				/>
				<main
					className={compact && !wall.focused ? "wall wall-scroll" : "wall"}
					ref={box}
					data-menu={menuId.wall}
				>
					{replayCamera ? (
						<ReplayView
							camera={replayCamera}
							cameras={state.cameras.filter((camera) => camera.hasReplay)}
							at={replayAt}
							controls={replayControls}
							onCamera={setReplay}
							onClose={leaveReplay}
						/>
					) : state.cameras.length === 0 ? (
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
							restarts={restarts}
							onSelect={(index) =>
								dispatch({ type: "select", index: wall.selected === index ? null : index })
							}
							onFocus={(camera) => dispatch({ type: "focus", camera })}
							onClear={(index) => dispatch({ type: "assign", index, camera: null })}
							onChoice={(camera, choice) =>
								setChoices((previous) => new Map(previous).set(camera, choice))
							}
							onReplay={setReplay}
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
					onMenu={(event, spec) => {
						event.preventDefault();
						const trigger = triggerAt(event.currentTarget, event.clientX, event.clientY);
						openMenu(
							trigger ?? {
								target: { kind: "wall" },
								x: event.clientX,
								y: event.clientY,
								anchor: event.currentTarget,
								keyboard: false,
							},
							spec,
						);
					}}
					onClose={() => setSettings(null)}
				/>
			)}
			{help && (
				<Dialog title="Keyboard shortcuts" onClose={() => setHelp(false)}>
					{SHORTCUTS.map((section) => (
						<section key={section.title} className="keys-section">
							<h3 className="keys-title">{section.title}</h3>
							<dl className="keys">
								{section.keys.map(([keys, action]) => (
									<div key={keys}>
										<dt>{keys}</dt>
										<dd>{action}</dd>
									</div>
								))}
							</dl>
						</section>
					))}
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
			{menu && (
				<WallMenu
					target={menu.target}
					spec={menu.spec}
					x={menu.x}
					y={menu.y}
					keyboard={menu.keyboard}
					sheet={compact}
					cells={menu.cells}
					ratio={menu.ratio}
					context={menuContext}
					onClose={closeMenu}
				/>
			)}
			{toast && (
				<output className="toast" aria-live="polite">
					{toast}
				</output>
			)}
		</DndContext>
	);
}
