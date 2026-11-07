import { z } from "zod";
import { LAYOUT_IDS } from "@/shared/layouts";

// Zod's fast path compiles validators with new Function, which the page's CSP forbids.
z.config({ jitless: true });

const slug = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const CameraId = z.string().regex(slug).brand<"CameraId">();
export type CameraId = z.infer<typeof CameraId>;
export const GroupId = z.string().regex(slug).brand<"GroupId">();
export type GroupId = z.infer<typeof GroupId>;
export const ViewId = z.string().regex(slug).brand<"ViewId">();
export type ViewId = z.infer<typeof ViewId>;

export const RecorderId = z.string().regex(slug).brand<"RecorderId">();
export type RecorderId = z.infer<typeof RecorderId>;

export const Quality = z.enum(["sub", "main"]);
export type Quality = z.infer<typeof Quality>;

const Name = z.string().trim().min(1).max(60);

/** go2rtc reads `#` as options and other schemes as commands, so neither gets through. */
export function isRtspUrl(value: string): boolean {
	if (/[\s#]/.test(value)) return false;
	try {
		const { protocol, hostname } = new URL(value);
		return (protocol === "rtsp:" || protocol === "rtsps:") && hostname !== "";
	} catch {
		return false;
	}
}

export const RtspUrl = z.string().max(2048).refine(isRtspUrl, "Use an rtsp:// or rtsps:// address");

const Source = z.string().min(1).max(2048);

const Host = z
	.string()
	.trim()
	.regex(/^[a-zA-Z0-9.-]{1,253}$/, "Use a host name or an IPv4 address");

/** Where a camera's recordings are, when something holds them. */
export const Replay = z.object({ recorder: RecorderId, channel: z.number().int().min(1).max(32) });
export type Replay = z.infer<typeof Replay>;

export const Camera = z.object({
	id: CameraId,
	name: Name,
	groupId: GroupId.nullable(),
	main: Source,
	sub: Source.nullable(),
	replay: Replay.nullable().default(null),
});
export type Camera = z.infer<typeof Camera>;

/** A recorder Camwall reads footage from. It never changes anything on one. */
export const Recorder = z.object({
	id: RecorderId,
	name: Name,
	host: Host,
	port: z.number().int().min(1).max(65535),
	user: z.string().max(128),
	password: z.string().max(256),
});
export type Recorder = z.infer<typeof Recorder>;

export const Group = z.object({ id: GroupId, name: Name });
export type Group = z.infer<typeof Group>;

export const LayoutChoice = z.enum(["auto", ...LAYOUT_IDS]);

export const View = z.object({
	id: ViewId,
	name: Name,
	layout: LayoutChoice,
	slots: z.array(CameraId.nullable()).max(64),
});
export type View = z.infer<typeof View>;

export const Config = z.object({
	version: z.literal(1),
	cameras: z.array(Camera).max(256),
	groups: z.array(Group).max(64),
	views: z.array(View).max(64),
	recorders: z.array(Recorder).max(16).default([]),
});
export type Config = z.infer<typeof Config>;

/** What a browser gets. Stream addresses can hold passwords, so they stay on the server. */
export const PublicCamera = Camera.omit({ main: true, sub: true, replay: true }).extend({
	hasSub: z.boolean(),
	hasReplay: z.boolean(),
});
export type PublicCamera = z.infer<typeof PublicCamera>;

export const PublicRecorder = z.object({
	id: RecorderId,
	name: Name,
	cameras: z.number().int(),
});
export type PublicRecorder = z.infer<typeof PublicRecorder>;

export const AppState = z.object({
	cameras: z.array(PublicCamera),
	groups: z.array(Group),
	views: z.array(View),
	recorders: z.array(PublicRecorder),
});
export type AppState = z.infer<typeof AppState>;

export const StatePatch = z.object({
	cameras: z.array(Camera.pick({ id: true, name: true, groupId: true })).max(256),
	groups: z.array(Group).max(64),
	views: z.array(View).max(64),
});
export type StatePatch = z.infer<typeof StatePatch>;

export const NewCamera = z.object({
	name: Name,
	groupId: GroupId.nullable().default(null),
	main: RtspUrl,
	sub: RtspUrl.nullable().default(null),
});
export type NewCamera = z.infer<typeof NewCamera>;

export const ImportRequest = z.object({
	cameras: z.array(NewCamera).min(1).max(128),
	user: z.string().max(128).default(""),
	password: z.string().max(256).default(""),
});

export const DiscoverRequest = z.object({
	host: Host,
	port: z.number().int().min(1).max(65535).default(80),
	user: z.string().max(128).default(""),
	password: z.string().max(256).default(""),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequest>;

export const DiscoveredCamera = z.object({
	name: Name,
	main: RtspUrl,
	sub: RtspUrl.nullable(),
	width: z.number().int().nullable(),
	height: z.number().int().nullable(),
});
export type DiscoveredCamera = z.infer<typeof DiscoveredCamera>;

export const DiscoverResponse = z.object({ cameras: z.array(DiscoveredCamera) });

export const NewRecorder = z.object({
	name: Name,
	host: Host,
	port: z.number().int().min(1).max(65535).default(8780),
	user: z.string().max(128).default("admin"),
	password: z.string().max(256).default(""),
});
export type NewRecorder = z.infer<typeof NewRecorder>;

/** A calendar date on the recorder's own clock. */
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DAY_MS = 86_400_000;
const DayMs = z.number().int().min(0).max(DAY_MS);
export const REPLAY_RATES = [1, 2, 4, 8] as const;
export type ReplayRate = (typeof REPLAY_RATES)[number];

export const ReplayDays = z.object({ days: z.array(Day) });

/** Recorded stretches of one day, as [start, end) in milliseconds after midnight. */
export const ReplaySpans = z.object({ spans: z.array(z.tuple([DayMs, DayMs])) });
export type Span = z.infer<typeof ReplaySpans>["spans"][number];

/** All a viewer may say about a replay. `at` is where its playhead is. */
export const ReplayCommand = z.discriminatedUnion("type", [
	z.object({ type: z.literal("seek"), ms: DayMs }),
	z.object({ type: z.literal("at"), ms: DayMs }),
	z.object({ type: z.literal("rate"), value: z.union(REPLAY_RATES.map((n) => z.literal(n))) }),
]);
export type ReplayCommand = z.infer<typeof ReplayCommand>;

/** One replay socket can carry several cameras. Each binary message starts with its track. */
export const MAX_REPLAY_TRACKS = 32;

export const ReplayEvent = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("mse"),
		track: z
			.number()
			.int()
			.min(0)
			.max(MAX_REPLAY_TRACKS - 1),
		value: z.string(),
	}),
	z.object({ type: z.literal("seeked"), ms: DayMs }),
	z.object({ type: z.literal("end") }),
	z.object({ type: z.literal("error"), value: z.string() }),
]);
export type ReplayEvent = z.infer<typeof ReplayEvent>;

