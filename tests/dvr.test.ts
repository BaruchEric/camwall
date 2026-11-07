import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo, Server } from "node:net";
import { join } from "node:path";
import { minutesToSpans, readDays, readSpans, testRecorder } from "@/server/dvr/client";
import { framesOf, startFakeRecorder } from "@/server/dvr/fake";
import {
	encode,
	loginAccepted,
	loginBody,
	MessageReader,
	parseMonths,
	parseStatus,
	parseVideo,
	REPLAY,
	usedSlots,
	words,
} from "@/server/dvr/protocol";
import { nextRecorded, type ReplayOutput, ReplaySession } from "@/server/replay";
import { type Camera, channelOf, linkCameras, type Recorder, RecorderId } from "@/shared/schema";

const clips = join(import.meta.dir, "../demo");

describe("wire format", () => {
	test("a message survives being split across reads", () => {
		const wire = Buffer.concat([encode(4, 0x83), encode(4, 0x80, words(7))]);
		const reader = new MessageReader();
		expect(reader.push(wire.subarray(0, 11))).toHaveLength(1);
		const [message] = reader.push(wire.subarray(11));
		expect(message?.code).toBe(0x80);
		expect(message?.body.readUInt32BE(0)).toBe(7);
	});

	test("anything else on the socket is refused", () => {
		expect(() => new MessageReader().push(Buffer.from("HTTP/1.1 200 OK"))).toThrow();
	});

	test("the login matches what the vendor's client sends for admin with no password", () => {
		expect(loginBody("admin", "").toString("hex")).toBe(
			"0100000500000002c888d0000000000500000000" + "52364d2e02",
		);
	});

	test("a login reply says yes with a zero first word", () => {
		expect(loginAccepted(words(0, 1))).toBe(true);
		expect(loginAccepted(words(1, 1))).toBe(false);
	});

	test("months list the days that hold footage, by day of the month", () => {
		const entry = Buffer.concat([words(2026, 11), Buffer.alloc(128)]);
		entry.writeUInt32BE(1, 8 + 6 * 4);
		entry.writeUInt32BE(1, 8 + 30 * 4);
		expect(parseMonths(entry)).toEqual(["2026-11-06", "2026-11-30"]);
	});

	test("a slot counts if either recording kind has it, and bit 0 is slot 0", () => {
		const table = Buffer.alloc(512);
		table.writeBigUInt64BE(0b101n, 8 * 2);
		table.writeBigUInt64BE(0b1000n, 256 + 8 * 2);
		expect(usedSlots(table, 3, 60)).toEqual([0, 2, 3]);
		expect(usedSlots(table, 2, 60)).toEqual([]);
	});

	test("the status clock and date", () => {
		expect(parseStatus(words(0xf010605b, 20261106, 36240000, 1000, 0))).toEqual({
			date: 20261106,
			ms: 36240000,
		});
	});

	test("a video frame gives its channel, time, size and key flag", () => {
		const body = Buffer.alloc(20);
		body.writeUInt32BE(36240000, 0);
		body.writeUInt16BE(1920, 4);
		body.writeUInt16BE(1080, 6);
		body[8] = 1;
		const frame = parseVideo({ type: REPLAY, code: 0x65, body });
		expect(frame).toMatchObject({ channel: 6, ms: 36240000, width: 1920, height: 1080, key: true });
		expect(frame?.data).toHaveLength(4);
		expect(parseVideo({ type: REPLAY, code: 0x83, body })).toBeNull();
	});
});

describe("spans", () => {
	test("join minutes that touch", () => {
		expect(minutesToSpans([0, 1, 2, 10])).toEqual([
			[0, 180_000],
			[600_000, 660_000],
		]);
	});

	test("playback stays put inside a span and jumps across a gap", () => {
		const spans: [number, number][] = [
			[1000, 2000],
			[5000, 6000],
		];
		expect(nextRecorded(spans, 1500)).toBe(1500);
		expect(nextRecorded(spans, 3000)).toBe(5000);
		expect(nextRecorded(spans, 6000)).toBeNull();
	});
});

describe("linking cameras to a recorder", () => {
	const recorder: Recorder = {
		id: RecorderId.parse("store"),
		name: "Store",
		host: "10.0.0.5",
		port: 8780,
		user: "admin",
		password: "",
	};
	const camera = (main: string) => ({ main }) as Camera;

	test("reads a channel number from common RTSP paths", () => {
		expect(channelOf("rtsp://h:554/mainStream7")).toBe(7);
		expect(channelOf("rtsp://h/ch07/")).toBe(7);
		expect(channelOf("rtsp://h/live?channel=12")).toBe(12);
		expect(channelOf("rtsp://h/live")).toBeNull();
		expect(channelOf("rtsp://h/stream99")).toBeNull();
	});

	test("links only this host's cameras, and leaves a chosen channel alone", () => {
		const replay = { recorder: recorder.id, channel: 9 };
		const linked = linkCameras(
			[
				{ ...camera("rtsp://10.0.0.5/mainStream3"), replay: null },
				{ ...camera("rtsp://10.0.0.6/mainStream3"), replay: null },
				{ ...camera("rtsp://10.0.0.5/mainStream4"), replay },
			],
			recorder,
		);
		expect(linked.map((c) => c.replay?.channel ?? null)).toEqual([3, null, 9]);
	});
});

