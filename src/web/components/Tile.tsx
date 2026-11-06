import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Camera as CameraIcon, Maximize2, Minimize2, VideoOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { QualityChoice } from "@/shared/quality";
import type { PublicCamera, Quality } from "@/shared/schema";
import { MsePlayer, type PlayerState, type PlayerStats } from "@/web/lib/player";
import { saveSnapshot } from "@/web/lib/snapshot";
import { clearTile, reportTile } from "@/web/lib/status";
import { dragId } from "@/web/lib/wall";

const STATE_TEXT: Record<PlayerState, string> = {
	idle: "Paused",
	waiting: "Waiting",
	connecting: "Connecting",
	live: "Live",
	retrying: "No signal, retrying",
};

const NEXT_CHOICE: Record<QualityChoice, QualityChoice> = {
	auto: "main",
	main: "sub",
	sub: "auto",
};
const CHOICE_TEXT: Record<QualityChoice, string> = { auto: "Auto", main: "HD", sub: "SD" };

function rate(kbps: number): string {
	return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`;
}

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
	onSelect: () => void;
	onOpen: () => void;
	onClose: () => void;
	onClear: () => void;
	onChoice: (choice: QualityChoice) => void;
};

export function Tile({
	index,
	camera,
	quality,
	choice,
	selected,
	full,
	active,
	onSelect,
	onOpen,
	onClose,
	onClear,
	onChoice,
}: TileProps) {
	const root = useRef<HTMLDivElement>(null);
	const video = useRef<HTMLVideoElement>(null);
	const [onScreen, setOnScreen] = useState(false);
	const [state, setState] = useState<PlayerState>("idle");
	const [stats, setStats] = useState<PlayerStats | null>(null);

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
		if (cameraId === null || !element || !onScreen || !active) return;
		const player = new MsePlayer(element, socketUrl(cameraId, quality), {
			onState: (next) => {
				setState(next);
				reportTile({ tile: index, camera: cameraId, state: next });
				if (next !== "live") setStats(null);
			},
			onStats: setStats,
		});
		player.start();
		return () => {
			player.stop();
			clearTile(index);
		};
	}, [cameraId, quality, onScreen, active, index]);

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
			<div ref={setRoot} className={`${classes.join(" ")} tile-empty`} data-tile={index}>
				<button type="button" className="tile-hole" onClick={onSelect}>
					{selected ? "Pick a camera from the list" : "Empty. Drag a camera here."}
				</button>
			</div>
		);
	}

	const lost = state === "retrying";
	return (
		<div ref={setRoot} className={classes.join(" ")} data-tile={index} data-state={state}>
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
					{state === "live" && stats ? (
						<>
							{quality === "main" ? "HD" : "SD"} {rate(stats.kbps)}
						</>
					) : (
						STATE_TEXT[state]
					)}
				</span>
			</div>
		</div>
	);
}
