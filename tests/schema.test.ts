import { describe, expect, test } from "bun:test";
import {
	applyPatch,
	type Config,
	Config as ConfigSchema,
	isRtspUrl,
	reconcile,
	toPublic,
	uniqueSlug,
	withCredentials,
} from "@/shared/schema";

const config: Config = ConfigSchema.parse({
	version: 1,
	cameras: [
		{
			id: "door",
			name: "Door",
			groupId: "front",
			main: "rtsp://user:secret@192.0.2.1/1",
			sub: null,
		},
	],
	groups: [{ id: "front", name: "Front" }],
	views: [{ id: "one", name: "One", layout: "4", slots: ["door", null] }],
});

describe("isRtspUrl", () => {
	test.each(["rtsp://192.0.2.1:554/a", "rtsps://cam.example/b", "rtsp://u:p@192.0.2.1/c?x=1"])(
		"accepts %s",
		(url) => expect(isRtspUrl(url)).toBe(true),
	);

	test.each([
		"exec:id",
		"ffmpeg:rtsp://192.0.2.1/a",
		"http://192.0.2.1/a",
		"rtsp://192.0.2.1/a#raw=-f null",
		"rtsp://192.0.2.1/a b",
		"rtsp://",
		"",
	])("refuses %s", (url) => expect(isRtspUrl(url)).toBe(false));
});

describe("toPublic", () => {
	test("never carries a stream address", () => {
		const text = JSON.stringify(toPublic(config));
		expect(text).not.toContain("rtsp");
		expect(text).not.toContain("secret");
	});
});

describe("applyPatch", () => {
	test("renames a camera without touching its address", () => {
		const next = applyPatch(config, {
			cameras: config.cameras.map(({ id, groupId }) => ({ id, name: "Back door", groupId })),
			groups: config.groups,
			views: config.views,
		});
		expect(next.cameras[0]?.name).toBe("Back door");
		expect(next.cameras[0]?.main).toBe("rtsp://user:secret@192.0.2.1/1");
	});

	test("cannot remove a camera by leaving it out", () => {
		const next = applyPatch(config, { cameras: [], groups: config.groups, views: config.views });
		expect(next.cameras.length).toBe(1);
	});
});

describe("reconcile", () => {
	test("clears a removed group and a removed camera", () => {
		const next = reconcile({ ...config, cameras: config.cameras.slice(0, 0), groups: [] });
		expect(next.views[0]?.slots).toEqual([null, null]);
		const kept = reconcile({ ...config, groups: [] });
		expect(kept.cameras[0]?.groupId).toBe(null);
	});
});

describe("helpers", () => {
	test("uniqueSlug counts up", () => {
		expect(uniqueSlug("Front Door", new Set(["front-door", "front-door-2"]))).toBe("front-door-3");
	});

	test("uniqueSlug handles a name with no letters", () => {
		expect(uniqueSlug("!!!", new Set())).toBe("camera");
	});

	test("withCredentials escapes what would break the address", () => {
		const url = withCredentials("rtsp://192.0.2.1/a", "ad min", "p#ss/word");
		expect(url).toBe("rtsp://ad%20min:p%23ss%2Fword@192.0.2.1/a");
		expect(isRtspUrl(url)).toBe(true);
	});

	test("withCredentials leaves a blank user alone", () => {
		expect(withCredentials("rtsp://192.0.2.1/a", "", "")).toBe("rtsp://192.0.2.1/a");
	});
});