describe("against a fake recorder", () => {
	let server: Server;
	let address: { host: string; port: number; user: string; password: string };

	beforeAll(async () => {
		server = await startFakeRecorder(clips);
		const { port } = server.address() as AddressInfo;
		address = { host: "127.0.0.1", port, user: "admin", password: "" };
	});

	afterAll(() => {
		server.close();
	});

	const today = () => {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	};

	test("a login works, and a closed port says so", async () => {
		await testRecorder(address);
		await expect(testRecorder({ ...address, port: 1 })).rejects.toThrow();
	});

	test("the calendar ends today", async () => {
		const days = await readDays(address);
		expect(days).toHaveLength(4);
		expect(days.at(-1)).toBe(today());
	});

	test("a motion channel has one span an hour", async () => {
		const spans = await readSpans(address, today(), 2);
		expect(spans).toHaveLength(24);
		expect(spans[1]).toEqual([3_600_000, 4_200_000]);
	});

	function collect() {
		const events: string[] = [];
		const sent: Uint8Array[] = [];
		const out: ReplayOutput = {
			event: (event) => events.push(event.type),
			bytes: (data) => sent.push(data),
			queued: () => 0,
			close: () => undefined,
		};
		return { events, sent, out };
	}

	const until = async (done: () => boolean) => {
		for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(10);
		expect(done()).toBe(true);
	};

	test("a replay opens with the codec, then an init segment, then fragments", async () => {
		const { events, sent, out } = collect();
		const session = new ReplaySession(
			{ address, channel: 1, quality: "sub", day: today(), ms: 3_600_000 },
			out,
		);
		await session.start();
		await until(() => sent.length > 5);
		session.stop();
		expect(events[0]).toBe("mse");
		expect(Buffer.from(sent[0] ?? []).toString("latin1", 4, 8)).toBe("ftyp");
		expect(Buffer.from(sent[1] ?? []).toString("latin1", 4, 8)).toBe("moof");
	});

	test("it stops pulling once the viewer has enough, and resumes when the playhead moves", async () => {
		const { sent, out } = collect();
		const session = new ReplaySession(
			{ address, channel: 1, quality: "sub", day: today(), ms: 3_600_000 },
			out,
		);
		await session.start();
		await until(() => sent.length > 80);
		await Bun.sleep(150);
		const held = sent.length;
		await Bun.sleep(150);
		expect(sent.length).toBe(held);
		session.handle({ type: "at", ms: 3_660_000 });
		await until(() => sent.length > held);
		session.stop();
	});

	test("a seek is announced before the frames from the new spot", async () => {
		const { events, out } = collect();
		const session = new ReplaySession(
			{ address, channel: 1, quality: "sub", day: today(), ms: 0 },
			out,
		);
		await session.start();
		await until(() => events.includes("mse"));
		session.handle({ type: "seek", ms: 7_200_000 });
		await until(() => events.includes("seeked"));
		session.stop();
	});

	test("a channel that went quiet jumps to its next recording", async () => {
		const { sent, out } = collect();
		const session = new ReplaySession(
			{ address, channel: 2, quality: "sub", day: today(), ms: 590_000 },
			out,
		);
		await session.start();
		const newest = () => {
			const tfdt = Buffer.from(sent.at(-1) ?? []);
			const at = tfdt.indexOf("tfdt", 0, "latin1");
			return at < 0 ? 0 : tfdt.readUInt32BE(at + 12);
		};
		session.handle({ type: "at", ms: 600_000 });
		await until(() => newest() >= 3_600_000);
		session.stop();
	});

	test("the last recording of a day ends the replay", async () => {
		const { events, out } = collect();
		const session = new ReplaySession(
			{ address, channel: 2, quality: "sub", day: today(), ms: 83_395_000 },
			out,
		);
		await session.start();
		session.handle({ type: "at", ms: 83_400_000 });
		await until(() => events.includes("end"));
		session.stop();
	});
});

describe("the demo clips", () => {
	test("are cut into pictures, starting on a key frame", async () => {
		const clip = await Bun.file(join(clips, "clip-sub.h264")).arrayBuffer();
		const frames = framesOf(Buffer.from(clip));
		expect(frames.length).toBeGreaterThan(30);
		expect(frames[0]?.key).toBe(true);
	});
});
