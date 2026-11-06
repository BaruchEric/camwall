// Drives the demo stack in real Chrome and fails on anything a viewer would notice.
// Start it first: docker compose -f compose.yaml -f compose.demo.yaml up --build
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.CAMWALL_URL ?? "http://127.0.0.1:8090";
const out = process.env.CAMWALL_SHOTS ?? "test-results";
mkdirSync(out, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
	results.push(ok);
	console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const liveTiles = (page) =>
	page.evaluate(
		() =>
			[...document.querySelectorAll(".tile video")].filter(
				(v) => v.readyState >= 2 && v.videoWidth > 0 && !v.paused,
			).length,
	);

async function waitLive(page, count, timeout = 45_000) {
	const end = Date.now() + timeout;
	let live = 0;
	while (Date.now() < end) {
		live = await liveTiles(page);
		if (live >= count) break;
		await page.waitForTimeout(500);
	}
	return live;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
	viewport: { width: 1600, height: 900 },
	colorScheme: "dark",
	acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
	if (message.type() === "error") errors.push(message.text());
});

await page.goto(base);
await page.waitForSelector(".tile");
const total = await page.locator(".tile").count();
const live = await waitLive(page, total);
check("every tile plays on All cameras", live === total, `${live} of ${total}`);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, "wall.png") });

await page.locator(".rail-view", { hasText: "Warehouse" }).click();
await page.waitForTimeout(500);
const inGroup = await page.locator(".tile").count();
check("a group opens as its own wall", inGroup === 5, `${inGroup} tiles`);
await waitLive(page, inGroup);

await page.locator(".rail-view", { hasText: "Front of house" }).click();
await page.waitForSelector('.tile[data-tile="5"]');
const liveSaved = await waitLive(page, 6);
check("a saved view restores its layout", liveSaved === 6, `${liveSaved} live`);
await page.waitForTimeout(2000);
await page.screenshot({ path: join(out, "view.png") });
const big = await page.evaluate(() => {
	const video = document.querySelector('[data-tile="0"] video');
	return { w: video?.videoWidth ?? 0 };
});
check("the large tile gets the big stream", big.w >= 1000, `${big.w} px wide`);

await page.getByRole("button", { name: "Layout" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, "layouts.png") });
await page.getByRole("button", { name: "2 by 2" }).click();
await page.waitForTimeout(300);
check("a fixed layout pages through extra cameras", (await page.getByText("1 of 2").count()) === 1);
await page.keyboard.press("]");
await page.waitForTimeout(300);
check("the ] key turns the page", (await page.getByText("2 of 2").count()) === 1);
await page.keyboard.press("[");

const rail = page.locator(".rail-camera", { hasText: "Aisle 2" });
const target = page.locator('[data-tile="1"]');
await rail.hover();
await page.mouse.down();
const box = await target.boundingBox();
await page.mouse.move(box.x + 40, box.y + 40, { steps: 8 });
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(400);
const dropped = await target.locator(".strip-name").textContent();
check("dragging a camera onto a tile places it", dropped === "Aisle 2", String(dropped));
check(
	"edits offer Save",
	(await page.getByRole("button", { name: "Save", exact: true }).count()) === 1,
);
await page.getByRole("button", { name: "Revert" }).click();

await page.locator(".rail-view", { hasText: "All cameras" }).click();
await page.waitForSelector('.tile[data-tile="11"]');
await waitLive(page, 12);
await page.locator('[data-tile="0"] .picture').dblclick();
await page.waitForTimeout(4000);
const full = await page.evaluate(() => {
	const video = document.querySelector(".tile video");
	return { tiles: document.querySelectorAll(".tile").length, w: video?.videoWidth ?? 0 };
});
check("full view shows one big stream", full.tiles === 1 && full.w >= 1000, JSON.stringify(full));
await page.screenshot({ path: join(out, "full.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

await page.keyboard.press("?");
await page.waitForTimeout(200);
check("? opens the shortcut list", await page.getByText("Keyboard shortcuts").first().isVisible());
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

await page.getByRole("button", { name: "Settings" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, "settings.png") });
await page.getByRole("tab", { name: "Add cameras" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, "add.png") });
await page.keyboard.press("Escape");

const phone = await browser.newContext({
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
	hasTouch: true,
	isMobile: true,
	colorScheme: "dark",
});
const mobile = await phone.newPage();
await mobile.goto(base);
await mobile.waitForSelector(".tile");
await waitLive(mobile, 4);
await mobile.waitForTimeout(2500);
await mobile.screenshot({ path: join(out, "phone.png") });
await mobile.setViewportSize({ width: 390, height: 420 });
await mobile.waitForTimeout(1500);
const playing = await liveTiles(mobile);
const tiles = await mobile.locator(".tile").count();
check(
	"the phone plays only what is on screen",
	playing >= 2 && playing < tiles,
	`${playing} of ${tiles}`,
);
const overflow = await mobile.evaluate(
	() => document.documentElement.scrollWidth > window.innerWidth,
);
check("the phone layout has no sideways scroll", !overflow);

const light = await browser.newContext({
	viewport: { width: 1280, height: 800 },
	colorScheme: "light",
});
const day = await light.newPage();
await day.goto(`${base}/?view=group:yard`);
await day.waitForSelector(".tile");
await waitLive(day, 3);
await day.waitForTimeout(1500);
await day.screenshot({ path: join(out, "light.png") });

check("no browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed} of ${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