export function emptyConfig(): Config {
	return { version: 1, cameras: [], groups: [], views: [], recorders: [] };
}

export function toPublic(config: Config): AppState {
	return {
		cameras: config.cameras.map(({ id, name, groupId, sub, replay }) => ({
			id,
			name,
			groupId,
			hasSub: sub !== null,
			hasReplay: replay !== null,
		})),
		groups: config.groups,
		views: config.views,
		recorders: config.recorders.map(({ id, name }) => ({
			id,
			name,
			cameras: config.cameras.filter((c) => c.replay?.recorder === id).length,
		})),
	};
}

/** A channel number from an RTSP path such as /mainStream7, /ch07 or /live?channel=7. */
export function channelOf(url: string): number | null {
	try {
		const { pathname, search } = new URL(url);
		const found = /(\d+)\/?$/.exec(pathname) ?? /channel=(\d+)/i.exec(search);
		const channel = Number(found?.[1]);
		return Number.isInteger(channel) && channel >= 1 && channel <= 32 ? channel : null;
	} catch {
		return null;
	}
}

/** Points the cameras that stream from this recorder's host at its recordings. */
export function linkCameras(cameras: readonly Camera[], recorder: Recorder): Camera[] {
	return cameras.map((camera) => {
		if (camera.replay !== null || hostOf(camera.main) !== recorder.host) return camera;
		const channel = channelOf(camera.main);
		return channel === null ? camera : { ...camera, replay: { recorder: recorder.id, channel } };
	});
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/** Drops references to anything that no longer exists. */
export function reconcile(config: Config): Config {
	const groupIds = new Set(config.groups.map((g) => g.id));
	const cameraIds = new Set(config.cameras.map((c) => c.id));
	const recorderIds = new Set(config.recorders.map((r) => r.id));
	return {
		...config,
		cameras: config.cameras.map((c) => ({
			...c,
			groupId: c.groupId !== null && groupIds.has(c.groupId) ? c.groupId : null,
			replay: c.replay !== null && recorderIds.has(c.replay.recorder) ? c.replay : null,
		})),
		views: config.views.map((v) => ({
			...v,
			slots: v.slots.map((s) => (s !== null && cameraIds.has(s) ? s : null)),
		})),
	};
}

/** Applies names, groups and views from a browser. It can neither add nor remove a camera. */
export function applyPatch(config: Config, patch: StatePatch): Config {
	const edits = new Map(patch.cameras.map((c) => [c.id, c]));
	return reconcile({
		...config,
		cameras: config.cameras.map((c) => {
			const edit = edits.get(c.id);
			return edit ? { ...c, name: edit.name, groupId: edit.groupId } : c;
		}),
		groups: patch.groups,
		views: patch.views,
	});
}

export function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return base === "" ? "camera" : base;
}

export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
	const base = slugify(name);
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

export function withCredentials(url: string, user: string, password: string): string {
	if (user === "") return url;
	const parsed = new URL(url);
	parsed.username = encodeURIComponent(user);
	parsed.password = encodeURIComponent(password);
	return parsed.toString();
}
