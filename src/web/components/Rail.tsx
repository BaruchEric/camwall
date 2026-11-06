import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, LayoutGrid, Plus, Search, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import type { AppState, CameraId, GroupId, PublicCamera } from "@/shared/schema";
import type { PlayerState } from "@/web/lib/player";
import { useStatuses } from "@/web/lib/status";
import { dragId, refKey, type ViewRef } from "@/web/lib/wall";

function CameraRow({
	camera,
	state,
	onPick,
}: {
	camera: PublicCamera;
	state: PlayerState | undefined;
	onPick: (camera: CameraId) => void;
}) {
	const { setNodeRef, listeners, isDragging } = useDraggable({ id: dragId.camera(camera.id) });
	return (
		<li>
			<button
				type="button"
				ref={setNodeRef}
				className={isDragging ? "rail-camera rail-camera-dragging" : "rail-camera"}
				data-state={state ?? "idle"}
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
	collapsed: boolean;
	onToggle: () => void;
	onOpen: (ref: ViewRef) => void;
	onPick: (camera: CameraId) => void;
}) {
	const { setNodeRef, isOver } = useDroppable({ id: dragId.group(id) });
	const live = cameras.filter((c) => statuses.get(c.id) === "live").length;
	return (
		<section ref={setNodeRef} className={isOver ? "rail-group rail-group-over" : "rail-group"}>
			<div className={refKey(viewRef) === current ? "rail-row rail-row-on" : "rail-row"}>
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
	dragging,
	onOpen,
	onPick,
	onAdd,
	onSettings,
}: {
	state: AppState;
	current: string;
	open: boolean;
	dragging: boolean;
	onOpen: (ref: ViewRef) => void;
	onPick: (camera: CameraId) => void;
	onAdd: () => void;
	onSettings: () => void;
}) {
	const statuses = useStatuses();
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

	const matching = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle === ""
			? state.cameras
			: state.cameras.filter((c) => c.name.toLowerCase().includes(needle));
	}, [state.cameras, query]);

	const toggle = (key: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (!next.delete(key)) next.add(key);
			return next;
		});

	const ungrouped = matching.filter((c) => c.groupId === null);
	const searching = query.trim() !== "";

	return (
		<aside className={open ? "rail rail-open" : "rail"} aria-label="Cameras and views">
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
				<div className={current === "all" ? "rail-row rail-row-on" : "rail-row"}>
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
						collapsed={!searching && collapsed.has(group.id)}
						onToggle={() => toggle(group.id)}
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
						collapsed={!searching && collapsed.has("ungrouped")}
						onToggle={() => toggle("ungrouped")}
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
