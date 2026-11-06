import { join, normalize, sep } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import { type Go2rtc, streamName } from "@/server/go2rtc";
import { log } from "@/server/log";
import { discover } from "@/server/onvif";
import type { Store } from "@/server/store";
import {
	applyPatch,
	type Camera,
	CameraId,
	DiscoverRequest,
	ImportRequest,
	Quality,
	StatePatch,
	toPublic,
	uniqueSlug,
	withCredentials,
} from "@/shared/schema";

/** A viewer this far behind gets dropped and reconnects at the live edge. */
const MAX_BUFFERED = 8 * 1024 * 1024;

const CSP = [
	"default-src 'self'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"connect-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
].join("; ");

const MseHello = z.object({ type: z.literal("mse"), value: z.string().max(512) });

export type SocketData = {
	target: string;
	upstream: WebSocket | null;
	hello: string | null;
};

export type AppDeps = {
	store: Store;
	go2rtc: Go2rtc;
	staticDir: string;
	allowedOrigins: readonly string[];
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

const problem = (message: string, status: number) => json({ error: message }, status);

/** A browser always sends Origin on a write or a websocket, so a foreign page is caught here. */
export function originAllowed(request: Request, allowed: readonly string[]): boolean {
	const origin = request.headers.get("origin");
	if (origin === null) return true;
	if (allowed.includes(origin)) return true;
	try {
		return new URL(origin).host === request.headers.get("host");
	} catch {
		return false;
	}
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return null;
	}
}

function firstIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	return issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request";
}

export function createApp({ store, go2rtc, staticDir, allowedOrigins }: AppDeps) {
	const root = normalize(staticDir);

	async function serveStatic(pathname: string): Promise<Response> {
		const path = normalize(join(root, pathname));
		const file = path.startsWith(root + sep) ? Bun.file(path) : null;
		const found = file !== null && pathname !== "/" && (await file.exists());
		const body = found ? file : Bun.file(join(root, "index.html"));
		if (!found && !(await body.exists())) {
			return new Response("Run bun run build first.", { status: 503 });
		}
		const cache = pathname.startsWith("/assets/")
			? "public, max-age=31536000, immutable"
			: "no-cache";
		return new Response(body, {
			headers: {
				"Cache-Control": cache,
				"Content-Security-Policy": CSP,
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
			},
		});
	}

	async function api(request: Request, url: URL): Promise<Response> {
		const { pathname } = url;
		const route = `${request.method} ${pathname}`;

		if (route === "GET /api/state") return json(toPublic(store.config));

		if (route === "PUT /api/state") {
			const patch = StatePatch.safeParse(await readJson(request));
			if (!patch.success) return problem(firstIssue(patch.error), 400);
			const next = await store.update((config) => applyPatch(config, patch.data));
			return json(toPublic(next));
		}

		if (route === "POST /api/cameras") {
			const body = ImportRequest.safeParse(await readJson(request));
			if (!body.success) return problem(firstIssue(body.error), 400);
			const { cameras, user, password } = body.data;
			const next = await store.update((config) => {
				const taken = new Set<string>(config.cameras.map((c) => c.id));
				const added: Camera[] = cameras.map((camera) => {
					const slug = uniqueSlug(camera.name, taken);
					taken.add(slug);
					return {
						...camera,
						id: CameraId.parse(slug),
						main: withCredentials(camera.main, user, password),
						sub: camera.sub === null ? null : withCredentials(camera.sub, user, password),
					};
				});
				return { ...config, cameras: [...config.cameras, ...added] };
			});
			return json(toPublic(next), 201);
		}

		const remove = /^\/api\/cameras\/([^/]+)$/.exec(pathname);
		if (request.method === "DELETE" && remove) {
			const next = await store.update((config) => ({
				...config,
				cameras: config.cameras.filter((c) => c.id !== remove[1]),
			}));
			return json(toPublic(next));
		}

		if (route === "POST /api/discover") {
			const body = DiscoverRequest.safeParse(await readJson(request));
			if (!body.success) return problem(firstIssue(body.error), 400);
			try {
				return json({ cameras: await discover(body.data) });
			} catch (error) {
				const message = error instanceof Error ? error.message : "The device did not answer";
				return problem(message, 502);
			}
		}

		return problem("Not found", 404);
	}

	function upgrade(request: Request, server: Server<SocketData>, url: URL): Response | undefined {
		const match = /^\/ws\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		const id = CameraId.safeParse(match?.[1]);
		const quality = Quality.safeParse(match?.[2]);
		if (!id.success || !quality.success) return problem("Not found", 404);
		if (!store.config.cameras.some((c) => c.id === id.data)) return problem("No such camera", 404);
		const target = go2rtc.wsUrl(streamName(id.data, quality.data));
		const data: SocketData = { target, upstream: null, hello: null };
		return server.upgrade(request, { data }) ? undefined : problem("Upgrade failed", 400);
	}

	const websocket: WebSocketHandler<SocketData> = {
		open(ws: ServerWebSocket<SocketData>) {
			const upstream = new WebSocket(ws.data.target);
			upstream.binaryType = "arraybuffer";
			ws.data.upstream = upstream;
			upstream.onopen = () => {
				if (ws.data.hello !== null) upstream.send(ws.data.hello);
			};
			upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
				if (ws.getBufferedAmount() > MAX_BUFFERED) {
					ws.close(1013, "viewer too slow");
					return;
				}
				ws.send(event.data);
			};
			upstream.onclose = () => ws.close();
			upstream.onerror = () => ws.close();
		},
		message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
			if (typeof message !== "string") return;
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(message);
			} catch {
				return;
			}
			// The only thing a viewer may say to go2rtc: which codecs it can play.
			if (!MseHello.safeParse(parsed).success) return;
			const { upstream } = ws.data;
			if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
			else ws.data.hello = message;
		},
		close(ws: ServerWebSocket<SocketData>) {
			ws.data.upstream?.close();
		},
	};

	async function fetchHandler(
		request: Request,
		server: Server<SocketData>,
	): Promise<Response | undefined> {
		const url = new URL(request.url);
		const { pathname } = url;
		if (pathname === "/healthz") return new Response("ok");
		const writes = !["GET", "HEAD"].includes(request.method);
		const isSocket = pathname.startsWith("/ws/");
		if ((writes || isSocket) && !originAllowed(request, allowedOrigins)) {
			log.warn("refused origin", { origin: request.headers.get("origin"), pathname });
			return problem("Origin not allowed", 403);
		}
		if (isSocket) return upgrade(request, server, url);
		if (pathname.startsWith("/api/")) {
			try {
				return await api(request, url);
			} catch (error) {
				log.error("request failed", { pathname, error: String(error) });
				return problem(error instanceof Error ? error.message : "Request failed", 400);
			}
		}
		return serveStatic(pathname);
	}

	return { fetch: fetchHandler, websocket };
}
