import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Config, emptyConfig, isRtspUrl, reconcile } from "@/shared/schema";

export type StoreOptions = { dir: string; allowVirtual: boolean };

/** Rejects any source go2rtc could run as a command. Demo sources are ffmpeg test patterns. */
export function assertSources(config: Config, allowVirtual: boolean): void {
	const allowed = (src: string) =>
		isRtspUrl(src) || (allowVirtual && src.startsWith("ffmpeg:virtual?"));
	for (const camera of config.cameras) {
		if (!allowed(camera.main) || (camera.sub !== null && !allowed(camera.sub))) {
			throw new Error(`Camera ${camera.id} has a source that is not an rtsp:// address`);
		}
	}
}

/** Holds the config in memory and saves it atomically, one write at a time. */
export class Store {
	#config: Config;
	#path: string;
	#allowVirtual: boolean;
	#queue: Promise<unknown> = Promise.resolve();
	#listeners = new Set<(config: Config) => void>();

	private constructor(config: Config, path: string, allowVirtual: boolean) {
		this.#config = config;
		this.#path = path;
		this.#allowVirtual = allowVirtual;
	}

	static async open({ dir, allowVirtual }: StoreOptions): Promise<Store> {
		const path = join(dir, "config.json");
		const file = Bun.file(path);
		const config = (await file.exists())
			? reconcile(Config.parse(await file.json()))
			: emptyConfig();
		assertSources(config, allowVirtual);
		return new Store(config, path, allowVirtual);
	}

	get config(): Config {
		return this.#config;
	}

	onChange(listener: (config: Config) => void): void {
		this.#listeners.add(listener);
	}

	update(change: (config: Config) => Config): Promise<Config> {
		const run = async () => {
			const next = Config.parse(reconcile(change(this.#config)));
			assertSources(next, this.#allowVirtual);
			await mkdir(dirname(this.#path), { recursive: true });
			const temp = `${this.#path}.tmp`;
			await writeFile(temp, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			await rename(temp, this.#path);
			this.#config = next;
			for (const listener of this.#listeners) listener(next);
			return next;
		};
		const result = this.#queue.then(run, run);
		this.#queue = result.catch(() => undefined);
		return result;
	}
}
