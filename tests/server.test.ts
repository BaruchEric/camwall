import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp, originAllowed, type SocketData } from "@/server/app";
import { startFakeRecorder } from "@/server/dvr/fake";
import { Go2rtc } from "@/server/go2rtc";
import { Store } from "@/server/store";
import { CameraId } from "@/shared/schema";

type Upstream = { url: string };

let dir: string;
let store: Store;
let app: Server<SocketData>;
let fake: Server<Upstream>;
let base: string;
const opened: string[] = [];
const said: string[] = [];

const seed = {
	version: 1,
	groups: [],
	views: [],
	cameras: [
		{ id: "door", name: "Door", groupId: null, main: "rtsp://u:secret@192.0.2.1/1", sub: null },
	],
};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "camwall-"));
	await writeFile(join(dir, "config.json"), JSON.stringify(seed));
	await mkdir(join(dir, "www"));
	await writeFile(join(dir, "www", "index.html"), "<title>Camwall</title>");
	store = await Store.open({ dir, allowVirtual: false });

	fake = Bun.serve<Upstream>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, server) {
			const url = request.url;
			if (server.upgrade(request, { data: { url } })) return undefined;
			return Response.json({});
		},
		websocket: {
			open(ws) {
				opened.push(ws.data.url);
			},
			message(ws, message) {
				said.push(String(message));
				ws.send('{"type":"mse","value":"video/mp4"}');
				ws.send(new Uint8Array([1, 2, 3]));
			},
		},
	});

	const go2rtc = new Go2rtc(`http://127.0.0.1:${fake.port}`);
	app = Bun.serve<SocketData>({
		port: 0,
		hostname: "127.0.0.1",
		...createApp({
			store,
			go2rtc,
			staticDir: join(dir, "www"),
			allowedOrigins: ["https://wall.example"],
		}),
	});
	base = `http://127.0.0.1:${app.port}`;
});

