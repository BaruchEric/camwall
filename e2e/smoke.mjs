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

// Right-click menus.
const panel = page.locator(".ctx-panel");
const item = (name) => page.locator(".ctx-item", { hasText: name });

const defaultKept = (selector) =>
	page.evaluate((target) => {
		const element = document.querySelector(target);
		const box = element.getBoundingClientRect();
		const event = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			button: 2,
			clientX: box.left + 4,
			clientY: box.top + 4,
		});
		return element.dispatchEvent(event);
	}, selector);

await page.locator('[data-tile="5"] video').click({ button: "right" });
check("a right click on video opens the menu", await panel.first().isVisible());
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, "menu-tile.png") });
check(
	"the menu is about that tile",
	(await page.locator(".ctx-head-name").textContent()) ===
		(await page.locator('[data-tile="5"] .strip-name').textContent()),
);
check(
	"the tile it is about is selected",
	await page.locator('[data-tile="5"].tile-selected').isVisible(),
);

await page.keyboard.press("Escape");
await page.locator('[data-tile="5"] .strip-name').click({ button: "right" });
await page.waitForTimeout(100);
check("a right click on a label opens the menu too", (await panel.count()) === 1);
check("it leaves no word selected", await page.evaluate(() => getSelection().isCollapsed));

await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
check(
	"arrows move inside the menu and leave the wall alone",
	await page.locator('[data-tile="5"].tile-selected').isVisible(),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape closes the menu", (await panel.count()) === 0);
check(
	"Escape leaves the tile selected",
	await page.locator('[data-tile="5"].tile-selected').isVisible(),
);

await page.keyboard.press("Shift+F10");
await page.waitForTimeout(100);
check("Shift+F10 opens the selected tile's menu", (await panel.count()) === 1);
const firstRow = await page.evaluate(() => document.activeElement?.textContent ?? "");
check("the keyboard lands on the first row", firstRow.includes("Open full view"), firstRow);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check("Enter runs the row", (await page.locator(".tile").count()) === 1);
await page.locator(".tile video").click({ button: "right" });
check("full view has its own menu", await item("Back to the wall").isVisible());
await item("Back to the wall").click();
await page.waitForTimeout(300);

check("a text field keeps the browser's menu", await defaultKept(".rail-search input"));
await page.locator(".rail-search input").click({ button: "right" });
await page.waitForTimeout(100);
check("a text field opens no menu of ours", (await panel.count()) === 0);
await page.keyboard.press("Escape");
await page.locator('[data-tile="2"] video').click({ button: "right", modifiers: ["Shift"] });
await page.waitForTimeout(100);
check("Shift + right click stays with the browser", (await panel.count()) === 0);

await page.locator('[data-tile="3"] video').click({ button: "right" });
await item("Rename camera").click();
await page.locator(".ctx-field").fill("Renamed by smoke");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check(
	"renaming in the menu renames the camera",
	(await page.locator('[data-tile="3"] .strip-name').textContent()) === "Renamed by smoke",
);
await page.locator('[data-tile="3"] video').click({ button: "right" });
await item("Rename camera").click();
await page.locator(".ctx-field").fill("Reception");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);

await page.locator('[data-tile="1"] video').click({ button: "right" });
await item("Replace with").click();
await page.waitForTimeout(200);
await page.locator(".ctx-filter input").fill("fence");
await page.waitForTimeout(100);
await page.screenshot({ path: join(out, "menu-replace.png") });
check(
	"the camera list filters",
	(await page.locator(".ctx-panel").last().locator(".ctx-item").count()) === 1,
);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape walks back out of a submenu", (await panel.count()) === 0);

await page.locator(".rail-camera", { hasText: "Gate" }).click({ button: "right" });
await page.waitForTimeout(300);
await page.locator(".ctx-cell").nth(0).hover();
await page.waitForTimeout(150);
check(
	"hovering the map lights the real tile",
	await page.locator('[data-tile="0"][data-routing]').isVisible(),
);
await page.screenshot({ path: join(out, "menu-rail.png") });
await page.locator(".ctx-cell").nth(0).click();
await page.waitForTimeout(400);
check(
	"pressing the map routes the camera",
	(await page.locator('[data-tile="0"] .strip-name').textContent()) === "Gate",
);
check("routing counts as an edit", await page.getByRole("button", { name: "Revert" }).isVisible());
await page.locator(".wall").click({ button: "right", position: { x: 4, y: 4 } });
await item("Revert changes").click();
await page.waitForTimeout(300);

