import { createConnection, type Socket } from "node:net";
import {
	Code,
	Control,
	encode,
	loginAccepted,
	loginBody,
	type Message,
	MessageReader,
	NORMAL_RATE,
	parseCalendar,
	parseDateId,
	parseMonths,
	REPLAY,
	SYSTEM,
	usedSlots,
	words,
} from "@/server/dvr/protocol";
import type { Quality, Recorder, Span } from "@/shared/schema";

const CONNECT_MS = 6000;
const REPLY_MS = 8000;
const KEEPALIVE_MS = 5000;
const MINUTE_MS = 60_000;

export type RecorderAddress = Pick<Recorder, "host" | "port" | "user" | "password">;

type Waiter = {
	resolve: (body: Buffer) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** One logged-in connection. Replies go to whoever asked, and the rest to `onPush`. */
export class DvrConnection {
	#socket: Socket;
	#reader = new MessageReader();
	#waiters = new Map<number, Waiter[]>();
	#keepalive: ReturnType<typeof setInterval> | undefined;
	#closed = false;
	onPush: (message: Message) => void = () => undefined;
	onClose: (reason: string) => void = () => undefined;

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (chunk) => this.#read(Buffer.from(chunk)));
		socket.on("error", (error) => this.#shut(error.message));
		socket.on("close", () => this.#shut("The recorder closed the connection"));
	}

	static async open(address: RecorderAddress): Promise<DvrConnection> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const opening = createConnection({ host: address.host, port: address.port });
			const fail = (error: Error) => {
				opening.destroy();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error("The recorder did not answer")), CONNECT_MS);
			opening.once("error", (error) => {
				clearTimeout(timer);
				fail(error);
			});
			opening.once("connect", () => {
				clearTimeout(timer);
				opening.removeAllListeners("error");
				opening.setNoDelay(true);
				resolve(opening);
			});
		});
		const connection = new DvrConnection(socket);
		try {
			const reply = await connection.request(
				SYSTEM,
				Code.login,
				loginBody(address.user, address.password),
			);
			if (!loginAccepted(reply)) throw new Error("The recorder refused that login");
			// CMS asks for these before anything else, so a session does too.
			for (const code of [Code.identity, Code.channels, Code.presets, Code.options]) {
				await connection.request(SYSTEM, code);
			}
		} catch (error) {
			connection.close();
			throw error;
		}
		connection.#keepalive = setInterval(() => connection.send(SYSTEM, Code.ping), KEEPALIVE_MS);
		return connection;
	}

	send(type: number, code: number, body?: Buffer): void {
		if (!this.#closed) this.#socket.write(encode(type, code, body));
	}

	request(type: number, code: number, body?: Buffer): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			if (this.#closed) {
				reject(new Error("The recorder connection is closed"));
				return;
			}
			const key = (type << 8) | code;
			const queue = this.#waiters.get(key) ?? [];
			const waiter: Waiter = {
				resolve,
				reject,
				timer: setTimeout(() => {
					queue.splice(queue.indexOf(waiter), 1);
					reject(new Error("The recorder stopped answering"));
				}, REPLY_MS),
			};
			queue.push(waiter);
			this.#waiters.set(key, queue);
			this.send(type, code, body);
		});
	}

	close(): void {
		this.#shut("Closed");
		this.#socket.destroy();
	}

	#read(chunk: Buffer): void {
		let messages: Message[];
		try {
			messages = this.#reader.push(chunk);
		} catch (error) {
			this.#shut(error instanceof Error ? error.message : "Bad data from the recorder");
			this.#socket.destroy();
			return;
		}
		for (const message of messages) {
			const waiter = this.#waiters.get((message.type << 8) | message.code)?.shift();
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(message.body);
			} else {
				this.onPush(message);
			}
		}
	}

	#shut(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#keepalive);
		for (const queue of this.#waiters.values()) {
			for (const waiter of queue) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(reason));
			}
		}
		this.#waiters.clear();
		this.onClose(reason);
	}
}

async function withConnection<T>(
	address: RecorderAddress,
	work: (connection: DvrConnection) => Promise<T>,
): Promise<T> {
	const connection = await DvrConnection.open(address);
	try {
		return await work(connection);
	} finally {
		connection.close();
	}
}

const ALL_MONTHS = words(1, 0xffffffff, 0);

async function readCalendar(connection: DvrConnection) {
	return parseCalendar(await connection.request(REPLAY, Code.calendar, ALL_MONTHS));
}

export async function dateId(connection: DvrConnection, day: string): Promise<number> {
	await readCalendar(connection);
	const [year = 0, month = 0, date = 0] = day.split("-").map(Number);
	return parseDateId(await connection.request(REPLAY, Code.date, words(year, month, date, 0)));
}

/** Checks a login, which is all a recorder can be asked before saving it. */
export function testRecorder(address: RecorderAddress): Promise<void> {
	return withConnection(address, async () => undefined);
}

