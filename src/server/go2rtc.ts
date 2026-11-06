import { log } from "@/server/log";
import type { CameraId, Config, Quality } from "@/shared/schema";

export function streamName(id: CameraId, quality: Quality): string {
	return `${id}_${quality}`;
}

/** Audio stays out: a camera wall rarely has the right to carry conversations. */
function withOptions(source: string): string {
	return source.startsWith("ffmpeg:") ? source : `${source}#media=video`;
}

export function wantedStreams(config: Config): Map<string, string> {
	const wanted = new Map<string, string>();
	for (const camera of config.cameras) {
		wanted.set(streamName(camera.id, "main"), withOptions(camera.main));
		wanted.set(streamName(camera.id, "sub"), withOptions(camera.sub ?? camera.main));
	}
	return wanted;
}

export type SyncPlan = { put: [string, string][]; remove: string[] };

export function planSync({
	wanted,
	existing,
	applied,
}: {
	wanted: ReadonlyMap<string, string>;
	existing: ReadonlySet<string>;
	applied: ReadonlyMap<string, string>;
}): SyncPlan {
	const put = [...wanted].filter(([name, src]) => !existing.has(name) || applied.get(name) !== src);
	const remove = [...existing].filter((name) => !wanted.has(name));
	return { put, remove };
}

/** Keeps go2rtc's stream list equal to the config. go2rtc forgets it on restart. */
export class Go2rtc {
	#base: string;
	#applied = new Map<string, string>();
	#running = false;
	#again: Config | null = null;

	constructor(base: string) {
		this.#base = base.replace(/\/$/, "");
	}

	wsUrl(name: string): string {
		return `${this.#base.replace(/^http/, "ws")}/api/ws?src=${encodeURIComponent(name)}`;
	}

	async sync(config: Config): Promise<void> {
		if (this.#running) {
			this.#again = config;
			return;
		}
		this.#running = true;
		try {
			const response = await fetch(`${this.#base}/api/streams`);
			if (!response.ok) throw new Error(`go2rtc answered ${response.status}`);
			const body: unknown = await response.json();
			const existing = new Set(typeof body === "object" && body ? Object.keys(body) : []);
			const wanted = wantedStreams(config);
			const { put, remove } = planSync({ wanted, existing, applied: this.#applied });
			for (const [name, src] of put) {
				const query = new URLSearchParams({ name, src });
				await fetch(`${this.#base}/api/streams?${query}`, { method: "PUT" });
				this.#applied.set(name, src);
			}
			for (const name of remove) {
				const query = new URLSearchParams({ src: name });
				await fetch(`${this.#base}/api/streams?${query}`, { method: "DELETE" });
				this.#applied.delete(name);
			}
			if (put.length + remove.length > 0) {
				log.info("streams synced", { added: put.length, removed: remove.length });
			}
		} catch (error) {
			log.warn("go2rtc not reachable", { error: String(error) });
		} finally {
			this.#running = false;
			const next = this.#again;
			this.#again = null;
			if (next) void this.sync(next);
		}
	}
}
