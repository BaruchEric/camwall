import { useSyncExternalStore } from "react";
import type { CameraId } from "@/shared/schema";
import type { PlayerState } from "@/web/lib/player";

/** Which cameras are playing, for the rail and the header. A camera can sit in two tiles. */
const tiles = new Map<number, { camera: CameraId; state: PlayerState }>();
let snapshot: ReadonlyMap<CameraId, PlayerState> = new Map();
const listeners = new Set<() => void>();

const rank: Record<PlayerState, number> = {
	idle: 0,
	waiting: 1,
	connecting: 2,
	retrying: 3,
	live: 4,
};

function publish(): void {
	const next = new Map<CameraId, PlayerState>();
	for (const { camera, state } of tiles.values()) {
		const seen = next.get(camera);
		if (seen === undefined || rank[state] > rank[seen]) next.set(camera, state);
	}
	snapshot = next;
	for (const listener of listeners) listener();
}

export function reportTile({
	tile,
	camera,
	state,
}: {
	tile: number;
	camera: CameraId;
	state: PlayerState;
}): void {
	tiles.set(tile, { camera, state });
	publish();
}

export function clearTile(tile: number): void {
	tiles.delete(tile);
	publish();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useStatuses(): ReadonlyMap<CameraId, PlayerState> {
	return useSyncExternalStore(subscribe, () => snapshot);
}
