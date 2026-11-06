import { useSyncExternalStore } from "react";
import type { CameraId, Quality } from "@/shared/schema";
import type { PlayerState } from "@/web/lib/player";

export const STATE_TEXT: Record<PlayerState, string> = {
	idle: "Paused",
	waiting: "Waiting",
	connecting: "Connecting",
	live: "Live",
	retrying: "No signal, retrying",
};

export function rateText(quality: Quality, kbps: number): string {
	const rate = kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`;
	return `${quality === "main" ? "HD" : "SD"} ${rate}`;
}

/** Which cameras are playing, for the rail and the header. A camera can sit in two tiles. */
const tiles = new Map<number, { camera: CameraId; state: PlayerState }>();
let snapshot: ReadonlyMap<CameraId, PlayerState> = new Map();
const listeners = new Set<() => void>();
/** The last rate each tile showed. Read on demand, so a new figure redraws nothing. */
const rates = new Map<number, string>();

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

export function reportRate(tile: number, text: string): void {
	rates.set(tile, text);
}

export function tileRate(tile: number): string | null {
	return rates.get(tile) ?? null;
}

export function clearTile(tile: number): void {
	tiles.delete(tile);
	rates.delete(tile);
	publish();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useStatuses(): ReadonlyMap<CameraId, PlayerState> {
	return useSyncExternalStore(subscribe, () => snapshot);
}
