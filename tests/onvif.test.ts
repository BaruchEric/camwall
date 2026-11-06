import { afterAll, describe, expect, test } from "bun:test";
import {
	discover,
	pairStreams,
	parseMediaPath,
	parseProfiles,
	parseStreamUri,
} from "@/server/onvif";

const profile = (token: string, source: string, width: number, height: number) => `
<trt:Profiles fixed="true" token="${token}">
	<tt:Name>${token}</tt:Name>
	<tt:VideoSourceConfiguration token="vsc"><tt:SourceToken>${source}</tt:SourceToken></tt:VideoSourceConfiguration>
	<tt:VideoEncoderConfiguration><tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${height}</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration>
</trt:Profiles>`;

const profiles = `<s:Envelope><s:Body><trt:GetProfilesResponse>
${profile("a1", "src1", 1920, 1080)}${profile("a2", "src1", 640, 352)}
${profile("b1", "src2", 2560, 1440)}${profile("dead", "src3", 1920, 1080)}
</trt:GetProfilesResponse></s:Body></s:Envelope>`;

describe("parsers", () => {
	test("reads each profile's token, source and size", () => {
		expect(parseProfiles(profiles)).toEqual([
			{ token: "a1", source: "src1", width: 1920, height: 1080 },
			{ token: "a2", source: "src1", width: 640, height: 352 },
			{ token: "b1", source: "src2", width: 2560, height: 1440 },
			{ token: "dead", source: "src3", width: 1920, height: 1080 },
		]);
	});

	test("reads a stream address and unescapes it", () => {
		const xml = "<tt:Uri>rtsp://192.0.2.1/a?x=1&amp;y=2</tt:Uri>";
		expect(parseStreamUri(xml)).toBe("rtsp://192.0.2.1/a?x=1&y=2");
	});

	test("refuses a stream address that is not RTSP", () => {
		expect(parseStreamUri("<tt:Uri>exec:id</tt:Uri>")).toBe(null);
	});

	test("keeps only the path of the media service", () => {
		const xml = "<tt:Media><tt:XAddr>http://10.0.0.9:8000/onvif/media</tt:XAddr></tt:Media>";
		expect(parseMediaPath(xml)).toBe("/onvif/media");
	});

	test("pairs a source's largest and smallest profile", () => {
		const cameras = pairStreams([
			{ token: "a2", source: "s", width: 640, height: 352, uri: "rtsp://h/sub" },
			{ token: "a1", source: "s", width: 1920, height: 1080, uri: "rtsp://h/main" },
		]);
		expect(cameras).toEqual([
			{ name: "Camera 1", main: "rtsp://h/main", sub: "rtsp://h/sub", width: 1920, height: 1080 },
		]);
	});
});

describe("discover", () => {
	const bodies: string[] = [];
	const device = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = await request.text();
			bodies.push(body);
			const { pathname } = new URL(request.url);
			if (pathname === "/onvif/device_service") {
				return new Response(
					"<tt:Media><tt:XAddr>http://10.9.9.9/custom/media</tt:XAddr></tt:Media>",
				);
			}
			if (pathname !== "/custom/media") return new Response("nope", { status: 404 });
			if (body.includes("GetProfiles")) return new Response(profiles);
			const token = /ProfileToken>([^<]+)</.exec(body)?.[1];
			if (token === "dead") return new Response("fault", { status: 400 });
			return new Response(`<tt:Uri>rtsp://192.0.2.1/${token}</tt:Uri>`);
		},
	});
	afterAll(() => device.stop(true));

	test("follows the device to its media service and skips dead channels", async () => {
		const cameras = await discover({
			host: "127.0.0.1",
			port: device.port ?? 0,
			user: "admin",
			password: "secret",
		});
		expect(cameras.map((c) => [c.main, c.sub])).toEqual([
			["rtsp://192.0.2.1/a1", "rtsp://192.0.2.1/a2"],
			["rtsp://192.0.2.1/b1", null],
		]);
	});

	test("sends a digest and never the password itself", () => {
		expect(bodies.some((body) => body.includes("PasswordDigest"))).toBe(true);
		expect(bodies.some((body) => body.includes("secret"))).toBe(false);
	});
});
