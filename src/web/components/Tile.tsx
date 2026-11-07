import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Camera as CameraIcon, History, Maximize2, Minimize2, VideoOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { QualityChoice } from "@/shared/quality";
import type { PublicCamera, Quality } from "@/shared/schema";
import { MsePlayer, type PlayerState, type PlayerStats } from "@/web/lib/player";
import { saveSnapshot } from "@/web/lib/snapshot";
import { clearTile, rateText, reportRate, reportTile, STATE_TEXT } from "@/web/lib/status";
import { dragId, menuId } from "@/web/lib/wall";

const NEXT_CHOICE: Record<QualityChoice, QualityChoice> = {
	auto: "main",
	main: "sub",
	sub: "auto",
};
const CHOICE_TEXT: Record<QualityChoice, string> = { auto: "Auto", main: "HD", sub: "SD" };

function socketUrl(camera: string, quality: Quality): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/ws/${camera}/${quality}`;
}

export type TileProps = {
	index: number;
	camera: PublicCamera | null;
	quality: Quality;
	choice: QualityChoice;
	selected: boolean;
	full: boolean;
	active: boolean;
	/** Goes up by one to drop the stream and open it again. */
	restart: number;
	onSelect: () => void;
	onOpen: () => void;
	onClose: () => void;
	onClear: () => void;
	onChoice: (choice: QualityChoice) => void;
	onReplay: () => void;
};

export function Tile({
	index,
	camera,
	quality,
	choice,
	selected,
	full,
	active,
	restart,
	onSelect,
	onOpen,
	onClose,
	onClear,
	onChoice,
	onReplay,
}: TileProps) {
	const root = useRef<HTMLDivElement>(null);
	const video = useRef<HTMLVideoElement>(null);
	const [onScreen, setOnScreen] = useState(false);
	const [state, setState] = useState<PlayerState>("idle");
	const [stats, setStats] = useState<PlayerStats | null>(null);
	const [poppedOut, setPoppedOut] = useState(false);

	const drop = useDroppable({ id: dragId.tile(index), disabled: full });
	const drag = useDraggable({ id: dragId.tile(index), disabled: full || camera === null });

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const observer = new IntersectionObserver((entries) => {
			const entry = entries.at(-1);
			if (entry) setOnScreen(entry.isIntersecting);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const cameraId = camera?.id ?? null;

	useEffect(() => {
		const element = video.current;
		if (cameraId === null || !element) return;
		const entered = () => setPoppedOut(true);
		const left = () => setPoppedOut(false);
		element.addEventListener("enterpictureinpicture", entered);
		element.addEventListener("leavepictureinpicture", left);
		return () => {
			element.removeEventListener("enterpictureinpicture", entered);
			element.removeEventListener("leavepictureinpicture", left);
		};
	}, [cameraId]);

	// A popped out picture is the one thing worth playing while this tab is hidden.
	const playing = poppedOut || (onScreen && active);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new `restart` is what reopens the stream
	useEffect(() => {
		const element = video.current;
		if (cameraId === null || !element || !playing) return;
		const player = new MsePlayer(element, socketUrl(cameraId, quality), {
			onState: (next) => {
				setState(next);
				reportTile({ tile: index, camera: cameraId, state: next });
				if (next !== "live") setStats(null);
			},
			onStats: (next) => {
				setStats(next);
				reportRate(index, rateText(quality, next.kbps));
			},
		});
		player.start();
		return () => {
			player.stop();
			clearTile(index);
		};
	}, [cameraId, quality, playing, index, restart]);

	const setRoot = (element: HTMLDivElement | null) => {
		root.current = element;
		drop.setNodeRef(element);
	};

	const classes = ["tile"];
	if (selected) classes.push("tile-selected");
	if (drop.isOver) classes.push("tile-over");
	if (drag.isDragging) classes.push("tile-dragging");

	if (camera === null) {
		return (
			<div
				ref={setRoot}
				className={`${classes.join(" ")} tile-empty`}
				data-tile={index}
				data-menu={menuId.tile(index)}
			>
				<button type="button" className="tile-hole" onClick={onSelect}>
					{selected ? "Pick a camera from the list" : "Empty. Drag a camera here."}
				</button>
			</div>
		);
	}

	const lost = state === "retrying";
	return (
		<div
			ref={setRoot}
			className={classes.join(" ")}
			data-tile={index}
			data-state={state}
			data-menu={menuId.tile(index)}
		>
			{/* The picture is a pointer shortcut. The strip's buttons do the same from a keyboard. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users select with the arrow keys */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
			<div className="picture" onClick={onSelect} onDoubleClick={full ? onClose : onOpen}>
				<video ref={video} muted playsInline aria-label={camera.name} />
				{state !== "live" && (
					<div className={lost ? "picture-note picture-note-lost" : "picture-note"}>
						{lost && <VideoOff size={18} aria-hidden="true" />}
						{STATE_TEXT[state]}
					</div>
				)}
			</div>
			<div className="strip">
				<span className="tally" aria-hidden="true" />
				<span className="strip-name" ref={drag.setNodeRef} {...drag.listeners}>
					{camera.name}
				</span>
				<span className="strip-tools">
					<button
						type="button"
						className="strip-tool strip-tool-text"
						title="Change picture quality"
						aria-label={`Picture quality: ${CHOICE_TEXT[choice]}. Change it.`}
						onClick={() => onChoice(NEXT_CHOICE[choice])}
					>
						{CHOICE_TEXT[choice]}
					</button>
					{camera.hasReplay && (
						<button
							type="button"
							className="strip-tool"
							title="Play back recordings (P)"
							aria-label={`Play back recordings from ${camera.name}`}
							onClick={onReplay}
						>
							<History size={14} />
						</button>
					)}
					<button
						type="button"
						className="strip-tool"
						title="Save a snapshot"
						aria-label={`Save a snapshot of ${camera.name}`}
						onClick={() => {
							if (video.current) saveSnapshot({ video: video.current, name: camera.name });
						}}
					>
						<CameraIcon size={14} />
					</button>
					{!full && (
						<button
							type="button"
							className="strip-tool"
							title="Clear this tile"
							aria-label={`Remove ${camera.name} from this tile`}
							onClick={onClear}
						>
							<X size={14} />
						</button>
					)}
					<button
						type="button"
						className="strip-tool"
						title={full ? "Back to the wall" : "Open full view"}
						aria-label={full ? "Back to the wall" : `Open ${camera.name} in full view`}
						onClick={full ? onClose : onOpen}
					>
						{full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
					</button>
				</span>
				<span className="strip-info">
					{state === "live" && stats ? rateText(quality, stats.kbps) : STATE_TEXT[state]}
				</span>
			</div>
		</div>
	);
}
