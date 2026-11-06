import { type FormEvent, useState } from "react";
import {
	type AppState,
	type DiscoveredCamera,
	GroupId,
	NewCamera,
	uniqueSlug,
} from "@/shared/schema";
import { ConfirmButton, Dialog, NameField } from "@/web/components/ui";
import { api } from "@/web/lib/api";

export const SETTINGS_TABS = ["Cameras", "Groups", "Views", "Add cameras"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const message = (error: unknown) => (error instanceof Error ? error.message : "That did not work");

function GroupSelect({
	state,
	value,
	label,
	onChange,
}: {
	state: AppState;
	value: GroupId | null;
	label: string;
	onChange: (group: GroupId | null) => void;
}) {
	return (
		<select
			className="field"
			aria-label={label}
			value={value ?? ""}
			onChange={(event) => {
				const group = GroupId.safeParse(event.target.value);
				onChange(group.success ? group.data : null);
			}}
		>
			<option value="">No group</option>
			{state.groups.map((group) => (
				<option key={group.id} value={group.id}>
					{group.name}
				</option>
			))}
		</select>
	);
}

function CamerasTab({
	state,
	commit,
	onRemove,
}: {
	state: AppState;
	commit: (next: AppState) => void;
	onRemove: (id: string) => void;
}) {
	if (state.cameras.length === 0) return <p className="hint">No cameras yet.</p>;
	return (
		<ul className="rows">
			{state.cameras.map((camera) => (
				<li key={camera.id} className="row">
					<NameField
						label="Camera name"
						value={camera.name}
						onSave={(name) =>
							commit({
								...state,
								cameras: state.cameras.map((c) => (c.id === camera.id ? { ...c, name } : c)),
							})
						}
					/>
					<GroupSelect
						state={state}
						label={`Group for ${camera.name}`}
						value={camera.groupId}
						onChange={(groupId) =>
							commit({
								...state,
								cameras: state.cameras.map((c) => (c.id === camera.id ? { ...c, groupId } : c)),
							})
						}
					/>
					<ConfirmButton label="Remove" onConfirm={() => onRemove(camera.id)} />
				</li>
			))}
		</ul>
	);
}

function GroupsTab({ state, commit }: { state: AppState; commit: (next: AppState) => void }) {
	const [name, setName] = useState("");
	const add = (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed === "") return;
		const id = GroupId.parse(uniqueSlug(trimmed, new Set(state.groups.map((g) => g.id))));
		commit({ ...state, groups: [...state.groups, { id, name: trimmed }] });
		setName("");
	};
	return (
		<>
			<form className="inline-form" onSubmit={add}>
				<input
					className="field"
					placeholder="New group name"
					aria-label="New group name"
					maxLength={60}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<button type="submit" className="button button-primary">
					Add group
				</button>
			</form>
			<ul className="rows">
				{state.groups.map((group) => (
					<li key={group.id} className="row row-two">
						<NameField
							label="Group name"
							value={group.name}
							onSave={(next) =>
								commit({
									...state,
									groups: state.groups.map((g) => (g.id === group.id ? { ...g, name: next } : g)),
								})
							}
						/>
						<span className="row-note">
							{state.cameras.filter((c) => c.groupId === group.id).length} cameras
						</span>
						<ConfirmButton
							label="Remove"
							onConfirm={() =>
								commit({
									...state,
									groups: state.groups.filter((g) => g.id !== group.id),
									cameras: state.cameras.map((c) =>
										c.groupId === group.id ? { ...c, groupId: null } : c,
									),
								})
							}
						/>
					</li>
				))}
			</ul>
			<p className="hint">
				Removing a group keeps its cameras. Drag a camera onto a group to file it.
			</p>
		</>
	);
}

function ViewsTab({ state, commit }: { state: AppState; commit: (next: AppState) => void }) {
	if (state.views.length === 0) {
		return (
			<p className="hint">Arrange the wall, then choose Save as view. Saved views appear here.</p>
		);
	}
	return (
		<ul className="rows">
			{state.views.map((view) => (
				<li key={view.id} className="row row-two">
					<NameField
						label="View name"
						value={view.name}
						onSave={(name) =>
							commit({
								...state,
								views: state.views.map((v) => (v.id === view.id ? { ...v, name } : v)),
							})
						}
					/>
					<span className="row-note">{view.slots.filter(Boolean).length} cameras</span>
					<ConfirmButton
						label="Remove"
						onConfirm={() =>
							commit({ ...state, views: state.views.filter((v) => v.id !== view.id) })
						}
					/>
				</li>
			))}
		</ul>
	);
}

