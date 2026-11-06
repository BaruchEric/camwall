import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutGlyph } from "@/web/components/LayoutGlyph";
import type {
	MenuAction,
	MenuHead,
	MenuName,
	MenuNode,
	MenuSegment,
	MenuSpec,
	MenuSub,
	MenuTiles,
	TileCell,
} from "@/web/lib/menus";
import { type MenuTarget, parseMenuTarget } from "@/web/lib/wall";

/** Long enough to read as a hold, short of the browser's own long-press menu. */
const HOLD_MS = 500;
const HOLD_SLOP = 10;
/** How long the pointer may cross other rows on its way into an open submenu. */
const HOVER_MS = 140;
/** The finger that opened a sheet lifts about now, and that lift must not close it. */
const SHEET_GUARD_MS = 400;
const EDGE = 8;

const FIELDS = "input, textarea, select, [contenteditable]";

export type MenuTrigger = {
	target: MenuTarget;
	x: number;
	y: number;
	anchor: Element;
	keyboard: boolean;
};

function triggerFrom(anchor: Element | null, x: number, y: number, keyboard: boolean) {
	const id = anchor instanceof HTMLElement ? anchor.dataset.menu : undefined;
	const target = id === undefined ? null : parseMenuTarget(id);
	return anchor && target ? { target, x, y, anchor, keyboard } : null;
}

export function triggerAt(element: Element, x: number, y: number): MenuTrigger | null {
	return triggerFrom(element.closest("[data-menu]"), x, y, false);
}

function hasSelection(): boolean {
	return getSelection()?.isCollapsed === false;
}

/**
 * One listener for every way of asking for a menu: right click, the menu key or Shift+F10, and
 * holding a finger down. Elements take part by naming themselves in `data-menu`.
 */
export function useMenuTriggers({
	open,
	busy,
	keyboardAnchor,
}: {
	open: (trigger: MenuTrigger) => void;
	/** True during a drag, which owns the pointer. */
	busy: () => boolean;
	keyboardAnchor: () => Element | null;
}): void {
	const latest = useRef({ open, busy, keyboardAnchor });
	latest.current = { open, busy, keyboardAnchor };

	useEffect(() => {
		let keyAt = 0;
		// A Mac selects the word under a right click before the menu event arrives, so only a
		// selection from before the press means the person wants to copy text.
		let selectedBefore = false;
		let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
		const release = () => {
			if (hold) clearTimeout(hold.timer);
			hold = null;
		};

		const onContext = (event: MouseEvent) => {
			if (event.defaultPrevented || !(event.target instanceof Element)) return;
			const element = event.target;
			// The menu key sends this event too, after the key press already opened the menu.
			const echo = event.button !== 2 && Date.now() - keyAt < 1000;
			if (element.closest(".ctx") || echo) {
				event.preventDefault();
				return;
			}
			if (event.shiftKey || element.closest(FIELDS)) return;
			if (selectedBefore && getSelection()?.containsNode(element, true)) return;
			const trigger = triggerAt(element, event.clientX, event.clientY);
			if (!trigger) return;
			event.preventDefault();
			getSelection()?.removeAllRanges();
			// A held finger already has its own timer below.
			if (event instanceof PointerEvent && event.pointerType === "touch") return;
			if (!latest.current.busy()) latest.current.open(trigger);
		};

		const onKey = (event: KeyboardEvent) => {
			const menuKey = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
			if (!menuKey || document.querySelector(".ctx")) return;
			const focused = document.activeElement;
			if (focused?.closest(FIELDS)) return;
			const inside = focused?.closest("[data-menu]") ?? latest.current.keyboardAnchor();
			if (!inside) return;
			const box = inside.getBoundingClientRect();
			const trigger = triggerFrom(
				inside,
				box.left + Math.min(box.width / 2, 120),
				box.top + Math.min(box.height / 2, 120),
				true,
			);
			if (!trigger) return;
			event.preventDefault();
			keyAt = Date.now();
			latest.current.open(trigger);
		};

		const onDown = (event: PointerEvent) => {
			release();
			selectedBefore = hasSelection();
			if (event.pointerType !== "touch" || !(event.target instanceof Element)) return;
			const element = event.target;
			if (element.closest(`.ctx, ${FIELDS}`)) return;
			const { clientX: x, clientY: y } = event;
			hold = {
				x,
				y,
				timer: setTimeout(() => {
					hold = null;
					const trigger = triggerAt(element, x, y);
					if (trigger && !latest.current.busy()) latest.current.open(trigger);
				}, HOLD_MS),
			};
		};

		const onMove = (event: PointerEvent) => {
			if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP) {
				release();
			}
		};

		document.addEventListener("contextmenu", onContext);
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("pointermove", onMove, true);
		document.addEventListener("pointerup", release, true);
		document.addEventListener("pointercancel", release, true);
		return () => {
			release();
			document.removeEventListener("contextmenu", onContext);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("pointermove", onMove, true);
			document.removeEventListener("pointerup", release, true);
			document.removeEventListener("pointercancel", release, true);
		};
	}, []);
}

