/** Fragmented MP4 from H.264 access units, for Media Source Extensions. */

const TIMESCALE = 1000;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

function box(type: string, ...parts: Uint8Array[]): Buffer {
	const size = parts.reduce((sum, part) => sum + part.length, 8);
	const head = Buffer.alloc(8);
	head.writeUInt32BE(size, 0);
	head.write(type, 4, "latin1");
	return Buffer.concat([head, ...parts]);
}

function u32(...values: number[]): Buffer {
	const out = Buffer.alloc(values.length * 4);
	values.forEach((value, i) => {
		out.writeUInt32BE(value >>> 0, i * 4);
	});
	return out;
}

const u16 = (...values: number[]) => {
	const out = Buffer.alloc(values.length * 2);
	values.forEach((value, i) => {
		out.writeUInt16BE(value, i * 2);
	});
	return out;
};

const bytes = (...values: number[]) => Buffer.from(values);
const zeros = (length: number) => Buffer.alloc(length);

/** Splits Annex B data on its start codes. */
export function splitNals(data: Uint8Array): Uint8Array[] {
	const starts: { at: number; size: number }[] = [];
	for (let i = 0; i + 3 <= data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
			const long = i > 0 && data[i - 1] === 0;
			starts.push({ at: long ? i - 1 : i, size: long ? 4 : 3 });
			i += 2;
		}
	}
	return starts.flatMap((start, i) => {
		const from = start.at + start.size;
		const nal = data.subarray(from, starts[i + 1]?.at ?? data.length);
		return nal.length > 0 ? [nal] : [];
	});
}

const nalType = (nal: Uint8Array) => (nal[0] ?? 0) & 0x1f;

export type StreamInfo = {
	sps: Uint8Array;
	pps: Uint8Array;
	width: number;
	height: number;
};

/** The parameter sets of a key frame, or null if this frame does not carry them. */
export function findParameterSets(data: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
	const nals = splitNals(data);
	const sps = nals.find((nal) => nalType(nal) === NAL_SPS);
	const pps = nals.find((nal) => nalType(nal) === NAL_PPS);
	return sps && pps ? { sps, pps } : null;
}

/** The value for `codecs=` in a MIME type. */
export function codecOf(sps: Uint8Array): string {
	const hex = (value: number | undefined) => (value ?? 0).toString(16).padStart(2, "0");
	return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

function avcC({ sps, pps }: StreamInfo): Buffer {
	return box(
		"avcC",
		bytes(1, sps[1] ?? 0, sps[2] ?? 0, sps[3] ?? 0, 0xff, 0xe1),
		u16(sps.length),
		sps,
		bytes(1),
		u16(pps.length),
		pps,
	);
}

function sampleEntry(info: StreamInfo): Buffer {
	return box(
		"avc1",
		zeros(6),
		u16(1),
		zeros(16),
		u16(info.width, info.height),
		u32(0x00480000, 0x00480000, 0),
		u16(1),
		zeros(32),
		u16(0x0018, 0xffff),
		avcC(info),
	);
}

const IDENTITY = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

export function initSegment(info: StreamInfo): Buffer {
	const ftyp = box("ftyp", Buffer.from("isom"), u32(0x200), Buffer.from("isomiso5avc1mp41"));
	const mvhd = box(
		"mvhd",
		u32(0, 0, 0, TIMESCALE, 0, 0x00010000),
		u16(0x0100, 0),
		u32(0, 0),
		IDENTITY,
		zeros(24),
		u32(2),
	);
	const tkhd = box(
		"tkhd",
		u32(0x00000003, 0, 0, 1, 0, 0, 0, 0),
		u16(0, 0, 0, 0),
		IDENTITY,
		u32(info.width << 16, info.height << 16),
	);
	const mdhd = box("mdhd", u32(0, 0, 0, TIMESCALE, 0), u16(0x55c4, 0));
	const hdlr = box("hdlr", u32(0, 0), Buffer.from("vide"), zeros(12), Buffer.from("video\0"));
	const dref = box("dref", u32(0, 1), box("url ", u32(1)));
	const stbl = box(
		"stbl",
		box("stsd", u32(0, 1), sampleEntry(info)),
		box("stts", u32(0, 0)),
		box("stsc", u32(0, 0)),
		box("stsz", u32(0, 0, 0)),
		box("stco", u32(0, 0)),
	);
	const minf = box("minf", box("vmhd", u32(1), zeros(8)), box("dinf", dref), stbl);
	const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
	const mvex = box("mvex", box("trex", u32(0, 1, 1, 0, 0, 0)));
	return Buffer.concat([ftyp, box("moov", mvhd, trak, mvex)]);
}

const SAMPLE_SYNC = 0x02000000;
const SAMPLE_NOT_SYNC = 0x01010000;
const BASE_IS_MOOF = 0x020000;
/** data-offset, sample duration, size and flags are present. */
const TRUN_FIELDS = 0x000701;

/** One frame as one fragment. `dts` is where it sits on the day's timeline, in milliseconds. */
export function fragment({
	sequence,
	dts,
	duration,
	key,
	data,
}: {
	sequence: number;
	dts: number;
	duration: number;
	key: boolean;
	data: Uint8Array;
}): Buffer {
	const nals = splitNals(data).filter((nal) => {
		const type = nalType(nal);
		return type !== NAL_SPS && type !== NAL_PPS && type !== NAL_AUD;
	});
	const size = nals.reduce((sum, nal) => sum + nal.length + 4, 0);
	const payload = Buffer.alloc(size);
	let at = 0;
	for (const nal of nals) {
		payload.writeUInt32BE(nal.length, at);
		payload.set(nal, at + 4);
		at += nal.length + 4;
	}
	const build = (offset: number) =>
		box(
			"moof",
			box("mfhd", u32(0, sequence)),
			box(
				"traf",
				box("tfhd", u32(BASE_IS_MOOF, 1)),
				box("tfdt", u32(0x01000000, 0, dts)),
				box(
					"trun",
					u32(TRUN_FIELDS, 1, offset, duration, size, key ? SAMPLE_SYNC : SAMPLE_NOT_SYNC),
				),
			),
		);
	const moof = build(build(0).length + 8);
	return Buffer.concat([moof, box("mdat", payload)]);
}
