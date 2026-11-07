import { describe, expect, test } from "bun:test";
import { codecOf, findParameterSets, fragment, initSegment, splitNals } from "@/server/fmp4";

const SPS = [0x67, 0x64, 0x00, 0x2a, 0xad];
const PPS = [0x68, 0xee, 0x3c, 0xb0];
const IDR = [0x65, 0xb8, 0x00, 0x11];
const key = Buffer.from([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 1, ...IDR]);

type Box = { type: string; start: number; size: number };

function boxes(data: Buffer, from = 0, to = data.length): Box[] {
	const found: Box[] = [];
	for (let at = from; at < to; ) {
		const size = data.readUInt32BE(at);
		found.push({ type: data.toString("latin1", at + 4, at + 8), start: at, size });
		at += size;
	}
	return found;
}

describe("splitNals", () => {
	test("takes both start code lengths", () => {
		expect(splitNals(key).map((nal) => [...nal])).toEqual([SPS, PPS, IDR]);
	});

	test("ignores a frame with no start code", () => {
		expect(splitNals(Buffer.from([1, 2, 3]))).toEqual([]);
	});
});

describe("parameter sets", () => {
	test("come out of a key frame", () => {
		const sets = findParameterSets(key);
		expect([...(sets?.sps ?? [])]).toEqual(SPS);
		expect([...(sets?.pps ?? [])]).toEqual(PPS);
	});

	test("are missing from a plain frame", () => {
		expect(findParameterSets(Buffer.from([0, 0, 1, 0x41, 9]))).toBeNull();
	});

	test("name the codec", () => {
		expect(codecOf(Uint8Array.from(SPS))).toBe("avc1.64002a");
	});
});

describe("segments", () => {
	test("an init segment is ftyp then moov, with the picture size", () => {
		const data = initSegment({
			sps: Uint8Array.from(SPS),
			pps: Uint8Array.from(PPS),
			width: 1920,
			height: 1080,
		});
		expect(boxes(data).map((b) => b.type)).toEqual(["ftyp", "moov"]);
		const at = data.indexOf("avc1", 40, "latin1");
		expect(data.readUInt16BE(at + 4 + 24)).toBe(1920);
		expect(data.readUInt16BE(at + 4 + 26)).toBe(1080);
	});

	test("a fragment keeps the slice, drops parameter sets and points at its data", () => {
		const data = fragment({ sequence: 7, dts: 36_240_000, duration: 67, key: true, data: key });
		const [moof, mdat] = boxes(data);
		expect(moof?.type).toBe("moof");
		expect(mdat?.type).toBe("mdat");
		const body = data.subarray((mdat?.start ?? 0) + 8);
		expect(body.readUInt32BE(0)).toBe(IDR.length);
		expect([...body.subarray(4)]).toEqual(IDR);

		const trun = data.indexOf("trun", 0, "latin1");
		const offset = data.readInt32BE(trun + 4 + 8);
		expect(offset).toBe((mdat?.start ?? 0) + 8);
		expect(data.readUInt32BE(trun + 4 + 12)).toBe(67);

		const tfdt = data.indexOf("tfdt", 0, "latin1");
		expect(data.readUInt32BE(tfdt + 4 + 8)).toBe(36_240_000);
	});

	test("only a key frame is marked as a sync sample", () => {
		const flags = (isKey: boolean) => {
			const data = fragment({ sequence: 1, dts: 0, duration: 67, key: isKey, data: key });
			return data.readUInt32BE(data.indexOf("trun", 0, "latin1") + 4 + 20);
		};
		expect(flags(true)).toBe(0x02000000);
		expect(flags(false)).toBe(0x01010000);
	});
});