/** Every day the recorder holds footage for, oldest first. */
export function readDays(address: RecorderAddress): Promise<string[]> {
	return withConnection(address, async (connection) => {
		const { months } = await readCalendar(connection);
		return parseMonths(await connection.request(REPLAY, Code.months, words(0, months)));
	});
}

/** Joins minute numbers into [start, end) stretches in milliseconds. */
export function minutesToSpans(minutes: readonly number[]): Span[] {
	const spans: Span[] = [];
	for (const minute of minutes) {
		const start = minute * MINUTE_MS;
		const last = spans.at(-1);
		if (last && last[1] === start) last[1] = start + MINUTE_MS;
		else spans.push([start, start + MINUTE_MS]);
	}
	return spans;
}

/** Joins stretches from several channels or recorders into one sorted list without overlaps. */
export function mergeSpans(spans: readonly Span[]): Span[] {
	const merged: Span[] = [];
	for (const [start, end] of spans.toSorted((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/** What each of these channels recorded on one day, to the minute, over one connection. */
export function readChannelSpans(
	address: RecorderAddress,
	day: string,
	channels: readonly number[],
): Promise<Map<number, Span[]>> {
	return withConnection(address, async (connection) => {
		const minutes = new Map(channels.map((channel) => [channel, [] as number[]]));
		const id = await dateId(connection, day);
		if (id !== 0) {
			const table = await connection.request(REPLAY, Code.dayHours);
			const hours = new Map(channels.map((channel) => [channel, usedSlots(table, channel, 24)]));
			const wanted = [...new Set([...hours.values()].flat())].sort((a, b) => a - b);
			for (const hour of wanted) {
				const minuteTable = await connection.request(REPLAY, Code.hourMinutes, words(hour));
				for (const channel of channels) {
					if (!hours.get(channel)?.includes(hour)) continue;
					const found = usedSlots(minuteTable, channel, 60).map((minute) => hour * 60 + minute);
					minutes.get(channel)?.push(...found);
				}
			}
		}
		return new Map([...minutes].map(([channel, list]) => [channel, minutesToSpans(list)]));
	});
}

/** What one channel recorded on one day, to the minute. */
export async function readSpans(
	address: RecorderAddress,
	day: string,
	channel: number,
): Promise<Span[]> {
	return (await readChannelSpans(address, day, [channel])).get(channel) ?? [];
}

/**
 * The words a control message carries for a set of channels in one quality. The recorder plays
 * every channel in the mask on one clock, which is how its own client plays several in step.
 * A session is all main or all sub: a mixed mask came back with its timestamps out of order.
 */
function masks(channels: readonly number[], quality: Quality) {
	const bits = channels.reduce((mask, channel) => (mask | (1 << (channel - 1))) >>> 0, 0);
	return quality === "main" ? { main: bits, sub: 0 } : { main: 0, sub: bits };
}

export type ReplayTarget = { id: number; channels: readonly number[]; quality: Quality };

function controlBody(
	flags: number,
	rate: number,
	ms: number,
	{ id, channels, quality }: ReplayTarget,
): Buffer {
	const { main, sub } = masks(channels, quality);
	return words(flags, rate, ms, 0, 0, main, id, 0, sub, 0, 0);
}

/** Opens the day and parks the recorder at `ms`. The caller then moves its clock with pulls. */
export async function openReplay(
	connection: DvrConnection,
	target: ReplayTarget,
	ms: number,
): Promise<void> {
	const { main, sub } = masks(target.channels, target.quality);
	await connection.request(REPLAY, Code.open, words(target.id, 0, 0, main, 0, sub, 0));
	const parked = words(Control.seek, 0, ms, 0, 0, 0, target.id, 0, 0, 0, 0);
	await connection.request(REPLAY, Code.control, parked);
	const stopped = words(Control.rate, 0, ms, 0, 0, 0, target.id, 0, 0, 0, 0);
	await connection.request(REPLAY, Code.control, stopped);
	connection.send(REPLAY, Code.reposition, words(1));
	const view = target.quality === "main" ? Control.viewMain : Control.viewSub;
	await connection.request(REPLAY, Code.control, controlBody(view, 0, ms, target));
	await moveReplay(connection, target, ms);
}

/** Sends the recorder's playback clock to `ms`. Frames that follow come from there. */
export async function moveReplay(
	connection: DvrConnection,
	target: ReplayTarget,
	ms: number,
): Promise<void> {
	connection.send(REPLAY, Code.reposition, words(1));
	await connection.request(
		REPLAY,
		Code.control,
		controlBody(Control.rate, NORMAL_RATE, ms, target),
	);
	await connection.request(
		REPLAY,
		Code.control,
		controlBody(Control.seek, NORMAL_RATE, ms, target),
	);
}
