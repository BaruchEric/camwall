import { join, normalize, sep } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { z } from "zod";
import { readDays, readSpans, testRecorder } from "@/server/dvr/client";
import { type Go2rtc, streamName } from "@/server/go2rtc";
import { log } from "@/server/log";
import { discover } from "@/server/onvif";
import { ReplaySession } from "@/server/replay";
import type { Store } from "@/server/store";
import {
	applyPatch,
	type Camera,
	CameraId,
	type Config,
	DAY_MS,
	Day,
	DiscoverRequest,
	ImportRequest,
	linkCameras,
	NewRecorder,
	Quality,
	type Recorder,
	RecorderId,
	ReplayCommand,
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

type LiveSocket = {
	kind: "live";
	target: string;
	upstream: WebSocket | null;
	hello: string | null;
};

type ReplaySocket = {
	kind: "replay";
	source: { recorder: Recorder; channel: number; quality: Quality; day: string; ms: number };
	session: ReplaySession | null;
};

export type SocketData = LiveSocket | ReplaySocket;

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

/** A camera's recorder and channel, if it has recordings. */
function replaySource(config: Config, id: string | undefined) {
	const camera = config.cameras.find((c) => c.id === id);
	const recorder = config.recorders.find((r) => r.id === camera?.replay?.recorder);
	return camera?.replay && recorder ? { recorder, channel: camera.replay.channel } : null;
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
						replay: null,
					};
				});
				const all = [...config.cameras, ...added];
				return {
					...config,
					cameras: config.recorders.reduce((list, r) => linkCameras(list, r), all),
				};
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

		if (route === "POST /api/recorders") {
			const body = NewRecorder.safeParse(await readJson(request));
			if (!body.success) return problem(firstIssue(body.error), 400);
			try {
				await testRecorder(body.data);
			} catch (error) {
				const message = error instanceof Error ? error.message : "The recorder did not answer";
				return problem(message, 502);
			}
			const next = await store.update((config) => {
				const taken = new Set<string>(config.recorders.map((r) => r.id));
				const id = RecorderId.parse(uniqueSlug(body.data.name, taken));
				const recorder: Recorder = { ...body.data, id };
				return {
					...config,
					recorders: [...config.recorders, recorder],
					cameras: linkCameras(config.cameras, recorder),
				};
			});
			return json(toPublic(next), 201);
		}

		const forget = /^\/api\/recorders\/([^/]+)$/.exec(pathname);
		if (request.method === "DELETE" && forget) {
			const next = await store.update((config) => ({
				...config,
				recorders: config.recorders.filter((r) => r.id !== forget[1]),
			}));
			return json(toPublic(next));
		}

		const days = /^\/api\/replay\/([^/]+)\/days$/.exec(pathname);
		const spans = /^\/api\/replay\/([^/]+)\/day\/([^/]+)$/.exec(pathname);
		if (request.method === "GET" && (days || spans)) {
			const source = replaySource(store.config, (days ?? spans)?.[1]);
			if (!source) return problem("That camera has no recordings", 404);
			try {
				if (days) return json({ days: await readDays(source.recorder) });
				const day = Day.safeParse(spans?.[2]);
				if (!day.success) return problem("Use a date like 2026-01-31", 400);
				return json({ spans: await readSpans(source.recorder, day.data, source.channel) });
			} catch (error) {
				const message = error instanceof Error ? error.message : "The recorder did not answer";
				return problem(message, 502);
			}
		}

		return problem("Not found", 404);
	}

	function upgradeReplay(
		request: Request,
		server: Server<SocketData>,
		url: URL,
		match: RegExpExecArray,
	): Response | undefined {
		const source = replaySource(store.config, match[1]);
		if (!source) return problem("That camera has no recordings", 404);
		const quality = Quality.safeParse(match[2]);
		const day = Day.safeParse(url.searchParams.get("day"));
		const ms = Number(url.searchParams.get("ms"));
		if (!quality.success || !day.success || !Number.isInteger(ms) || ms < 0 || ms >= DAY_MS) {
			return problem("Not found", 404);
		}
		const data: SocketData = {
			kind: "replay",
			source: { ...source, quality: quality.data, day: day.data, ms },
			session: null,
		};
		return server.upgrade(request, { data }) ? undefined : problem("Upgrade failed", 400);
	}

	function upgrade(request: Request, server: Server<SocketData>, url: URL): Response | undefined {
		const replay = /^\/ws\/replay\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		if (replay) return upgradeReplay(request, server, url, replay);
		const match = /^\/ws\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		const id = CameraId.safeParse(match?.[1]);
		const quality = Quality.safeParse(match?.[2]);
		if (!id.success || !quality.success) return problem("Not found", 404);
		if (!store.config.cameras.some((c) => c.id === id.data)) return problem("No such camera", 404);
		const target = go2rtc.wsUrl(streamName(id.data, quality.data));
		const data: SocketData = { kind: "live", target, upstream: null, hello: null };
		return server.upgrade(request, { data }) ? undefined : problem("Upgrade failed", 400);
	}

	function openReplaySocket(ws: ServerWebSocket<SocketData>, data: ReplaySocket): void {
		const { recorder, channel, quality, day, ms } = data.source;
		const session = new ReplaySession(
			{ address: recorder, channel, quality, day, ms },
			{
				event: (event) => ws.send(JSON.stringify(event)),
				bytes: (bytes) => ws.sendBinary(bytes),
				queued: () => ws.getBufferedAmount(),
				close: () => ws.close(),
			},
		);
		data.session = session;
		void session.start();
	}

	function replayMessage(data: ReplaySocket, message: string | Buffer): void {
		if (typeof message !== "string") return;
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		const command = ReplayCommand.safeParse(parsed);
		if (command.success) data.session?.handle(command.data);
	}

	const websocket: WebSocketHandler<SocketData> = {
		open(ws: ServerWebSocket<SocketData>) {
			const { data } = ws;
			if (data.kind === "replay") {
				openReplaySocket(ws, data);
				return;
			}
			const upstream = new WebSocket(data.target);
			upstream.binaryType = "arraybuffer";
			data.upstream = upstream;
			upstream.onopen = () => {
				if (data.hello !== null) upstream.send(data.hello);
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
			const { data } = ws;
			if (data.kind === "replay") {
				replayMessage(data, message);
				return;
			}
			if (typeof message !== "string") return;
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(message);
			} catch {
				return;
			}
			// The only thing a viewer may say to go2rtc: which codecs it can play.
			if (!MseHello.safeParse(parsed).success) return;
			const { upstream } = data;
			if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
			else data.hello = message;
		},
		close(ws: ServerWebSocket<SocketData>) {
			const { data } = ws;
			if (data.kind === "replay") data.session?.stop();
			else data.upstream?.close();
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