function DiscoverForm({ state, onAdded }: { state: AppState; onAdded: (next: AppState) => void }) {
	const [host, setHost] = useState("");
	const [port, setPort] = useState("80");
	const [user, setUser] = useState("");
	const [password, setPassword] = useState("");
	const [found, setFound] = useState<DiscoveredCamera[] | null>(null);
	const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
	const [groupId, setGroupId] = useState<GroupId | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const find = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		setFound(null);
		try {
			const cameras = await api.discover({ host, port: Number(port), user, password });
			setFound(cameras);
			setPicked(new Set(cameras.map((_, i) => i)));
		} catch (cause) {
			setError(message(cause));
		} finally {
			setBusy(false);
		}
	};

	const add = async () => {
		if (!found) return;
		setBusy(true);
		setError(null);
		try {
			const cameras = found
				.filter((_, i) => picked.has(i))
				.map((c) => NewCamera.parse({ name: c.name, main: c.main, sub: c.sub, groupId }));
			onAdded(await api.addCameras({ cameras, user, password }));
			setFound(null);
		} catch (cause) {
			setError(message(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section>
			<h3>Find cameras on a recorder or camera</h3>
			<p className="hint">Works with anything that speaks ONVIF, which most recorders do.</p>
			<form className="form-grid" onSubmit={find}>
				<label>
					Address
					<input
						className="field"
						required
						placeholder="192.0.2.10"
						value={host}
						onChange={(event) => setHost(event.target.value)}
					/>
				</label>
				<label>
					Port
					<input
						className="field"
						inputMode="numeric"
						value={port}
						onChange={(event) => setPort(event.target.value)}
					/>
				</label>
				<label>
					User name
					<input
						className="field"
						autoComplete="off"
						value={user}
						onChange={(event) => setUser(event.target.value)}
					/>
				</label>
				<label>
					Password
					<input
						className="field"
						type="password"
						autoComplete="off"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
				</label>
				<button type="submit" className="button button-primary" disabled={busy}>
					{busy && !found ? "Looking" : "Find cameras"}
				</button>
			</form>
			{found && (
				<div className="found">
					{found.length === 0 ? (
						<p className="hint">The device answered but listed no video streams.</p>
					) : (
						<>
							<ul className="found-list">
								{found.map((camera, i) => (
									<li key={camera.main}>
										<label>
											<input
												type="checkbox"
												checked={picked.has(i)}
												onChange={() => {
													const next = new Set(picked);
													if (!next.delete(i)) next.add(i);
													setPicked(next);
												}}
											/>
											{camera.name}
											{camera.width !== null && (
												<span className="row-note">
													{camera.width} by {camera.height}
												</span>
											)}
										</label>
									</li>
								))}
							</ul>
							<div className="inline-form">
								<GroupSelect
									state={state}
									label="Group for these cameras"
									value={groupId}
									onChange={setGroupId}
								/>
								<button
									type="button"
									className="button button-primary"
									disabled={busy || picked.size === 0}
									onClick={add}
								>
									Add {picked.size} {picked.size === 1 ? "camera" : "cameras"}
								</button>
							</div>
						</>
					)}
				</div>
			)}
			{error && <p className="error">{error}</p>}
		</section>
	);
}

function ManualForm({ state, onAdded }: { state: AppState; onAdded: (next: AppState) => void }) {
	const [name, setName] = useState("");
	const [main, setMain] = useState("");
	const [sub, setSub] = useState("");
	const [groupId, setGroupId] = useState<GroupId | null>(null);
	const [error, setError] = useState<string | null>(null);

	const add = async (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		const camera = NewCamera.safeParse({ name, main, sub: sub === "" ? null : sub, groupId });
		if (!camera.success) {
			setError(camera.error.issues[0]?.message ?? "Check the addresses");
			return;
		}
		try {
			onAdded(await api.addCameras({ cameras: [camera.data], user: "", password: "" }));
			setName("");
			setMain("");
			setSub("");
		} catch (cause) {
			setError(message(cause));
		}
	};

	return (
		<section>
			<h3>Add one by address</h3>
			<form className="form-stack" onSubmit={add}>
				<label>
					Name
					<input
						className="field"
						required
						maxLength={60}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label>
					Stream address
					<input
						className="field"
						required
						placeholder="rtsp://192.0.2.10:554/stream1"
						value={main}
						onChange={(event) => setMain(event.target.value)}
					/>
				</label>
				<label>
					Low resolution stream address, if the camera has one
					<input
						className="field"
						placeholder="rtsp://192.0.2.10:554/stream2"
						value={sub}
						onChange={(event) => setSub(event.target.value)}
					/>
				</label>
				<div className="inline-form">
					<GroupSelect state={state} label="Group" value={groupId} onChange={setGroupId} />
					<button type="submit" className="button button-primary">
						Add camera
					</button>
				</div>
			</form>
			{error && <p className="error">{error}</p>}
		</section>
	);
}

export function SettingsDialog({
	state,
	initialTab,
	commit,
	onLoaded,
	onClose,
}: {
	state: AppState;
	initialTab: SettingsTab;
	commit: (next: AppState) => void;
	onLoaded: (next: AppState) => void;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<SettingsTab>(initialTab);
	const [error, setError] = useState<string | null>(null);
	const remove = (id: string) => {
		setError(null);
		api.removeCamera(id).then(onLoaded, (cause: unknown) => setError(message(cause)));
	};
	return (
		<Dialog title="Settings" wide onClose={onClose}>
			<div className="tabs" role="tablist">
				{SETTINGS_TABS.map((name) => (
					<button
						key={name}
						type="button"
						role="tab"
						aria-selected={tab === name}
						className={tab === name ? "tab tab-on" : "tab"}
						onClick={() => setTab(name)}
					>
						{name}
					</button>
				))}
			</div>
			<div className="tab-body">
				{error && <p className="error">{error}</p>}
				{tab === "Cameras" && <CamerasTab state={state} commit={commit} onRemove={remove} />}
				{tab === "Groups" && <GroupsTab state={state} commit={commit} />}
				{tab === "Views" && <ViewsTab state={state} commit={commit} />}
				{tab === "Add cameras" && (
					<div className="add-columns">
						<DiscoverForm state={state} onAdded={onLoaded} />
						<ManualForm state={state} onAdded={onLoaded} />
					</div>
				)}
			</div>
		</Dialog>
	);
}