function rowsOf(panel: Element): HTMLElement[] {
	return [...panel.querySelectorAll<HTMLElement>("[data-ctx-item]")].filter(
		(row) => row.getAttribute("aria-disabled") !== "true",
	);
}

/** Up and down treat a run of cells as one stop, and left and right walk inside it. */
function stops(panel: Element, current: Element | null): HTMLElement[] {
	return rowsOf(panel).filter((row) => {
		const group = row.closest("[data-ctx-cells]");
		if (!group) return true;
		if (current?.closest("[data-ctx-cells]") === group) return row === current;
		return rowsOf(group)[0] === row;
	});
}

function focusRow(row: HTMLElement | undefined): void {
	row?.focus({ preventScroll: false });
}

function paintFrame(canvas: HTMLCanvasElement, index: number): void {
	const video = document.querySelector(`[data-tile="${index}"] video`);
	if (!(video instanceof HTMLVideoElement) || video.videoWidth === 0) return;
	const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
	const width = video.videoWidth * scale;
	const height = video.videoHeight * scale;
	canvas
		.getContext("2d")
		?.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

function Cell({
	cell,
	here,
	label,
	onHover,
	onPick,
}: {
	cell: TileCell;
	here: boolean;
	label: string;
	onHover: (cell: TileCell | null) => void;
	onPick: () => void;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		if (canvas.current) paintFrame(canvas.current, cell.index);
	}, [cell.index]);
	const classes = ["ctx-cell"];
	if (cell.camera === null) classes.push("ctx-cell-empty");
	if (here) classes.push("ctx-cell-here");
	return (
		<button
			type="button"
			role="menuitem"
			data-ctx-item
			aria-disabled={here}
			aria-label={label}
			className={classes.join(" ")}
			style={{
				left: `${cell.x * 100}%`,
				top: `${cell.y * 100}%`,
				width: `${cell.w * 100}%`,
				height: `${cell.h * 100}%`,
			}}
			onPointerEnter={(event) => {
				if (event.pointerType !== "touch" && !here) event.currentTarget.focus();
			}}
			onPointerLeave={(event) => event.currentTarget.blur()}
			onFocus={() => onHover(cell)}
			onBlur={() => onHover(null)}
			onClick={() => {
				if (!here) onPick();
			}}
		>
			{cell.camera !== null && <canvas ref={canvas} width={96} height={54} />}
		</button>
	);
}

/** Lights the real tile as well, because that is where the picture will land. */
function useRoutingOutline(cell: TileCell | null): void {
	const index = cell?.index ?? null;
	useEffect(() => {
		if (index === null) return;
		const tile = document.querySelector(`[data-tile="${index}"]`);
		tile?.setAttribute("data-routing", "");
		return () => tile?.removeAttribute("data-routing");
	}, [index]);
}

function TileMap({ node, onDone }: { node: MenuTiles; onDone: () => void }) {
	const [hover, setHover] = useState<TileCell | null>(null);
	useRoutingOutline(hover);
	return (
		<div className="ctx-map">
			<div className="ctx-map-wall" data-ctx-cells style={{ aspectRatio: String(node.ratio) }}>
				{node.cells.map((cell) => (
					<Cell
						key={cell.index}
						cell={cell}
						here={node.here.includes(cell.index)}
						label={node.describe(cell)}
						onHover={setHover}
						onPick={() => {
							node.pick(cell);
							onDone();
						}}
					/>
				))}
			</div>
			<p className="ctx-map-note">{hover ? node.describe(hover) : node.label}</p>
		</div>
	);
}

