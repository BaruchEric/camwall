import { createHash, randomBytes } from "node:crypto";
import { type DiscoveredCamera, type DiscoverRequest, isRtspUrl } from "@/shared/schema";

const NS = [
	'xmlns:s="http://www.w3.org/2003/05/soap-envelope"',
	'xmlns:trt="http://www.onvif.org/ver10/media/wsdl"',
	'xmlns:tt="http://www.onvif.org/ver10/schema"',
].join(" ");

const WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const DIGEST =
	"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest";
const BASE64 =
	"http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

const escapeXml = (value: string) => value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function securityHeader(user: string, password: string): string {
	if (user === "") return "";
	const nonce = randomBytes(16);
	const created = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	const digest = createHash("sha1")
		.update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
		.digest("base64");
	return `<s:Header><wsse:Security xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}"><wsse:UsernameToken><wsse:Username>${escapeXml(user)}</wsse:Username><wsse:Password Type="${DIGEST}">${digest}</wsse:Password><wsse:Nonce EncodingType="${BASE64}">${nonce.toString("base64")}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}

export type Profile = {
	token: string;
	source: string | null;
	width: number | null;
	height: number | null;
};

const tag = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([^<]*)<`);

/** Splits a GetProfiles reply. Each profile names its video source and resolution. */
export function parseProfiles(xml: string): Profile[] {
	const opening = /<(?:[\w-]+:)?Profiles\b[^>]*\btoken="([^"]+)"[^>]*>/g;
	const marks = [...xml.matchAll(opening)];
	return marks.map((mark, i) => {
		const start = mark.index + mark[0].length;
		const chunk = xml.slice(start, marks[i + 1]?.index ?? xml.length);
		const number = (name: string) => {
			const value = Number(tag(name).exec(chunk)?.[1]);
			return Number.isFinite(value) && value > 0 ? value : null;
		};
		return {
			token: mark[1] ?? "",
			source: tag("SourceToken").exec(chunk)?.[1] ?? null,
			width: number("Width"),
			height: number("Height"),
		};
	});
}

export function parseStreamUri(xml: string): string | null {
	const uri = tag("Uri").exec(xml)?.[1]?.replace(/&amp;/g, "&") ?? null;
	return uri !== null && isRtspUrl(uri) ? uri : null;
}

/** A device can report an address it only knows itself by, so only the path is kept. */
export function parseMediaPath(xml: string): string | null {
	const section = /<(?:[\w-]+:)?Media\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Media>/.exec(xml)?.[1];
	const address = section ? tag("XAddr").exec(section)?.[1] : undefined;
	if (!address) return null;
	try {
		return new URL(address).pathname;
	} catch {
		return null;
	}
}

export type ProfileStream = Profile & { uri: string };

/** One camera per video source: the widest profile is main, the narrowest is sub. */
export function pairStreams(streams: ProfileStream[]): DiscoveredCamera[] {
	const bySource = new Map<string, ProfileStream[]>();
	for (const stream of streams) {
		const key = stream.source ?? stream.token;
		bySource.set(key, [...(bySource.get(key) ?? []), stream]);
	}
	const cameras: DiscoveredCamera[] = [];
	for (const group of bySource.values()) {
		const sorted = group.toSorted((a, b) => (b.width ?? 0) - (a.width ?? 0));
		const main = sorted[0];
		const sub = sorted.at(-1);
		if (!main || !sub) continue;
		cameras.push({
			name: `Camera ${cameras.length + 1}`,
			main: main.uri,
			sub: sub.uri === main.uri ? null : sub.uri,
			width: main.width,
			height: main.height,
		});
	}
	return cameras;
}

const DEFAULT_MEDIA_PATH = "/onvif/Media";

export async function discover(request: DiscoverRequest): Promise<DiscoveredCamera[]> {
	const call = async (path: string, body: string): Promise<string> => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}>${securityHeader(request.user, request.password)}<s:Body>${body}</s:Body></s:Envelope>`;
		const response = await fetch(`http://${request.host}:${request.port}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/soap+xml" },
			body: xml,
			signal: AbortSignal.timeout(10_000),
		});
		const text = await response.text();
		if (/FailedAuthentication|NotAuthorized/.test(text)) {
			throw new Error("The device refused that user name and password");
		}
		if (!response.ok) throw new Error(`The device answered ${response.status}`);
		return text;
	};

	const capabilities = await call(
		"/onvif/device_service",
		'<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>Media</tds:Category></tds:GetCapabilities>',
	).catch(() => "");
	const media = parseMediaPath(capabilities) ?? DEFAULT_MEDIA_PATH;

	const profiles = parseProfiles(await call(media, "<trt:GetProfiles/>"));
	const streams: ProfileStream[] = [];
	for (const profile of profiles) {
		// A recorder lists every channel it is licensed for, including ones with nothing wired
		// in, and faults on those. One empty channel must not lose the rest.
		const reply = await call(
			media,
			`<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${escapeXml(profile.token)}</trt:ProfileToken></trt:GetStreamUri>`,
		).catch(() => "");
		const uri = parseStreamUri(reply);
		if (uri) streams.push({ ...profile, uri });
	}
	return pairStreams(streams);
}