afterAll(async () => {
	app.stop(true);
	fake.stop(true);
	await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

function connect(path: string): Promise<{ code: number | "open"; socket: WebSocket }> {
	return new Promise((resolve) => {
		const socket = new WebSocket(`${base.replace("http", "ws")}${path}`);
		socket.onopen = () => resolve({ code: "open", socket });
		socket.onerror = () => resolve({ code: 0, socket });
	});
}

describe("state", () => {
	test("hides stream addresses from the browser", async () => {
		const text = await (await fetch(`${base}/api/state`)).text();
		expect(text).toContain("Door");
		expect(text).not.toContain("secret");
		expect(text).not.toContain("rtsp");
	});

	test("a saved edit lands on disk", async () => {
		const response = await fetch(`${base}/api/state`, {
			method: "PUT",
			body: JSON.stringify({
				cameras: [{ id: "door", name: "Front door", groupId: null }],
				groups: [],
				views: [],
			}),
		});
		expect(response.status).toBe(200);
		const saved = await Bun.file(join(dir, "config.json")).json();
		expect(saved.cameras[0].name).toBe("Front door");
		expect(saved.cameras[0].main).toBe("rtsp://u:secret@192.0.2.1/1");
	});

	test("a bad edit changes nothing", async () => {
		const response = await fetch(`${base}/api/state`, { method: "PUT", body: "{}" });
		expect(response.status).toBe(400);
	});
});

describe("adding cameras", () => {
	test.each(["exec:id", "ffmpeg:rtsp://h/1", "rtsp://h/1#raw=x", "echo:hello"])(
		"refuses %s",
		async (main) => {
			const response = await post("/api/cameras", { cameras: [{ name: "Bad", main }] });
			expect(response.status).toBe(400);
			expect(store.config.cameras.some((c) => c.name === "Bad")).toBe(false);
		},
	);

	test("adds an RTSP camera and folds in the password", async () => {
		const response = await post("/api/cameras", {
			cameras: [{ name: "Yard", main: "rtsp://192.0.2.2/1" }],
			user: "admin",
			password: "p#1",
		});
		expect(response.status).toBe(201);
		expect(store.config.cameras.find((c) => c.id === "yard")?.main).toBe(
			"rtsp://admin:p%231@192.0.2.2/1",
		);
	});

	test("removes a camera", async () => {
		await fetch(`${base}/api/cameras/yard`, { method: "DELETE" });
		expect(store.config.cameras.some((c) => c.id === "yard")).toBe(false);
	});
});

describe("origin", () => {
	const request = (origin: string | null, host = "wall.local:8090") =>
		new Request("http://x/", {
			headers: origin ? { origin, host } : { host },
		});

	test("same host passes", () => {
		expect(originAllowed(request("https://wall.local:8090"), [])).toBe(true);
	});

	test("a listed origin passes", () => {
		expect(originAllowed(request("https://wall.example"), ["https://wall.example"])).toBe(true);
	});

	test("a foreign page fails", () => {
		expect(originAllowed(request("https://evil.example"), [])).toBe(false);
	});

	test("a foreign page cannot write", async () => {
		const response = await post(
			"/api/cameras",
			{ cameras: [{ name: "Evil", main: "rtsp://h/1" }] },
			{ Origin: "https://evil.example" },
		);
		expect(response.status).toBe(403);
	});

	test("a foreign page cannot open a stream", async () => {
		const response = await fetch(`${base}/ws/door/sub`, {
			headers: {
				Origin: "https://evil.example",
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		expect(response.status).toBe(403);
	});
});

describe("stream proxy", () => {
	test("maps a camera to its go2rtc stream", async () => {
		const { socket } = await connect("/ws/door/sub");
		const chunks: unknown[] = [];
		const done = new Promise<void>((resolve) => {
			socket.binaryType = "arraybuffer";
			socket.onmessage = (event) => {
				chunks.push(event.data);
				if (chunks.length === 2) resolve();
			};
		});
		socket.send('{"type":"mse","value":"avc1.640029"}');
		await done;
		expect(opened.at(-1)).toContain("src=door_sub");
		expect(chunks[0]).toBe('{"type":"mse","value":"video/mp4"}');
		expect(chunks[1]).toBeInstanceOf(ArrayBuffer);
		socket.close();
	});

	test("forwards nothing but the codec list", async () => {
		const { socket } = await connect("/ws/door/main");
		const before = said.length;
		socket.send('{"type":"webrtc/offer","value":"x"}');
		socket.send("not json");
		await Bun.sleep(100);
		expect(said.length).toBe(before);
		socket.close();
	});

	test.each([
		"/ws/nobody/sub",
		"/ws/door/hd",
		"/ws/exec:id/sub",
		"/ws/door/sub/extra",
		"/ws/rtsp%3A%2F%2Fh%2F1/sub",
	])("refuses %s", async (path) => {
		const response = await fetch(`${base}${path}`);
		expect(response.status).toBe(404);
	});

	test("go2rtc's own API is not reachable through the app", async () => {
		const response = await fetch(`${base}/api/streams?src=exec:id`);
		expect(response.status).toBe(404);
		const socket = await fetch(`${base}/api/ws?src=exec:id`);
		expect(socket.status).toBe(404);
	});
});

describe("recorders", () => {
	let recorder: TcpServer;
	let port: number;

	beforeAll(async () => {
		recorder = await startFakeRecorder(join(import.meta.dir, "../demo"), 0);
		const address = recorder.address();
		port = typeof address === "object" && address ? address.port : 0;
		await store.update((config) => ({
			...config,
			cameras: [
				...config.cameras,
				{
					id: CameraId.parse("yard"),
					name: "Yard",
					groupId: null,
					main: "rtsp://127.0.0.1/mainStream2",
					sub: null,
					replay: null,
				},
			],
		}));
	});

	afterAll(() => {
		recorder.close();
	});

	const post = (body: unknown) =>
		fetch(`${base}/api/recorders`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	test("one that refuses the connection is not saved", async () => {
		const response = await post({ name: "Gone", host: "127.0.0.1", port: 1, password: "" });
		expect(response.status).toBe(502);
		expect(store.config.recorders).toHaveLength(0);
	});

	test("adding one links cameras on its address and keeps its password from the browser", async () => {
		const response = await post({
			name: "Back room",
			host: "127.0.0.1",
			port,
			password: "hunter2",
		});
		expect(response.status).toBe(201);
		const text = await response.text();
		expect(text).not.toContain("hunter2");
		expect(text).not.toContain("127.0.0.1");
		const state = JSON.parse(text);
		expect(state.recorders).toEqual([{ id: "back-room", name: "Back room", cameras: 1 }]);
		const yard = state.cameras.find((camera: { id: string }) => camera.id === "yard");
		expect(yard.hasReplay).toBe(true);
		expect(yard.replay).toBeUndefined();
	});

	test("a linked camera lists its days and a day's recordings", async () => {
		const days = await (await fetch(`${base}/api/replay/yard/days`)).json();
		expect(days.days.length).toBeGreaterThan(0);
		const day = days.days.at(-1);
		const spans = await (await fetch(`${base}/api/replay/yard/day/${day}`)).json();
		expect(spans.spans.length).toBeGreaterThan(0);
	});

	test("a camera with no recorder has nothing to list", async () => {
		expect((await fetch(`${base}/api/replay/door/days`)).status).toBe(404);
	});

	test("a date that is not a date is refused", async () => {
		expect((await fetch(`${base}/api/replay/yard/day/yesterday`)).status).toBe(400);
	});

	const replayStatus = (path: string, headers?: Record<string, string>) =>
		fetch(`${base}/ws/replay/${path}`, {
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				...headers,
			},
		}).then((response) => response.status);

	test("a replay socket refuses a foreign page", async () => {
		const status = await replayStatus("yard/sub?day=2026-11-06&ms=0", {
			origin: "https://evil.example",
		});
		expect(status).toBe(403);
	});

	test("a replay socket refuses a bad day, a bad time and an unlinked camera", async () => {
		expect(await replayStatus("yard/sub?day=soon&ms=0")).toBe(404);
		expect(await replayStatus("yard/sub?day=2026-11-06&ms=90000000")).toBe(404);
		expect(await replayStatus("yard/best?day=2026-11-06&ms=0")).toBe(404);
		expect(await replayStatus("door/sub?day=2026-11-06&ms=0")).toBe(404);
	});

	test("removing one takes the links with it", async () => {
		const response = await fetch(`${base}/api/recorders/back-room`, { method: "DELETE" });
		const state = await response.json();
		expect(state.recorders).toEqual([]);
		expect(state.cameras.every((c: { hasReplay: boolean }) => !c.hasReplay)).toBe(true);
	});
});

describe("static files", () => {
	test("serves the page with a CSP", async () => {
		const response = await fetch(`${base}/`);
		expect(await response.text()).toContain("Camwall");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
	});

	test("does not walk out of the folder", async () => {
		const response = await fetch(`${base}/..%2fconfig.json`);
		expect(await response.text()).not.toContain("secret");
		const dots = await fetch(`${base}/%2e%2e/config.json`);
		expect(await dots.text()).not.toContain("secret");
	});
});
