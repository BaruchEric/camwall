import {
	ChevronLeft,
	ChevronRight,
	CircleHelp,
	Expand,
	History,
	LayoutGrid,
	PanelLeft,
	Pause,
	Play,
	Radio,
	RectangleHorizontal,
	Scan,
} from "lucide-react";
import type { ReactNode } from "react";
import { LAYOUT_IDS, LAYOUT_LABELS, type LayoutId } from "@/shared/layouts";
import { LayoutGlyph } from "@/web/components/LayoutGlyph";
import { Menu } from "@/web/components/ui";
import type { Fit } from "@/web/components/Wall";
import { useClock } from "@/web/lib/hooks";
import { useStatuses } from "@/web/lib/status";
import { menuId, TOUR_SECONDS, type TourSeconds } from "@/web/lib/wall";

function Clock() {
	const now = useClock();
	return (
		<time className="clock" dateTime={now.toISOString()}>
			{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
		</time>
	);
}

function Health() {
	const statuses = useStatuses();
	const values = [...statuses.values()];
	const live = values.filter((state) => state === "live").length;
	const lost = values.filter((state) => state === "retrying").length;
	if (values.length === 0) return null;
	return (
		<span className="health" data-menu={menuId.health}>
			<span className="health-live">{live} live</span>
			{lost > 0 && <span className="health-lost">{lost} lost</span>}
		</span>
	);
}

export type Mode = "live" | "replay";

/** Live and playback are two ways to look at the same cameras, so one switch holds both. */
function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
	const option = (value: Mode, label: string, icon: ReactNode, title: string) => (
		<button
			type="button"
			className={mode === value ? "mode mode-on" : "mode"}
			data-mode={value}
			aria-pressed={mode === value}
			title={title}
			onClick={() => onMode(value)}
		>
			{icon}
			<span className="mode-text">{label}</span>
		</button>
	);
	return (
		<fieldset className="modes" aria-label="Live or playback">
			{option(
				"live",
				"Live",
				<Radio size={15} aria-hidden="true" />,
				mode === "live" ? "Live" : "Back to live (P)",
			)}
			{option(
				"replay",
				"Playback",
				<History size={15} aria-hidden="true" />,
				"Play back recordings (P)",
			)}
		</fieldset>
	);
}

export function TopBar({
	mode,
	canReplay,
	onMode,
	title,
	titleMenu,
	edited,
	savedView,
	layout,
	page,
	pages,
	fit,
	tour,
	tourSeconds,
	onRail,
	onPage,
	onLayout,
	onFit,
	onTour,
	onTourSeconds,
	onSave,
	onSaveAs,
	onRevert,
	onFullscreen,
	onHelp,
}: {
	mode: Mode;
	/** False until a recorder is linked, which leaves nothing to play back. */
	canReplay: boolean;
	onMode: (mode: Mode) => void;
	title: string;
	/** What a right click on the title is about: the camera in full view, or the open view. */
	titleMenu: string;
	edited: boolean;
	savedView: boolean;
	layout: LayoutId;
	page: number;
	pages: number;
	fit: Fit;
	tour: boolean;
	tourSeconds: TourSeconds;
	onRail: () => void;
	onPage: (page: number) => void;
	onLayout: (layout: LayoutId) => void;
	onFit: () => void;
	onTour: () => void;
	onTourSeconds: (seconds: TourSeconds) => void;
	onSave: () => void;
	onSaveAs: () => void;
	onRevert: () => void;
	onFullscreen: () => void;
	onHelp: () => void;
}) {
	const live = mode === "live";
	return (
		<header className="topbar" data-menu={live ? menuId.wall : menuId.replay}>
			<button
				type="button"
				className="tool"
				aria-label="Show or hide the camera list"
				title="Camera list (B)"
				onClick={onRail}
			>
				<PanelLeft size={17} />
			</button>
			{canReplay && <ModeSwitch mode={mode} onMode={onMode} />}
			<h1 className="title" data-menu={titleMenu}>
				{title}
			</h1>
			{live && edited && (
				<span className="edits">
					{savedView && (
						<button type="button" className="button button-primary" onClick={onSave}>
							Save
						</button>
					)}
					<button
						type="button"
						className={savedView ? "button button-quiet" : "button button-primary"}
						onClick={onSaveAs}
					>
						Save as view
					</button>
					<button type="button" className="button button-quiet" onClick={onRevert}>
						Revert
					</button>
				</span>
			)}
			{live && pages > 1 && (
				<span className="pager">
					<button
						type="button"
						className="tool"
						aria-label="Previous page"
						title="Previous page ([)"
						onClick={() => onPage(page - 1)}
					>
						<ChevronLeft size={17} />
					</button>
					<span className="pager-text">
						{page + 1} of {pages}
					</span>
					<button
						type="button"
						className="tool"
						aria-label="Next page"
						title="Next page (])"
						onClick={() => onPage(page + 1)}
					>
						<ChevronRight size={17} />
					</button>
				</span>
			)}
			<span className="topbar-gap" />
			<Health />
			<Clock />
			<span className="topbar-tools">
				{live && (
					<>
						<Menu label="Layout" button={<LayoutGrid size={17} />}>
							{(close) => (
								<div className="layout-grid">
									<button
										type="button"
										className={layout === "auto" ? "layout layout-on" : "layout"}
										title="Sizes itself to the cameras and the window"
										onClick={() => {
											onLayout("auto");
											close();
										}}
									>
										<span className="layout-auto">Auto</span>
										Fit all
									</button>
									{LAYOUT_IDS.map((id) => (
										<button
											key={id}
											type="button"
											className={layout === id ? "layout layout-on" : "layout"}
											onClick={() => {
												onLayout(id);
												close();
											}}
										>
											<LayoutGlyph layout={id} />
											{LAYOUT_LABELS[id]}
										</button>
									))}
								</div>
							)}
						</Menu>
						<button
							type="button"
							className="tool"
							aria-label={fit === "fit" ? "Fill each tile" : "Show the whole picture"}
							title={
								fit === "fit" ? "Fill each tile, cropping the edges" : "Show the whole picture"
							}
							onClick={onFit}
						>
							{fit === "fit" ? <Scan size={17} /> : <RectangleHorizontal size={17} />}
						</button>
						<Menu
							label="Tour"
							active={tour}
							button={tour ? <Pause size={17} /> : <Play size={17} />}
						>
							{(close) => (
								<div className="tour">
									<button
										type="button"
										className="button button-primary"
										onClick={() => {
											onTour();
											close();
										}}
									>
										{tour ? "Stop tour" : "Start tour"}
									</button>
									<p className="tour-note">Steps through pages, then views.</p>
									<fieldset className="tour-times" aria-label="Seconds per step">
										{TOUR_SECONDS.map((seconds) => (
											<button
												key={seconds}
												type="button"
												className={seconds === tourSeconds ? "chip chip-on" : "chip"}
												onClick={() => onTourSeconds(seconds)}
											>
												{seconds} s
											</button>
										))}
									</fieldset>
								</div>
							)}
						</Menu>
					</>
				)}
				<button
					type="button"
					className="tool"
					aria-label="Full screen"
					title="Full screen (F)"
					onClick={onFullscreen}
				>
					<Expand size={17} />
				</button>
				<button
					type="button"
					className="tool"
					aria-label="Keyboard shortcuts"
					title="Keyboard shortcuts (?)"
					onClick={onHelp}
				>
					<CircleHelp size={17} />
				</button>
			</span>
		</header>
	);
}
