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

export const Camera = z.object({
	id: CameraId,
	name: Name,
	groupId: GroupId.nullable(),
	main: Source,
	sub: Source.nullable(),
});
export type Camera = z.infer<typeof Camera>;

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
});
export type Config = z.infer<typeof Config>;

/** What a browser gets. Stream addresses can hold passwords, so they stay on the server. */
export const PublicCamera = Camera.omit({ main: true, sub: true }).extend({ hasSub: z.boolean() });
export type PublicCamera = z.infer<typeof PublicCamera>;

export const AppState = z.object({
	cameras: z.array(PublicCamera),
	groups: z.array(Group),
	views: z.array(View),
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
	host: z
		.string()
		.trim()
		.regex(/^[a-zA-Z0-9.-]{1,253}$/, "Use a host name or an IPv4 address"),
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

export function emptyConfig(): Config {
	return { version: 1, cameras: [], groups: [], views: [] };
}

export function toPublic(config: Config): AppState {
	return {
		cameras: config.cameras.map(({ id, name, groupId, sub }) => ({
			id,
			name,
			groupId,
			hasSub: sub !== null,
		})),
		groups: config.groups,
		views: config.views,
	};
}

/** Drops references to anything that no longer exists. */
export function reconcile(config: Config): Config {
	const groupIds = new Set(config.groups.map((g) => g.id));
	const cameraIds = new Set(config.cameras.map((c) => c.id));
	return {
		...config,
		cameras: config.cameras.map((c) =>
			c.groupId !== null && !groupIds.has(c.groupId) ? { ...c, groupId: null } : c,
		),
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
