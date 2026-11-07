import { Camera as CameraIcon, Maximize2 } from "lucide-react";
import {
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { MAIN_CAP, MAIN_MIN_WIDTH, type QualityChoice } from "@/shared/quality";
import { type CameraId, MAX_REPLAY_TRACKS, type PublicCamera, type Quality } from "@/shared/schema";
import type { ReplayControls } from "@/web/components/Replay";
import { PlaybackNote, ReplayBar, Timeline, usePlaybackKeys } from "@/web/components/ReplayParts";
import { type Fit, gridStyle, useWallLayout } from "@/web/components/Wall";
import { useMedia, useSize } from "@/web/lib/hooks";
import { usePlayback } from "@/web/lib/playback";
import { saveSnapshot } from "@/web/lib/snapshot";
import type { Moment, ZoomHours } from "@/web/lib/timeline";
import { menuId, type WallState } from "@/web/lib/wall";

const CHOICE_TEXT: Record<QualityChoice, string> = { auto: "Auto", main: "HD", sub: "SD" };
const NEXT_CHOICE: Record<QualityChoice, QualityChoice> = {
	auto: "main",
	main: "sub",
	sub: "auto",
};
/** Scrolling on a phone changes what is on screen. This long still, and playback follows. */
const SETTLE_MS = 300;

type TileNote = string | null;

function ReplayTile({
	index,
	camera,
	note,
	dim,
	selected,
	register,
	onScreen,
	onSelect,
	onOpen,
}: {
	index: number;
	camera: PublicCamera | null;
	note: TileNote;
	/** Nothing recorded here right now, so the last picture is old. */
	dim: boolean;
	selected: boolean;
	register: (index: number, video: HTMLVideoElement | null) => void;
	onScreen: (index: number, on: boolean) => void;
	onSelect: () => void;
	onOpen: () => void;
}) {
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const observer = new IntersectionObserver((entries) => {
			const entry = entries.at(-1);
			if (entry) onScreen(index, entry.isIntersecting);
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
			onScreen(index, false);
		};
	}, [index, onScreen]);

	const classes = ["tile", "replay-tile"];
	if (selected) classes.push("tile-selected");
	if (camera === null) {
		return <div ref={root} className={`${classes.join(" ")} tile-empty`} data-tile={index} />;
	}
	return (
		<div
			ref={root}
			className={classes.join(" ")}
			data-tile={index}
			data-cover={dim ? "none" : undefined}
			data-menu={menuId.replayTile(camera.id)}
		>
			{/* The picture is a pointer shortcut. The strip's buttons do the same from a keyboard. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter opens the selected tile */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
			<div className="picture" onClick={onSelect} onDoubleClick={onOpen}>
				{camera.hasReplay && (
					<video
						ref={(element) => register(index, element)}
						muted
						playsInline
						aria-label={camera.name}
					/>
				)}
				{note && <div className="picture-note">{note}</div>}
			</div>
			<div className="strip">
				<span className="tally" aria-hidden="true" />
				<span className="strip-name">{camera.name}</span>
				{camera.hasReplay && (
					<span className="strip-tools">
						<button
							type="button"
							className="strip-tool"
							title="Save a snapshot"
							aria-label={`Save a snapshot of ${camera.name}`}
							onClick={() => {
								const video = root.current?.querySelector("video");
								if (video) saveSnapshot({ video, name: camera.name });
							}}
						>
							<CameraIcon size={14} />
						</button>
						<button
							type="button"
							className="strip-tool"
							title="Open full view, same moment"
							aria-label={`Open ${camera.name} in full view`}
							onClick={onOpen}
						>
							<Maximize2 size={14} />
						</button>
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * The open view's wall, played back. Every camera on screen with a recorder plays from one
 * socket on one clock, so the tiles stay in step the way the recorder's own client keeps them.
 */
export function ReplayWall({
	wall,
	cameras,
	fit,
	compact,
	at,
	controls,
	onSelect,
	onOpen,
	onClose,
}: {
	wall: WallState;
	cameras: ReadonlyMap<CameraId, PublicCamera>;
	fit: Fit;
	compact: boolean;
	at: Moment | null;
	controls?: Ref<ReplayControls>;
	onSelect: (index: number | null) => void;
	/** One camera in full view, at the same moment. */
	onOpen: (camera: CameraId) => void;
	onClose: () => void;
}) {
	const grid = useRef<HTMLDivElement>(null);
	const { width, height } = useSize(grid);
	const { view, placed } = useWallLayout({ width, height, wall, fit, compact });
	const [choice, setChoice] = useState<QualityChoice>("auto");
	const [zoom, setZoom] = useState<ZoomHours>(24);
	const wide = useMedia("(min-width: 900px)");

	// Which tiles are on screen. A tile reports itself, and playback waits for scrolling to stop.
	const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());
	const seen = useRef(new Set<number>());
	const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const onScreen = useCallback((index: number, on: boolean) => {
		if (on) seen.current.add(index);
		else seen.current.delete(index);
		clearTimeout(settle.current);
		settle.current = setTimeout(() => setVisible(new Set(seen.current)), SETTLE_MS);
	}, []);
	useEffect(() => () => clearTimeout(settle.current), []);

	const elements = useRef(new Map<number, HTMLVideoElement>());
	const register = useCallback((index: number, video: HTMLVideoElement | null) => {
		if (video) elements.current.set(index, video);
		else elements.current.delete(index);
	}, []);

	/** The tiles that play, in track order. A socket carries at most 32. */
	const playing = useMemo(
		() =>
			placed
				.filter((tile) => {
					const camera = tile.camera ? cameras.get(tile.camera) : undefined;
					return camera?.hasReplay === true && visible.has(tile.index);
				})
				.slice(0, MAX_REPLAY_TRACKS),
		[placed, cameras, visible],
	);
	const tracks = useMemo(
		() =>
			playing.flatMap((tile) => (tile.camera ? [{ key: tile.index, camera: tile.camera }] : [])),
		[playing],
	);
	const playingIndexes = useMemo(() => new Set(playing.map((tile) => tile.index)), [playing]);
	/** Every camera on the page with a recorder, for the days and the timeline. */
	const scope = useMemo(() => {
		const ids = placed.flatMap((tile) =>
			tile.camera && cameras.get(tile.camera)?.hasReplay ? [tile.camera] : [],
		);
		return [...new Set(ids)];
	}, [placed, cameras]);

	// Like live, big tiles get the big stream. A recorder plays one quality at a time, so all of
	// them have to be big enough, and few enough.
	const quality: Quality = useMemo(() => {
		if (choice !== "auto") return choice;
		const scale = window.devicePixelRatio;
		const big = playing.every((tile) => tile.width * scale >= MAIN_MIN_WIDTH);
		return playing.length > 0 && playing.length <= MAIN_CAP && big ? "main" : "sub";
	}, [choice, playing]);

	const video = useCallback((key: number) => elements.current.get(key) ?? null, []);
	const playback = usePlayback({ scope, tracks, restart: "", quality, at, video });
	const { day, position, paused, rate, seek, toggle, setRate, covered, state } = playback;

	const selectedSlot = wall.selected === null ? null : (wall.slots[wall.selected] ?? null);
	const selectedCamera = selectedSlot ? (cameras.get(selectedSlot) ?? null) : null;
	const videoOf = useCallback(
		(camera: CameraId) => {
			const tile = playing.find((t) => t.camera === camera);
			return tile ? (elements.current.get(tile.index) ?? null) : null;
		},
		[playing],
	);
	const snapshot = useCallback(() => {
		const video = selectedCamera ? videoOf(selectedCamera.id) : null;
		if (selectedCamera && video) saveSnapshot({ video, name: selectedCamera.name });
	}, [selectedCamera, videoOf]);

	useImperativeHandle(
		controls,
		() => ({
			status: () => ({ day, position, playing: !paused, rate, quality: choice }),
			toggle,
			skip: (ms) => seek(position + ms),
			setRate,
			setQuality: setChoice,
			step: () => undefined,
			video: videoOf,
		}),
		[day, position, paused, rate, choice, toggle, seek, setRate, videoOf],
	);

	const openSelected = useCallback(() => {
		if (selectedCamera?.hasReplay) onOpen(selectedCamera.id);
	}, [selectedCamera, onOpen]);

	usePlaybackKeys(playback, { s: snapshot, Enter: openSelected, Escape: onClose });

	const waiting = state === "opening" || state === "buffering";
	const noteFor = (index: number, camera: PublicCamera | null): TileNote => {
		if (camera === null) return null;
		if (!camera.hasReplay) return "No recorder linked";
		if (!playingIndexes.has(index)) return visible.has(index) ? "Too many to play at once" : null;
		const here = covered.get(index);
		if (here) return null;
		return waiting || here === undefined ? "Fetching video" : "Nothing recorded at this moment";
	};
	const anyRecorded = placed.some((tile) => tile.camera && cameras.get(tile.camera)?.hasReplay);
	const wallNote =
		placed.length > 0 && !anyRecorded
			? "Nothing on this page has a recorder linked."
			: playback.failed || state === "ended"
				? playback.note
				: null;

	return (
		<section
			className="replay replay-wall"
			aria-label="Recordings from the wall"
			data-menu={menuId.replay}
		>
			<div ref={grid} className={compact ? "replay-grid replay-grid-scroll" : "replay-grid"}>
				{view && (
					<div className={`wall-box wall-${fit}`} style={gridStyle(view)}>
						{placed.map((tile) => {
							const camera = tile.camera ? (cameras.get(tile.camera) ?? null) : null;
							return (
								<div
									key={tile.index}
									className="cell"
									style={{ gridColumn: tile.column, gridRow: tile.row }}
								>
									<ReplayTile
										index={tile.index}
										camera={camera}
										note={noteFor(tile.index, camera)}
										dim={covered.get(tile.index) === false}
										selected={wall.selected === tile.index}
										register={register}
										onScreen={onScreen}
										onSelect={() => onSelect(wall.selected === tile.index ? null : tile.index)}
										onOpen={() => {
											if (camera?.hasReplay) onOpen(camera.id);
										}}
									/>
								</div>
							);
						})}
					</div>
				)}
				{wallNote && (
					<div className="replay-wall-note">
						<PlaybackNote playback={{ ...playback, note: wallNote }} />
					</div>
				)}
			</div>
			<Timeline spans={playback.spans} position={position} zoom={zoom} wide={wide} onSeek={seek} />
			<ReplayBar
				playback={playback}
				zoom={zoom}
				onZoom={setZoom}
				quality={
					choice === "auto" ? `Auto ${quality === "main" ? "HD" : "SD"}` : CHOICE_TEXT[choice]
				}
				onQuality={() => setChoice(NEXT_CHOICE[choice])}
				clock
				onSnapshot={selectedCamera?.hasReplay ? snapshot : null}
				closeLabel="Leave playback"
				onClose={onClose}
			/>
		</section>
	);
}
