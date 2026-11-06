import { describe, expect, test } from "bun:test";
import { planSync, streamName, wantedStreams } from "@/server/go2rtc";
import { CameraId, Config } from "@/shared/schema";

const config = Config.parse({
	version: 1,
	groups: [],
	views: [],
	cameras: [
		{ id: "both", name: "Both", groupId: null, main: "rtsp://h/1", sub: "rtsp://h/2" },
		{ id: "one", name: "One", groupId: null, main: "rtsp://h/3", sub: null },
	],
});

describe("wantedStreams", () => {
	const wanted = wantedStreams(config);

	test("drops audio from every camera", () => {
		expect(wanted.get(streamName(CameraId.parse("both"), "main"))).toBe("rtsp://h/1#media=video");
	});

	test("a camera with one stream serves it at both qualities", () => {
		expect(wanted.get("one_sub")).toBe("rtsp://h/3#media=video");
	});
});

describe("planSync", () => {
	const wanted = new Map([["a", "rtsp://h/a"]]);

	test("adds what go2rtc lost in a restart", () => {
		const plan = planSync({ wanted, existing: new Set(), applied: new Map(wanted) });
		expect(plan.put).toEqual([["a", "rtsp://h/a"]]);
	});

	test("does nothing when everything matches", () => {
		const plan = planSync({ wanted, existing: new Set(["a"]), applied: new Map(wanted) });
		expect(plan).toEqual({ put: [], remove: [] });
	});

	test("replaces a stream whose address changed", () => {
		const applied = new Map([["a", "rtsp://h/old"]]);
		expect(planSync({ wanted, existing: new Set(["a"]), applied }).put.length).toBe(1);
	});

	test("removes what the config no longer has", () => {
		const plan = planSync({ wanted, existing: new Set(["a", "b"]), applied: new Map(wanted) });
		expect(plan.remove).toEqual(["b"]);
	});
});