function Segment({ node }: { node: MenuSegment }) {
	return (
		<div className="ctx-segment">
			<span className="ctx-label">{node.label}</span>
			<div className="ctx-options" data-ctx-cells>
				{node.options.map((option) => {
					const on = option.id === node.value;
					return (
						<button
							key={option.id}
							type="button"
							role="menuitemradio"
							aria-checked={on}
							aria-label={`${node.label}: ${option.label}`}
							data-ctx-item
							className={on ? "ctx-option ctx-option-on" : "ctx-option"}
							onClick={() => node.pick(option.id)}
						>
							{option.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function Mark({ node }: { node: MenuAction | MenuSub | MenuName }) {
	if (node.kind === "action" && node.glyph !== undefined) {
		return (
			<span className="ctx-mark ctx-mark-wide">
				{node.glyph === "auto" ? (
					<span className="layout-auto">Auto</span>
				) : (
					<LayoutGlyph layout={node.glyph} />
				)}
			</span>
		);
	}
	if (node.kind === "action" && node.tally !== undefined) {
		return (
			<span className="ctx-mark" data-state={node.tally}>
				<span className="tally" />
			</span>
		);
	}
	const Icon = node.icon;
	return <span className="ctx-mark">{Icon && <Icon size={14} aria-hidden="true" />}</span>;
}

function ActionRow({
	node,
	onHover,
	onDone,
}: {
	node: MenuAction;
	onHover: (row: HTMLElement) => void;
	onDone: () => void;
}) {
	const [armed, setArmed] = useState(false);
	const classes = ["ctx-item"];
	if (node.danger) classes.push("ctx-danger");
	if (armed) classes.push("ctx-armed");
	return (
		<button
			type="button"
			{...(node.checked === undefined
				? { role: "menuitem" }
				: { role: "menuitemradio", "aria-checked": node.checked })}
			aria-disabled={node.disabled}
			data-ctx-item
			className={classes.join(" ")}
			onPointerEnter={(event) => {
				if (event.pointerType !== "touch") onHover(event.currentTarget);
			}}
			onBlur={() => setArmed(false)}
			onClick={() => {
				if (node.disabled) return;
				if (node.confirm && !armed) {
					setArmed(true);
					return;
				}
				node.run();
				onDone();
			}}
		>
			<Mark node={node} />
			<span className="ctx-label">{armed ? node.confirm : node.label}</span>
			{node.note && <span className="ctx-note">{node.note}</span>}
			{node.keys && <kbd className="ctx-keys">{node.keys}</kbd>}
			{node.checked && <span className="ctx-check" aria-hidden="true" />}
		</button>
	);
}

function NameRow({
	node,
	onHover,
	onDone,
}: {
	node: MenuName;
	onHover: (row: HTMLElement) => void;
	onDone: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const refocus = useRef(false);
	useEffect(() => {
		if (!editing && refocus.current) button.current?.focus();
		refocus.current = false;
	}, [editing]);

	if (!editing) {
		return (
			<button
				ref={button}
				type="button"
				role="menuitem"
				data-ctx-item
				className="ctx-item"
				onPointerEnter={(event) => {
					if (event.pointerType !== "touch") onHover(event.currentTarget);
				}}
				onClick={() => setEditing(true)}
			>
				<Mark node={node} />
				<span className="ctx-label">{node.label}</span>
			</button>
		);
	}
	return (
		<form
			className="ctx-name"
			onSubmit={(event) => {
				event.preventDefault();
				const name = new FormData(event.currentTarget).get("name");
				const text = typeof name === "string" ? name.trim() : "";
				if (text !== "" && text !== node.value) node.save(text);
				onDone();
			}}
		>
			<input
				className="field ctx-field"
				name="name"
				aria-label={node.label}
				placeholder={node.placeholder}
				defaultValue={node.value}
				maxLength={60}
				autoComplete="off"
				// biome-ignore lint/a11y/noAutofocus: the row was pressed to type here
				autoFocus
				onFocus={(event) => event.currentTarget.select()}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					refocus.current = true;
					setEditing(false);
				}}
			/>
		</form>
	);
}

function SubRow({
	node,
	expanded,
	onHover,
	onOpen,
}: {
	node: MenuSub;
	expanded: boolean;
	onHover: (row: HTMLElement) => void;
	onOpen: (row: HTMLElement, viaKeys: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			aria-haspopup="menu"
			aria-expanded={expanded}
			data-ctx-item
			data-ctx-sub={node.label}
			className={expanded ? "ctx-item ctx-item-open" : "ctx-item"}
			onPointerEnter={(event) => {
				if (event.pointerType !== "touch") onHover(event.currentTarget);
			}}
			onClick={(event) => onOpen(event.currentTarget, event.detail === 0)}
		>
			<Mark node={node} />
			<span className="ctx-label">{node.label}</span>
			{node.note && <span className="ctx-note">{node.note}</span>}
			<ChevronRight className="ctx-more" size={14} aria-hidden="true" />
		</button>
	);
}

function matches(nodes: readonly MenuNode[], needle: string): MenuNode[] {
	if (needle === "") return [...nodes];
	return nodes.filter(
		(node) => node.kind === "action" && node.label.toLowerCase().includes(needle),
	);
}

function Head({ head }: { head: MenuHead }) {
	return (
		<div className="ctx-head" data-state={head.state}>
			{head.state && <span className="tally" aria-hidden="true" />}
			<span className="ctx-head-name">{head.name}</span>
			{head.info !== "" && <span className="ctx-head-info">{head.info}</span>}
		</div>
	);
}

type Opened = { label: string; rect: DOMRect };

function Panel({
	nodes,
	head,
	title,
	filter,
	point,
	anchor,
	sheet,
	focusFirst,
	wide,
	expanded,
	onPointerInside,
	onRowHover,
	onSubHover,
	onSubOpen,
	onBack,
	onDone,
}: {
	nodes: readonly MenuNode[];
	head: MenuHead | null;
	title: string;
	filter: string | undefined;
	point: { x: number; y: number };
	anchor: DOMRect | null;
	sheet: boolean;
	focusFirst: boolean;
	wide: boolean;
	expanded: string | undefined;
	onPointerInside: () => void;
	onRowHover: (row: HTMLElement) => void;
	onSubHover: (label: string, row: HTMLElement) => void;
	onSubOpen: (label: string, row: HTMLElement, viaKeys: boolean) => void;
	onBack: (() => void) | null;
	onDone: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const shown = useMemo(() => matches(nodes, needle), [nodes, needle]);

	useLayoutEffect(() => {
		const panel = ref.current;
		if (!panel || sheet) return;
		const { offsetWidth: width, offsetHeight: height } = panel;
		const right = innerWidth - EDGE;
		const bottom = innerHeight - EDGE;
		const flips = anchor
			? { x: anchor.right + width > right, y: false }
			: { x: point.x + width > right, y: point.y + height > bottom };
		let left = anchor ? anchor.right - 3 : point.x;
		if (flips.x) left = (anchor ? anchor.left + 3 : point.x) - width;
		let top = anchor ? anchor.top - 5 : point.y;
		if (flips.y) top = point.y - height;
		panel.style.left = `${Math.max(EDGE, Math.min(left, right - width))}px`;
		panel.style.top = `${Math.max(EDGE, Math.min(top, bottom - height))}px`;
		panel.style.transformOrigin = `${flips.x ? "right" : "left"} ${flips.y ? "bottom" : "top"}`;
	});

	// Only on arrival. Once a panel is open, the keys and the pointer move focus themselves.
	const arrival = useRef({ focusFirst, filter, anchor });
	useEffect(() => {
		const panel = ref.current;
		const first = arrival.current;
		if (!panel) return;
		if (first.focusFirst) {
			const box = first.filter ? panel.querySelector("input") : null;
			focusRow(box ?? stops(panel, null)[0]);
		} else if (!first.anchor) {
			panel.focus({ preventScroll: true });
		}
	}, []);

	const classes = ["ctx-panel"];
	if (sheet) classes.push("ctx-sheet");
	if (wide) classes.push("ctx-panel-wide");

	return (
		<div
			ref={ref}
			role="menu"
			aria-label={title}
			tabIndex={-1}
			className={classes.join(" ")}
			onPointerEnter={onPointerInside}
			onPointerLeave={(event) => {
				const focused = document.activeElement;
				if (event.pointerType === "touch" || !(focused instanceof HTMLElement)) return;
				if (!(focused instanceof HTMLInputElement) && event.currentTarget.contains(focused)) {
					focused.blur();
				}
			}}
		>
			{head && <Head head={head} />}
			{onBack && (
				<button type="button" className="ctx-back" onClick={onBack}>
					<ChevronLeft size={16} aria-hidden="true" />
					{title}
				</button>
			)}
			{filter && (
				<label className="ctx-filter">
					<Search size={13} aria-hidden="true" />
					<input
						type="search"
						aria-label={filter}
						placeholder={filter}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
			)}
			<div className="ctx-body">
				{shown.length === 0 && <p className="ctx-empty">Nothing matches {query}</p>}
				{shown.map((node, i) => {
					const key = `${node.kind}-${"label" in node ? node.label : i}`;
					switch (node.kind) {
						case "rule":
							return <hr key={key} className="ctx-rule" />;
						case "section":
							return (
								<p key={key} className="ctx-section">
									{node.label}
								</p>
							);
						case "segment":
							return <Segment key={key} node={node} />;
						case "tiles":
							return <TileMap key={key} node={node} onDone={onDone} />;
						case "name":
							return <NameRow key={key} node={node} onHover={onRowHover} onDone={onDone} />;
						case "sub":
							return (
								<SubRow
									key={key}
									node={node}
									expanded={expanded === node.label}
									onHover={(row) => onSubHover(node.label, row)}
									onOpen={(row, viaKeys) => onSubOpen(node.label, row, viaKeys)}
								/>
							);
						case "action":
							return <ActionRow key={key} node={node} onHover={onRowHover} onDone={onDone} />;
						default: {
							const _exhaustive: never = node;
							return _exhaustive;
						}
					}
				})}
			</div>
		</div>
	);
}

function letterOf(row: HTMLElement): string {
	return row.querySelector(".ctx-label")?.textContent?.toLowerCase() ?? "";
}

/** The menu host. Right clicks open it, and it stays above whatever dialog is open. */
export function ContextMenu({
	spec,
	x,
	y,
	keyboard,
	sheet,
	onClose,
}: {
	spec: MenuSpec;
	x: number;
	y: number;
	keyboard: boolean;
	sheet: boolean;
	onClose: () => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
	const openedAt = useRef(Date.now());
	const [path, setPath] = useState<Opened[]>([]);
	const [viaKeys, setViaKeys] = useState(keyboard);
	const host = useMemo(() => document.querySelector("dialog[open]") ?? document.body, []);
	const before = useRef(document.activeElement);

	const levels: { nodes: MenuNode[]; title: string; filter: string | undefined }[] = [
		{ nodes: spec.nodes, title: spec.head?.name ?? "Actions", filter: undefined },
	];
	for (const step of path) {
		const sub = levels
			.at(-1)
			?.nodes.find((node) => node.kind === "sub" && node.label === step.label);
		if (sub?.kind !== "sub") break;
		levels.push({ nodes: sub.items, title: sub.label, filter: sub.filter });
	}

	const trim = useCallback((depth: number) => {
		clearTimeout(hover.current);
		setPath((previous) => (previous.length > depth ? previous.slice(0, depth) : previous));
	}, []);

	const enter = useCallback((depth: number, label: string, row: HTMLElement) => {
		clearTimeout(hover.current);
		const rect = row.getBoundingClientRect();
		setPath((previous) =>
			previous[depth]?.label === label ? previous : [...previous.slice(0, depth), { label, rect }],
		);
	}, []);

	useEffect(() => {
		const element = before.current;
		return () => {
			clearTimeout(hover.current);
			if (element instanceof HTMLElement) element.focus({ preventScroll: true });
		};
	}, []);

	useEffect(() => {
		const away = (event: Event) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) onClose();
		};
		const resized = () => {
			if (!sheet) onClose();
		};
		document.addEventListener("pointerdown", away, true);
		document.addEventListener("scroll", away, true);
		window.addEventListener("blur", onClose);
		window.addEventListener("resize", resized);
		return () => {
			document.removeEventListener("pointerdown", away, true);
			document.removeEventListener("scroll", away, true);
			window.removeEventListener("blur", onClose);
			window.removeEventListener("resize", resized);
		};
	}, [onClose, sheet]);

	useEffect(() => {
		let typed = "";
		let typedAt = 0;
		const onKey = (event: KeyboardEvent) => {
			const box = root.current;
			if (!box) return;
			const focused = document.activeElement;
			const panels = [...box.querySelectorAll(".ctx-panel")];
			const panel = focused?.closest(".ctx-panel") ?? panels.at(-1);
			if (!panel) return;
			const depth = panels.indexOf(panel);
			const inField = focused instanceof HTMLInputElement;
			if (inField && focused.name === "name") return;
			const row = focused instanceof HTMLElement ? focused : null;
			const list = stops(panel, row);
			const at = row ? list.indexOf(row) : -1;

			const handled = () => {
				event.preventDefault();
				event.stopPropagation();
				setViaKeys(true);
			};
			const back = () => {
				const opener = depth > 0 ? panels[depth - 1] : null;
				trim(depth - 1);
				const label = path[depth - 1]?.label;
				const parent = opener?.querySelector<HTMLElement>(
					`[data-ctx-sub="${CSS.escape(label ?? "")}"]`,
				);
				focusRow(parent ?? undefined);
			};

			switch (event.key) {
				case "Escape":
					handled();
					if (depth > 0) back();
					else onClose();
					return;
				case "Tab":
					handled();
					onClose();
					return;
				case "ArrowDown":
					handled();
					focusRow(list[(at + 1) % list.length]);
					return;
				case "ArrowUp":
					handled();
					focusRow(list[at <= 0 ? list.length - 1 : at - 1]);
					return;
				case "Home":
					if (inField) return;
					handled();
					focusRow(list[0]);
					return;
				case "End":
					if (inField) return;
					handled();
					focusRow(list.at(-1));
					return;
				case "ArrowRight":
				case "ArrowLeft": {
					if (inField) return;
					const group = row?.closest("[data-ctx-cells]");
					if (group && row) {
						handled();
						const cells = rowsOf(group);
						const delta = event.key === "ArrowRight" ? 1 : -1;
						focusRow(cells[(cells.indexOf(row) + delta + cells.length) % cells.length]);
						return;
					}
					if (event.key === "ArrowLeft") {
						if (depth > 0) {
							handled();
							back();
						}
						return;
					}
					if (row?.dataset.ctxSub) {
						handled();
						enter(depth, row.dataset.ctxSub, row);
					}
					return;
				}
				default:
			}
			if (inField || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			if (event.key === " ") return;
			const filter = panel.querySelector("input");
			if (filter) {
				filter.focus();
				return;
			}
			handled();
			const now = Date.now();
			typed = now - typedAt > 600 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
			typedAt = now;
			const start = typed.length === 1 ? at + 1 : Math.max(at, 0);
			const ordered = [...list.slice(start), ...list.slice(0, start)];
			focusRow(ordered.find((item) => letterOf(item).startsWith(typed)));
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [path, enter, onClose, trim]);

	// A row under the pointer takes focus, so one highlight serves the mouse and the keys.
	// A text box keeps it, or passing over a row would cut off what is being typed.
	const pointAt = (row: HTMLElement) => {
		if (!(document.activeElement instanceof HTMLInputElement)) row.focus();
		clearTimeout(hover.current);
	};

	const shown = sheet ? levels.slice(-1) : levels;
	const first = levels.length - shown.length;
	return createPortal(
		<div ref={root} className="ctx">
			{sheet && (
				<button
					type="button"
					className="ctx-scrim"
					aria-label="Close the menu"
					onClick={() => {
						if (Date.now() - openedAt.current > SHEET_GUARD_MS) onClose();
					}}
				/>
			)}
			{shown.map((level, i) => {
				const depth = first + i;
				return (
					<Panel
						key={
							path
								.slice(0, depth)
								.map((step) => step.label)
								.join("/") || "root"
						}
						nodes={level.nodes}
						head={depth === 0 ? spec.head : null}
						title={level.title}
						filter={level.filter}
						point={{ x, y }}
						anchor={path[depth - 1]?.rect ?? null}
						sheet={sheet}
						focusFirst={viaKeys}
						wide={level.nodes.some((node) => node.kind === "action" && node.glyph !== undefined)}
						expanded={path[depth]?.label}
						onPointerInside={() => clearTimeout(hover.current)}
						onRowHover={(row) => {
							pointAt(row);
							hover.current = setTimeout(() => trim(depth), HOVER_MS);
						}}
						onSubHover={(label, row) => {
							pointAt(row);
							hover.current = setTimeout(() => {
								setViaKeys(false);
								enter(depth, label, row);
							}, HOVER_MS);
						}}
						onSubOpen={(label, row, keys) => {
							setViaKeys(keys);
							enter(depth, label, row);
						}}
						onBack={sheet && depth > 0 ? () => trim(depth - 1) : null}
						onDone={onClose}
					/>
				);
			})}
		</div>,
		host,
	);
}
