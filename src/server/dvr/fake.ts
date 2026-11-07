/**
 * A recorder for the demo stack and the tests. It speaks enough of the real protocol to replay
 * a looping test pattern, which keeps real footage out of this repository.
 *
 *   bun src/server/dvr/fake.ts [port]
 */
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	Code,
	Control,
	encode,
	type Message,
	MessageReader,
	PULL_MS,
	REPLAY,
	SYSTEM,
	VIDEO_BASE,
	words,
} from "@/server/dvr/protocol";
import { splitNals } from "@/server/fmp4";

const CHANNELS = 32;
const DATE_ID = 1473;
const FRAME_MS = 1000 / 15;
const DAYS_BACK = 3;
const HOUR_MINUTES = 60;

export type FakeFrame = { data: Buffer; key: boolean };

/** Annex B cut into one entry per picture, parameter sets staying with their key frame. */
export function framesOf(clip: Buffer): FakeFrame[] {
	const frames: FakeFrame[] = [];
	let pending: Uint8Array[] = [];
	const startCode = Buffer.from([0, 0, 0, 1]);
	for (const nal of splitNals(clip)) {
		pending.push(startCode, nal);
		const type = (nal[0] ?? 0) & 0x1f;
		if (type === 1 || type === 5) {
			frames.push({ data: Buffer.concat(pending), key: type === 5 });
			pending = [];
		}
	}
	return frames;
}

type Clips = { main: FakeFrame[]; sub: FakeFrame[] };

/** Channel 2 records for ten minutes each hour. Every other channel records the whole day. */
export function isRecorded(channel: number, minuteOfDay: number): boolean {
	return channel !== 2 || minuteOfDay % HOUR_MINUTES < 10;
}

function minuteMasks(hour: number): Buffer {
	const table = Buffer.alloc(512);
	for (let channel = 1; channel <= CHANNELS; channel++) {
		let mask = 0n;
		for (let minute = 0; minute < HOUR_MINUTES; minute++) {
			if (isRecorded(channel, hour * HOUR_MINUTES + minute)) mask |= 1n << BigInt(minute);
		}
		table.writeBigUInt64BE(mask, (channel - 1) * 8);
	}
	return table;
}

function hourMasks(): Buffer {
	const table = Buffer.alloc(512);
	for (let channel = 1; channel <= CHANNELS; channel++) {
		table.writeBigUInt64BE((1n << 24n) - 1n, (channel - 1) * 8);
	}
	return table;
}

function monthEntries(now: Date): Buffer {
	const months = new Map<string, Buffer>();
	for (let back = DAYS_BACK; back >= 0; back--) {
		const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
		const key = `${date.getFullYear()}-${date.getMonth()}`;
		const entry =
			months.get(key) ??
			Buffer.concat([words(date.getFullYear(), date.getMonth() + 1), Buffer.alloc(128)]);
		entry.writeUInt32BE(1, 8 + date.getDate() * 4);
		months.set(key, entry);
	}
	return Buffer.concat([...months.values()]);
}

function monthCount(now: Date): number {
	const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - DAYS_BACK);
	return oldest.getMonth() === now.getMonth() ? 1 : 2;
}

class Session {
	#socket: Socket;
	#clips: Clips;
	#reader = new MessageReader();
	#clock = 0;
	#nextFrame = 0;
	/** Every channel in the last mask, played on one clock the way the real recorder does. */
	#channels: number[] = [];
	#quality: keyof Clips = "sub";

	constructor(socket: Socket, clips: Clips) {
		this.#socket = socket;
		this.#clips = clips;
		socket.on("data", (chunk) => {
			for (const message of this.#reader.push(Buffer.from(chunk))) this.#handle(message);
		});
		socket.on("error", () => socket.destroy());
	}

	#send(type: number, code: number, body?: Buffer): void {
		this.#socket.write(encode(type, code, body));
	}

	#handle({ type, code, body }: Message): void {
		if (type === SYSTEM) {
			if (code === Code.login) this.#send(SYSTEM, Code.login, words(0, 0x01000005, 0x8000001f));
			else this.#send(SYSTEM, code, Buffer.alloc(4));
			return;
		}
		if (type !== REPLAY) return;
		const now = new Date();
		switch (code) {
			case Code.calendar:
				this.#send(
					REPLAY,
					code,
					words(
						0,
						monthCount(now),
						DAYS_BACK + 1,
						now.getFullYear(),
						now.getMonth() + 1,
						now.getDate(),
					),
				);
				break;
			case Code.months:
				this.#send(REPLAY, code, monthEntries(now));
				break;
			case Code.date:
				this.#send(REPLAY, code, words(CHANNELS, DATE_ID, 0));
				break;
			case Code.dayHours:
				this.#send(REPLAY, code, hourMasks());
				break;
			case Code.hourMinutes:
				this.#send(REPLAY, code, minuteMasks(body.readUInt32BE(0)));
				break;
			case Code.open:
				this.#send(REPLAY, code, Buffer.alloc(328));
				break;
			case Code.control:
				this.#control(body);
				break;
			case Code.pull:
				this.#pull();
				break;
			default:
				break;
		}
	}

	#control(body: Buffer): void {
		const flags = body.readUInt32BE(0);
		const main = body.readUInt32BE(20);
		const sub = body.readUInt32BE(32);
		if (main !== 0 || sub !== 0) {
			this.#quality = main !== 0 ? "main" : "sub";
			const mask = main || sub;
			this.#channels = [];
			for (let channel = 1; channel <= CHANNELS; channel++) {
				if ((mask >>> (channel - 1)) & 1) this.#channels.push(channel);
			}
		}
		if (flags === Control.seek) {
			this.#clock = body.readUInt32BE(8);
			this.#nextFrame = this.#clock - (this.#clock % 1000);
		}
		this.#send(REPLAY, Code.control, body.subarray(0, 28));
	}

	#pull(): void {
		this.#clock += PULL_MS;
		const clips = this.#clips[this.#quality];
		while (this.#channels.length > 0 && this.#nextFrame <= this.#clock) {
			const ms = Math.round(this.#nextFrame);
			const index = Math.round(ms / FRAME_MS) % clips.length;
			const frame = clips[index];
			for (const channel of this.#channels) {
				if (!frame || !isRecorded(channel, Math.floor(ms / 60_000))) continue;
				const head = Buffer.alloc(16);
				head.writeUInt32BE(ms, 0);
				head.writeUInt16BE(this.#quality === "main" ? 1280 : 640, 4);
				head.writeUInt16BE(this.#quality === "main" ? 720 : 352, 6);
				head[8] = frame.key ? 1 : 0;
				this.#send(REPLAY, VIDEO_BASE + channel - 1, Buffer.concat([head, frame.data]));
			}
			this.#nextFrame += FRAME_MS;
		}
		const status = words(0, 20260101, Math.round(this.#clock), 1000, 0);
		this.#send(REPLAY, Code.pull, status);
	}
}

export async function startFakeRecorder(clipDir: string, port = 0): Promise<Server> {
	const read = async (name: string) =>
		framesOf(Buffer.from(await Bun.file(join(clipDir, name)).arrayBuffer()));
	const clips = { main: await read("clip-main.h264"), sub: await read("clip-sub.h264") };
	const server = createServer((socket) => new Session(socket, clips));
	await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
	return server;
}

if (import.meta.main) {
	const port = Number(process.argv[2] ?? 8780);
	await startFakeRecorder(process.env.CAMWALL_CLIPS ?? "demo", port);
	console.log(`fake recorder on ${port}`);
}
