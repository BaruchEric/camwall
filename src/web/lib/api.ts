import { z } from "zod";
import {
	AppState,
	type DiscoveredCamera,
	type DiscoverRequest,
	DiscoverResponse,
	type NewCamera,
	type NewRecorder,
	ReplayDays,
	ReplaySpans,
	type StatePatch,
} from "@/shared/schema";

const ErrorBody = z.object({ error: z.string() });

async function call<T>({
	path,
	schema,
	init,
}: {
	path: string;
	schema: z.ZodType<T>;
	init?: RequestInit;
}): Promise<T> {
	const response = await fetch(path, init);
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const parsed = ErrorBody.safeParse(body);
		throw new Error(parsed.success ? parsed.data.error : `The server answered ${response.status}`);
	}
	return schema.parse(body);
}

const send = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

export const api = {
	state: () => call({ path: "/api/state", schema: AppState }),
	saveState: (patch: StatePatch) =>
		call({ path: "/api/state", schema: AppState, init: send("PUT", patch) }),
	addCameras: (body: { cameras: NewCamera[]; user: string; password: string }) =>
		call({ path: "/api/cameras", schema: AppState, init: send("POST", body) }),
	removeCamera: (id: string) =>
		call({
			path: `/api/cameras/${encodeURIComponent(id)}`,
			schema: AppState,
			init: { method: "DELETE" },
		}),
	addRecorder: (body: NewRecorder) =>
		call({ path: "/api/recorders", schema: AppState, init: send("POST", body) }),
	removeRecorder: (id: string) =>
		call({
			path: `/api/recorders/${encodeURIComponent(id)}`,
			schema: AppState,
			init: { method: "DELETE" },
		}),
	replayDays: async (camera: string): Promise<string[]> => {
		const path = `/api/replay/${encodeURIComponent(camera)}/days`;
		return (await call({ path, schema: ReplayDays })).days;
	},
	replaySpans: async (camera: string, day: string) => {
		const path = `/api/replay/${encodeURIComponent(camera)}/day/${day}`;
		return (await call({ path, schema: ReplaySpans })).spans;
	},
	discover: async (body: DiscoverRequest): Promise<DiscoveredCamera[]> => {
		const { cameras } = await call({
			path: "/api/discover",
			schema: DiscoverResponse,
			init: send("POST", body),
		});
		return cameras;
	},
};