await page.locator(".rail-view", { hasText: "Warehouse" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, "menu-group.png") });
await page.keyboard.press("Escape");
await page.locator(".health").click({ button: "right" });
await page.waitForTimeout(200);
check("the health figures have a menu", await item("Reconnect everything").isVisible());
await page.keyboard.press("Escape");

await page.locator(".wall").click({ button: "right", position: { x: 4, y: 4 } });
await page.waitForTimeout(100);
await page.getByRole("menuitemradio", { name: "Seconds: 5" }).click();
await page.keyboard.press("Escape");
await page.keyboard.press("t");
await page.locator(".wall").click({ button: "right", position: { x: 4, y: 4 } });
await page.waitForTimeout(6000);
check(
	"the tour waits while a menu is open",
	(await page.locator(".title").textContent()) === "All cameras",
);
check(
	"a running tour leads the menu",
	(await panel.locator(".ctx-item").first().textContent())?.includes("Stop tour"),
);
await panel.locator(".ctx-item").first().click();
await page.waitForTimeout(100);

await page.getByRole("button", { name: "Settings" }).first().click();
await page.waitForTimeout(200);
await page
	.locator(".row-note")
	.first()
	.waitFor({ state: "attached" })
	.catch(() => undefined);
await page.getByRole("tab", { name: "Groups" }).click();
await page.waitForTimeout(100);
await page.locator(".row-note").first().click({ button: "right" });
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, "menu-settings.png") });
check("a menu opens above a dialog", await item("Rename group").isVisible());
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check(
	"Escape there closes the menu and not the dialog",
	(await panel.count()) === 0 && (await page.locator("dialog[open]").count()) === 1,
);
await page.getByRole("tab", { name: "Add cameras" }).click();
await page.route("**/api/discover", (route) =>
	route.fulfill({
		json: {
			cameras: [1, 2, 3].map((n) => ({
				name: `Channel ${n}`,
				main: `rtsp://192.0.2.10/${n}`,
				sub: null,
				width: null,
				height: null,
			})),
		},
	}),
);
await page.locator(".form-grid input").first().fill("192.0.2.10");
await page.getByRole("button", { name: "Find cameras" }).click();
await page.locator(".found-list label", { hasText: "Channel 2" }).click({ button: "right" });
await page.locator(".ctx-item", { hasText: "Tick only this one" }).click();
await page.waitForTimeout(100);
check(
	"a found channel's menu sets the ticks",
	(await page.getByRole("button", { name: "Add 1 camera" }).count()) === 1,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

await page.locator(".wall").click({ button: "right", position: { x: 4, y: 4 } });
await item("Layout").hover();
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, "menu-layout.png") });
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await page.locator('[data-tile="4"] video').click({ button: "right" });
await item("Pop out picture").click();
await page.waitForFunction(() => document.pictureInPictureElement !== null);
await page.evaluate(() => {
	Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
	document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(1500);
const hidden = await page.evaluate(() => ({
	popped: document.querySelector('[data-tile="4"]').dataset.state,
	others: document.querySelectorAll('.tile[data-state="live"]').length,
}));
check(
	"a popped out picture keeps playing in a hidden tab",
	hidden.popped === "live" && hidden.others === 1,
	JSON.stringify(hidden),
);
await page.evaluate(async () => {
	await document.exitPictureInPicture();
	delete document.hidden;
	document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForTimeout(300);

const lostContext = await browser.newContext({
	viewport: { width: 1280, height: 800 },
	colorScheme: "light",
	permissions: ["clipboard-read", "clipboard-write"],
});
await lostContext.routeWebSocket(/\/ws\/gate\//, (socket) => socket.close());
const flaky = await lostContext.newPage();
await flaky.goto(`${base}/?view=group:yard`);
await flaky.waitForSelector(".tile");
await waitLive(flaky, 2);
await flaky.waitForSelector('[data-state="retrying"]', { timeout: 15_000 });
await flaky.locator('[data-tile="0"] .picture').click({ button: "right" });
const lead = await flaky.locator(".ctx-item").first().textContent();
check("a lost camera's menu leads with reconnecting", lead?.includes("Reconnect now"), lead);
await flaky.waitForTimeout(200);
await flaky.screenshot({ path: join(out, "menu-lost.png") });
await flaky.keyboard.press("Escape");
await flaky.locator(".health").click({ button: "right" });
await flaky.waitForTimeout(200);
await flaky.screenshot({ path: join(out, "menu-health.png") });
check(
	"the health menu names what is lost",
	await flaky.locator(".ctx-item", { hasText: "Gate" }).isVisible(),
);
await flaky.keyboard.press("Escape");
await flaky.locator('[data-tile="1"] video').click({ button: "right" });
await flaky.locator(".ctx-item", { hasText: "Copy snapshot" }).click();
await flaky.locator(".toast", { hasText: "Snapshot copied" }).waitFor({ timeout: 3000 });
check("copying a snapshot says so", true);
await lostContext.close();

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
const held = await mobile.locator('[data-tile="0"] .picture').boundingBox();
const touch = await phone.newCDPSession(mobile);
const point = { x: held.x + held.width / 2, y: held.y + held.height / 2 };
await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
await mobile.waitForTimeout(800);
await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await mobile.waitForTimeout(300);
check("holding a finger opens the sheet", (await mobile.locator(".ctx-sheet").count()) === 1);
await mobile.screenshot({ path: join(out, "menu-phone.png") });
await mobile.locator(".ctx-item", { hasText: "Move to group" }).tap();
await mobile.waitForTimeout(200);
check("a sheet drills in", await mobile.locator(".ctx-back").isVisible());
await mobile.screenshot({ path: join(out, "menu-phone-sub.png") });
await mobile.locator(".ctx-back").tap();
await mobile.waitForTimeout(200);
await mobile.mouse.click(195, 20);
await mobile.waitForTimeout(200);
check("tapping the scrim closes the sheet", (await mobile.locator(".ctx-sheet").count()) === 0);

const hold = async (selector, ms, moveTo) => {
	const box = await mobile.locator(selector).boundingBox();
	const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
	await mobile.waitForTimeout(ms);
	if (moveTo) {
		for (const part of [0.2, 0.4, 0.6, 0.8, 1]) {
			const x = start.x + (moveTo.x - start.x) * part;
			const y = start.y + (moveTo.y - start.y) * part;
			await touch.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x, y }],
			});
			await mobile.waitForTimeout(100);
		}
	}
	await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await mobile.waitForTimeout(300);
};
await hold('[data-tile="0"] .strip-name', 700);
check(
	"holding a tile's label and letting go opens the sheet",
	(await mobile.locator(".ctx-sheet").count()) === 1,
);
await mobile.waitForTimeout(300);
await mobile.mouse.click(195, 20);
await mobile.waitForTimeout(200);
const names = () => mobile.locator(".strip-name").allTextContents();
const before = await names();
const other = await mobile.locator('[data-tile="1"]').boundingBox();
await hold('[data-tile="0"] .strip-name', 400, {
	x: other.x + other.width / 2,
	y: other.y + other.height / 2,
});
const after = await names();
check(
	"a finger drag still moves a tile",
	after[0] === before[1] &&
		after[1] === before[0] &&
		(await mobile.locator(".ctx-sheet").count()) === 0,
	`${after[0]}, ${after[1]}`,
);

const overflow = await mobile.evaluate(
	() => document.documentElement.scrollWidth > window.innerWidth,
);
check("the phone layout has no sideways scroll", !overflow);

// Playback, from the demo stack's stand-in recorder. Side door records ten minutes an hour.
{
	const replay = await context.newPage();
	replay.on("pageerror", (error) => errors.push(error.message));
	const playhead = () => replay.evaluate(() => document.querySelector(".replay video").currentTime);
	const replayNote = () => replay.locator(".replay .picture-note").textContent({ timeout: 500 });
	async function waitPlayhead(test, timeout) {
		const end = Date.now() + timeout;
		while (Date.now() < end) {
			if (test(await playhead())) return true;
			await replay.waitForTimeout(250);
		}
		return false;
	}
	await replay.goto(base);
	await replay.waitForSelector(".tile");
	await replay
		.locator(".tile")
		.nth(1)
		.click({ position: { x: 60, y: 60 } });
	await replay.keyboard.press("p");
	await replay.waitForSelector(".replay");
	const opened = await waitPlayhead((time) => time > 0, 15_000);
	const first = await playhead();
	check("P opens the camera's recordings", opened, `at ${first.toFixed(1)} s`);
	check("playback moves", await waitPlayhead((time) => time > first + 1, 6_000));
	await replay.keyboard.press(" ");
	await replay.waitForTimeout(600);
	const held = await playhead();
	await replay.waitForTimeout(1200);
	check("Space pauses", (await playhead()) === held);
	await replay.keyboard.press(" ");

	await replay.locator(".replay-bar .chip", { hasText: "8x" }).click();
	const noted = await waitPlayhead(() => false, 12_000).then(() => replayNote().catch(() => ""));
	check("the replay stops at the end of the footage", noted.includes("No more footage"), noted);
	await replay.waitForTimeout(1500);
	const stayed = await replayNote().catch(() => "");
	check("the end message stays up", stayed.includes("No more footage"), stayed);

	const bar = await replay.locator(".replay-timeline").boundingBox();
	await replay.mouse.click(bar.x + bar.width * 0.0063, bar.y + 12);
	check(
		"playback crosses a gap in the footage",
		await waitPlayhead((time) => time >= 3600 && time < 7200, 25_000),
	);
	await replay.locator(".replay-bar .chip", { hasText: "1x" }).click();

	await replay.keyboard.press("]");
	await replay.waitForTimeout(2500);
	const stamp = await replay.locator(".replay-stamp").textContent();
	check(
		"the next camera keeps the moment",
		stamp.startsWith("Lobby") && stamp.includes("01:0"),
		stamp,
	);
	await replay.screenshot({ path: join(out, "replay.png") });

	await replay.setViewportSize({ width: 390, height: 780 });
	await replay.waitForTimeout(400);
	const replayOverflow = await replay.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth,
	);
	check("the replay fits a phone", !replayOverflow);
	await replay.setViewportSize({ width: 1600, height: 900 });
	await replay.keyboard.press("Escape");
	await replay.waitForSelector(".tile");
	check("Esc goes back to the wall", (await replay.locator(".replay").count()) === 0);

	// The top bar switch, the camera list and links all lead into playback.
	await replay.locator('.mode[data-mode="replay"]').click();
	await replay.waitForSelector(".replay");
	check("the Playback switch opens playback", new URL(replay.url()).searchParams.has("replay"));
	check(
		"wall tools hide in playback",
		(await replay.locator('.topbar [aria-label="Layout"]').count()) === 0,
	);
	await replay.locator(".rail-camera", { hasText: "Gate" }).click();
	await replay.waitForTimeout(400);
	check(
		"the camera list picks what plays",
		(await replay.locator(".title").textContent()) === "Gate",
	);
	const picture = await replay.locator(".replay-picture").boundingBox();
	await replay.mouse.click(picture.x + 200, picture.y + 200, { button: "right" });
	await replay.waitForSelector(".ctx-panel");
	const menuText = await replay.locator(".ctx").textContent();
	check(
		"right click on footage gives the playback menu",
		menuText.includes("Leave playback") && !menuText.includes("Layout"),
	);
	await replay.keyboard.press("Escape");
	await replay.locator('.mode[data-mode="live"]').click();
	await replay.waitForSelector(".tile");

	// The stand-in recorder holds the last few days, so yesterday is always there.
	const yesterday = new Date(Date.now() - 86_400_000);
	const pad = (n) => String(n).padStart(2, "0");
	const stampDay = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
	await replay.goto(`${base}/?view=all&replay=gate&at=${stampDay}T10:05:00`);
	await replay.waitForSelector(".replay");
	await replay.waitForTimeout(800);
	const linkedStamp = await replay.locator(".replay-stamp").textContent();
	check(
		"a link opens playback at its moment",
		linkedStamp.includes("Gate") && linkedStamp.includes("10:05"),
		linkedStamp,
	);
	await replay.locator('.mode[data-mode="live"]').click();
	await replay.waitForSelector(".tile");

	await replay.locator('[aria-label="Settings"]').click();
	await replay.locator(".dialog button", { hasText: "Recorders" }).click();
	const linked = await replay.locator(".recorder-row").textContent();
	check("Settings lists the recorder", linked.includes("12 cameras linked"), linked);
	await replay.close();
}

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
