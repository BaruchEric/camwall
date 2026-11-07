/**
 * The wire format of Unix CCTV / Eyemax "Magic" recorders, on the port their CMS client calls
 * watch and search (8780 by default). Nothing here is documented by the vendor. It was read off
 * the wire from CMS against a Magic-U 4M 32, firmware 2.3.7.11, so a field with no name below
 * is one that only ever held the value shown.
 *
 * Every message is `5a a5`, a type byte, a code byte, a big-endian length and that many bytes.
 * Numbers are big-endian 32-bit words. There is no encryption, only the login's XOR.
 */

const MAGIC_0 = 0x5a;
const MAGIC_1 = 0xa5;
const HEADER = 8;
/** A 1080p key frame runs about 200 KB, so this only stops a broken length from eating memory. */
const MAX_BODY = 16 * 1024 * 1024;

export const SYSTEM = 0x01;
export const REPLAY = 0x04;

export const Code = {
	login: 0x00,
	ping: 0x02,
	identity: 0x20,
	channels: 0x21,
	options: 0x22,
	presets: 0x27,
	calendar: 0x00,
	months: 0x04,
	date: 0x05,
	dayHours: 0x10,
	hourMinutes: 0x11,
	open: 0x80,
	control: 0x82,
	pull: 0x83,
	reposition: 0x84,
} as const;

/** The first video code. Channel n (from 1) arrives as `VIDEO_BASE + n - 1`. */
export const VIDEO_BASE = 0x60;
const VIDEO_END = 0x80;

/** Bits of the first word of a control message. */
export const Control = { rate: 0x01, seek: 0x02, viewSub: 0x24, viewMain: 0x10 } as const;

/** Each pull moves the recorder's playback clock on by one 60th of a second. */
export const PULL_MS = 1000 / 60;

export const NORMAL_RATE = 1000;
const LOGIN_VERSION = 0x01000005;
const LOGIN_SERVICE = 2;
const LOGIN_FLAGS = 0xc888d000;
const LOGIN_KEY = "3R Global, Inc.";

export type Message = { type: number; code: number; body: Buffer };

export function encode(type: number, code: number, body: Buffer = Buffer.alloc(0)): Buffer {
	const head = Buffer.alloc(HEADER);
	head[0] = MAGIC_0;
	head[1] = MAGIC_1;
	head[2] = type;
	head[3] = code;
	head.writeUInt32BE(body.length, 4);
	return Buffer.concat([head, body]);
}

export function words(...values: number[]): Buffer {
	const body = Buffer.alloc(values.length * 4);
	values.forEach((value, i) => {
		body.writeUInt32BE(value >>> 0, i * 4);
	});
	return body;
}

/** Cuts a TCP stream back into messages. */
export class MessageReader {
	#pending = Buffer.alloc(0);

	push(chunk: Uint8Array): Message[] {
		this.#pending =
			this.#pending.length === 0
				? Buffer.from(chunk)
				: Buffer.concat([this.#pending, Buffer.from(chunk)]);
		const messages: Message[] = [];
		while (this.#pending.length >= HEADER) {
			const pending = this.#pending;
			if (pending[0] !== MAGIC_0 || pending[1] !== MAGIC_1) {
				throw new Error("The recorder sent something that is not its protocol");
			}
			const length = pending.readUInt32BE(4);
			if (length > MAX_BODY) throw new Error("The recorder sent an impossible message length");
			if (pending.length < HEADER + length) break;
			messages.push({
				type: pending[2] ?? 0,
				code: pending[3] ?? 0,
				body: pending.subarray(HEADER, HEADER + length),
			});
			this.#pending = pending.subarray(HEADER + length);
		}
		return messages;
	}
}

function obfuscate(text: string): Buffer {
	const key = Buffer.from(LOGIN_KEY);
	return Buffer.from([...Buffer.from(text)].map((byte, i) => byte ^ (key[i % key.length] ?? 0)));
}

/**
 * Only a blank password has been seen on the wire. A password is assumed to follow the user
 * name under the same key, restarted, and a recorder that disagrees refuses the login.
 */
export function loginBody(user: string, password: string): Buffer {
	const name = obfuscate(user);
	const secret = obfuscate(password);
	return Buffer.concat([
		words(LOGIN_VERSION, LOGIN_SERVICE, LOGIN_FLAGS, name.length, secret.length),
		name,
		secret,
	]);
}

export function loginAccepted(body: Buffer): boolean {
	return body.length >= 4 && body.readUInt32BE(0) === 0;
}

export type Calendar = { months: number; latest: string };

const pad = (value: number) => String(value).padStart(2, "0");
const dayText = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

/** The reply to `calendar`: how many months hold footage, and the newest date. */
export function parseCalendar(body: Buffer): Calendar {
	return {
		months: body.readUInt32BE(4),
		latest: dayText(body.readUInt32BE(12), body.readUInt32BE(16), body.readUInt32BE(20)),
	};
}

const MONTH_ENTRY = 136;

/** Each month is its year and number, then a word per day of the month, indexed by day. */
export function parseMonths(body: Buffer): string[] {
	const days: string[] = [];
	for (let start = 0; start + MONTH_ENTRY <= body.length; start += MONTH_ENTRY) {
		const year = body.readUInt32BE(start);
		const month = body.readUInt32BE(start + 4);
		for (let day = 1; day <= 31; day++) {
			if (body.readUInt32BE(start + 8 + day * 4) !== 0) days.push(dayText(year, month, day));
		}
	}
	return days.sort();
}

/** The reply to `date`: the recorder's own id for that day. */
export function parseDateId(body: Buffer): number {
	return body.readUInt32BE(4);
}

const KINDS_OFFSET = 256;

/**
 * `dayHours` and `hourMinutes` both answer with two tables of 32 64-bit masks, one mask per
 * channel, in that order. The tables are two kinds of recording. Bit n is hour or minute n.
 */
export function usedSlots(body: Buffer, channel: number, slots: number): number[] {
	const used: number[] = [];
	const first = body.readBigUInt64BE((channel - 1) * 8);
	const second = body.readBigUInt64BE(KINDS_OFFSET + (channel - 1) * 8);
	const mask = first | second;
	for (let slot = 0; slot < slots; slot++) {
		if ((mask >> BigInt(slot)) & 1n) used.push(slot);
	}
	return used;
}

export type Status = { date: number; ms: number };

/** The reply to a pull. The clock is `ms`, and `date` reads as decimal YYYYMMDD. */
export function parseStatus(body: Buffer): Status {
	return { date: body.readUInt32BE(4), ms: body.readUInt32BE(8) };
}

export type VideoFrame = {
	channel: number;
	/** Milliseconds after midnight on the recorder's clock. */
	ms: number;
	width: number;
	height: number;
	key: boolean;
	/** H.264 in Annex B form. */
	data: Buffer;
};

const FRAME_HEADER = 16;

export function parseVideo({ type, code, body }: Message): VideoFrame | null {
	if (type !== REPLAY || code < VIDEO_BASE || code >= VIDEO_END) return null;
	if (body.length <= FRAME_HEADER) return null;
	return {
		channel: code - VIDEO_BASE + 1,
		ms: body.readUInt32BE(0),
		width: body.readUInt16BE(4),
		height: body.readUInt16BE(6),
		key: body[8] === 1,
		data: body.subarray(FRAME_HEADER),
	};
}
