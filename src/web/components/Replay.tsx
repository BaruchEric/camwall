import { SkipBack, SkipForward } from "lucide-react";
import { type Ref, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { QualityChoice } from "@/shared/quality";
import type { CameraId, PublicCamera, Quality, ReplayRate } from "@/shared/schema";
import { PlaybackNote, ReplayBar, Timeline, usePlaybackKeys } from "@/web/components/ReplayParts";
import { useMedia } from "@/web/lib/hooks";
import type { ReplayStatus } from "@/web/lib/menus";
import { usePlayback } from "@/web/lib/playback";
import { saveSnapshot } from "@/web/lib/snapshot";
import { clockText, dayText, type Moment, type ZoomHours } from "@/web/lib/timeline";
import { menuId } from "@/web/lib/wall";

/** What the rest of the page may do to playback: its menus, mostly. */
export type ReplayControls = {
	status: () => ReplayStatus;
	toggle: () => void;
	skip: (ms: number) => void;
	setRate: (rate: ReplayRate) => void;
	setQuality: (quality: QualityChoice) => void;
	step: (delta: 1 | -1) => void;
	/** The picture of that camera, if playback shows it. */
	video: (camera: CameraId) => HTMLVideoElement | null;
};

/** One camera's recordings, filling the screen. */
export function ReplayView({
	camera,
	cameras,
	at,
	controls,
	onCamera,
	onClose,
}: {
	camera: CameraId;
	/** What the camera steps go through: the wall's cameras with recordings. */
	cameras: readonly PublicCamera[];
	/** Where to open, from a link or the wall. Null opens just before the newest footage. */
	at: Moment | null;
	controls?: Ref<ReplayControls>;
	onCamera: (camera: CameraId) => void;
	onClose: () => void;
}) {
	const video = useRef<HTMLVideoElement>(null);
	const [quality, setQuality] = useState<Quality>("main");
	const [zoom, setZoom] = useState<ZoomHours>(24);
	const wide = useMedia("(min-width: 900px)");
	const list = useMemo(() => [camera], [camera]);
	const videos = useCallback(() => [video.current], []);
	const playback = usePlayback({ cameras: list, quality, at, videos });
	const { day, position, paused, rate, seek, toggle, setRate } = playback;

	const here = cameras.findIndex((c) => c.id === camera);
	const name = cameras[here]?.name ?? "Camera";

	const stepCamera = useCallback(
		(delta: 1 | -1) => {
			const next = cameras[(here + delta + cameras.length) % cameras.length];
			if (next && next.id !== camera) onCamera(next.id);
		},
		[cameras, here, camera, onCamera],
	);

	const snapshot = useCallback(() => {
		if (video.current) saveSnapshot({ video: video.current, name });
	}, [name]);

	useImperativeHandle(
		controls,
		() => ({
			status: () => ({ day, position, playing: !paused, rate, quality }),
			toggle,
			skip: (ms) => seek(position + ms),
			setRate,
			setQuality: (choice) => setQuality(choice === "sub" ? "sub" : "main"),
			step: stepCamera,
			video: (id) => (id === camera ? video.current : null),
		}),
		[camera, day, position, paused, rate, quality, toggle, seek, setRate, stepCamera],
	);

	usePlaybackKeys(playback, {
		"[": () => stepCamera(-1),
		"]": () => stepCamera(1),
		s: snapshot,
		Escape: onClose,
	});

	return (
		<section className="replay" aria-label={`Recordings from ${name}`} data-menu={menuId.replay}>
			<div className="replay-picture">
				<video ref={video} muted playsInline aria-label={name} onClick={toggle} />
				<PlaybackNote playback={playback} />
				<div className="replay-stamp">
					<span>{name}</span>
					<time>
						{day ? dayText(day) : ""} {clockText(position)}
					</time>
				</div>
			</div>
			<Timeline spans={playback.spans} position={position} zoom={zoom} wide={wide} onSeek={seek} />
			<ReplayBar
				playback={playback}
				zoom={zoom}
				onZoom={setZoom}
				quality={quality === "main" ? "HD" : "SD"}
				onQuality={() => setQuality(quality === "main" ? "sub" : "main")}
				clock={false}
				onSnapshot={snapshot}
				closeLabel="Back to the wall"
				onClose={onClose}
			>
				<span className="replay-group">
					<button
						type="button"
						className="tool"
						aria-label="Previous camera, same moment"
						title="Previous camera, same moment ([)"
						onClick={() => stepCamera(-1)}
					>
						<SkipBack size={17} />
					</button>
					<select
						className="field replay-camera"
						aria-label="Camera"
						value={camera}
						onChange={(event) => {
							const next = cameras.find((c) => c.id === event.target.value);
							if (next) onCamera(next.id);
						}}
					>
						{cameras.map((item) => (
							<option key={item.id} value={item.id}>
								{item.name}
							</option>
						))}
					</select>
					<button
						type="button"
						className="tool"
						aria-label="Next camera, same moment"
						title="Next camera, same moment (])"
						onClick={() => stepCamera(1)}
					>
						<SkipForward size={17} />
					</button>
				</span>
			</ReplayBar>
		</section>
	);
}
