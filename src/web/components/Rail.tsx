import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, LayoutGrid, Plus, Search, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import type { AppState, CameraId, GroupId, PublicCamera } from "@/shared/schema";
import type { PlayerState } from "@/web/lib/player";
import { useStatuses } from "@/web/lib/status";
import { dragId, menuId, refKey, type ViewRef } from "@/web/lib/wall";

function CameraRow({
	camera,
	state,
	replay,
	onPick,
}: {
	camera: PublicCamera;
	state: PlayerState | undefined;
	replay: CameraId | null;
	onPick: (camera: CameraId) => void;
}) {
	const { setNodeRef, listeners, isDragging } = useDraggable({ id: dragId.camera(camera.id) });
	const classes = ["rail-camera"];
	if (isDragging) classes.push("rail-camera-dragging");
	if (replay === camera.id) classes.push("rail-camera-on");
	const unrecorded = replay !== null && !camera.hasReplay;
	return (
		<li>
			<button
				type="button"
				ref={setNodeRef}
				className={classes.join(" ")}
				data-state={state ?? "idle"}
				data-replay={unrecorded ? "none" : undefined}
				data-menu={menuId.camera(camera.id)}
				aria-current={replay === camera.id ? "true" : undefined}
				title={unrecorded ? "No recorder linked, so nothing to play back" : undefined}
				onClick={() => onPick(camera.id)}
				{...listeners}
			>
				<span className="tally" aria-hidden="true" />
				<span className="rail-name">{camera.name}</span>
			</button>
		</li>
	);
}

function GroupSection({
	id,
	name,
	viewRef,
	current,
	cameras,
	statuses,
	replay,
	collapsed,
	onToggle,
	onOpen,
	onPick,
}: {
	id: GroupId | null;
	name: string;
	viewRef: ViewRef;
	current: string;
	cameras: PublicCamera[];
	statuses: ReadonlyMap<CameraId, PlayerState>;
	replay: CameraId | null;
	collapsed: boolean;
	onToggle: () => void;
	onOpen: (ref: ViewRef) => void;
	onPick: (camera: CameraId) => void;
}) {
	const { setNodeRef, isOver } = useDroppable({ id: dragId.group(id) });
	const live = cameras.filter((c) => statuses.get(c.id) === "live").length;
	return (
		<section ref={setNodeRef} className={isOver ? "rail-group rail-group-over" : "rail-group"}>
			<div
				className={refKey(viewRef) === current ? "rail-row rail-row-on" : "rail-row"}
				data-menu={menuId.group(id)}
			>
				<button
					type="button"
					className="rail-chevron"
					aria-expanded={!collapsed}
					aria-label={`${collapsed ? "Show" : "Hide"} cameras in ${name}`}
					onClick={onToggle}
				>
					{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
				</button>
				<button type="button" className="rail-view" onClick={() => onOpen(viewRef)}>
					<span className="rail-name">{name}</span>
					<span className="rail-count">
						{live > 0 ? `${live} of ${cameras.length}` : cameras.length}
					</span>
				</button>
			</div>
			{!collapsed && (
				<ul className="rail-cameras">
					{cameras.map((camera) => (
						<CameraRow
							key={camera.id}
							camera={camera}
							state={statuses.get(camera.id)}
							replay={replay}
							onPick={onPick}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

export function Rail({
	state,
	current,
	open,
	replay,
	dragging,
	collapsed,
	onToggle,
	onOpen,
	onPick,
	onAdd,
	onSettings,
}: {
	state: AppState;
	current: string;
	open: boolean;
	/** The camera in playback. The list then picks what plays. */
	replay: CameraId | null;
	dragging: boolean;
	collapsed: ReadonlySet<string>;
	onToggle: (key: string) => void;
	onOpen: (ref: ViewRef) => void;
	onPick: (camera: CameraId) => void;
	onAdd: () => void;
	onSettings: () => void;
}) {
	const statuses = useStatuses();
	const [query, setQuery] = useState("");

	const matching = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle === ""
			? state.cameras
			: state.cameras.filter((c) => c.name.toLowerCase().includes(needle));
	}, [state.cameras, query]);

	const ungrouped = matching.filter((c) => c.groupId === null);
	const searching = query.trim() !== "";

	return (
		<aside
			className={open ? "rail rail-open" : "rail"}
			aria-label="Cameras and views"
			data-menu={menuId.rail}
		>
			<div className="rail-brand">Camwall</div>
			<label className="rail-search">
				<Search size={14} aria-hidden="true" />
				<input
					type="search"
					placeholder="Find a camera"
					aria-label="Find a camera"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</label>
			<nav className="rail-scroll">
				<div
					className={current === "all" ? "rail-row rail-row-on" : "rail-row"}
					data-menu={menuId.view({ kind: "all" })}
				>
					<span className="rail-chevron" aria-hidden="true">
						<LayoutGrid size={14} />
					</span>
					<button type="button" className="rail-view" onClick={() => onOpen({ kind: "all" })}>
						<span className="rail-name">All cameras</span>
						<span className="rail-count">{state.cameras.length}</span>
					</button>
				</div>
				{state.views.map((view) => {
					const ref: ViewRef = { kind: "saved", id: view.id };
					return (
						<div
							key={view.id}
							className={refKey(ref) === current ? "rail-row rail-row-on" : "rail-row"}
							data-menu={menuId.view(ref)}
						>
							<span className="rail-chevron" aria-hidden="true">
								<LayoutGrid size={14} />
							</span>
							<button type="button" className="rail-view" onClick={() => onOpen(ref)}>
								<span className="rail-name">{view.name}</span>
							</button>
						</div>
					);
				})}
				<hr className="rail-rule" />
				{state.groups.map((group) => (
					<GroupSection
						key={group.id}
						id={group.id}
						name={group.name}
						viewRef={{ kind: "group", id: group.id }}
						current={current}
						cameras={matching.filter((c) => c.groupId === group.id)}
						statuses={statuses}
						replay={replay}
						collapsed={!searching && collapsed.has(group.id)}
						onToggle={() => onToggle(group.id)}
						onOpen={onOpen}
						onPick={onPick}
					/>
				))}
				{(ungrouped.length > 0 || dragging) && (
					<GroupSection
						id={null}
						name={state.groups.length > 0 ? "Ungrouped" : "Cameras"}
						viewRef={state.groups.length > 0 ? { kind: "ungrouped" } : { kind: "all" }}
						current={current}
						cameras={ungrouped}
						statuses={statuses}
						replay={replay}
						collapsed={!searching && collapsed.has("ungrouped")}
						onToggle={() => onToggle("ungrouped")}
						onOpen={onOpen}
						onPick={onPick}
					/>
				)}
			</nav>
			<div className="rail-foot">
				<button type="button" className="button button-quiet" onClick={onAdd}>
					<Plus size={14} aria-hidden="true" /> Add cameras
				</button>
				<button
					type="button"
					className="icon-button"
					aria-label="Settings"
					title="Settings"
					onClick={onSettings}
				>
					<Settings size={16} />
				</button>
			</div>
		</aside>
	);
}
