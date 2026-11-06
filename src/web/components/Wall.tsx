import { type RefObject, useMemo } from "react";
import { autoGrid, type GridSpec, LAYOUTS } from "@/shared/layouts";
import { pickQuality, type QualityChoice } from "@/shared/quality";
import type { CameraId, PublicCamera } from "@/shared/schema";
import { Tile } from "@/web/components/Tile";
import { usePageVisible, useSize } from "@/web/lib/hooks";
import { cellsPerPage, type WallState } from "@/web/lib/wall";

const GAP = 3;
const STRIP = 26;
const RATIO = 16 / 9;
const FULL_TILE = -1;

export type Fit = "fit" | "fill";

type Placed = {
	index: number;
	camera: CameraId | null;
	column: string;
	row: string;
	width: number;
};

function place(spec: GridSpec, gridWidth: number, offset: number, wall: WallState): Placed[] {
	const column = (gridWidth - GAP * (spec.cols - 1)) / spec.cols;
	return spec.cells.map((cell, i) => {
		const index = offset + i;
		return {
			index,
			camera: wall.slots[index] ?? null,
			column: `${cell.x + 1} / span ${cell.w}`,
			row: `${cell.y + 1} / span ${cell.h}`,
			width: cell.w * column + (cell.w - 1) * GAP,
		};
	});
}

export function Wall({
	box,
	wall,
	cameras,
	fit,
	compact,
	choices,
	onSelect,
	onFocus,
	onClear,
	onChoice,
}: {
	box: RefObject<HTMLDivElement | null>;
	wall: WallState;
	cameras: ReadonlyMap<CameraId, PublicCamera>;
	fit: Fit;
	compact: boolean;
	choices: ReadonlyMap<CameraId, QualityChoice>;
	onSelect: (index: number) => void;
	onFocus: (camera: CameraId | null) => void;
	onClear: (index: number) => void;
	onChoice: (camera: CameraId, choice: QualityChoice) => void;
}) {
	const { width, height } = useSize(box);
	const active = usePageVisible();

	const view = useMemo(() => {
		if (width === 0) return null;
		const fitInput = { width, height, ratio: RATIO, gap: GAP, chrome: STRIP };
		if (compact) {
			const cols = Math.min(2, Math.max(wall.slots.length, 1));
			const rows = Math.max(1, Math.ceil(wall.slots.length / cols));
			const cells = wall.slots.map((_, i) => ({
				x: i % cols,
				y: Math.floor(i / cols),
				w: 1,
				h: 1,
			}));
			const tile = (width - GAP * (cols - 1)) / cols;
			return {
				spec: { cols, rows, cells },
				offset: 0,
				boxWidth: width,
				boxHeight: rows * (tile / RATIO + STRIP) + GAP * (rows - 1),
			};
		}
		if (wall.layout !== "auto") {
			const offset = wall.page * cellsPerPage(wall);
			return { spec: LAYOUTS[wall.layout], offset, boxWidth: width, boxHeight: height };
		}
		const spec = autoGrid({ ...fitInput, count: wall.slots.length });
		if (fit === "fill") return { spec, offset: 0, boxWidth: width, boxHeight: height };
		const byWidth = (width - GAP * (spec.cols - 1)) / spec.cols;
		const byHeight = ((height - GAP * (spec.rows - 1)) / spec.rows - STRIP) * RATIO;
		const tile = Math.min(byWidth, byHeight);
		return {
			spec,
			offset: 0,
			boxWidth: tile * spec.cols + GAP * (spec.cols - 1),
			boxHeight: (tile / RATIO + STRIP) * spec.rows + GAP * (spec.rows - 1),
		};
	}, [width, height, compact, wall, fit]);

	const placed = useMemo(
		() => (view ? place(view.spec, view.boxWidth, view.offset, wall) : []),
		[view, wall],
	);

	const quality = useMemo(() => {
		const scale = window.devicePixelRatio;
		const tiles = wall.focused
			? [
					{
						key: FULL_TILE,
						deviceWidth: width * scale,
						choice: choices.get(wall.focused) ?? "auto",
					},
				]
			: placed.map((tile) => ({
					key: tile.index,
					deviceWidth: Math.round(tile.width * scale),
					choice: (tile.camera && choices.get(tile.camera)) ?? "auto",
				}));
		return pickQuality(tiles);
	}, [placed, choices, wall.focused, width]);

	const focused = wall.focused ? cameras.get(wall.focused) : undefined;
	if (focused) {
		return (
			<div className="wall-box wall-full">
				<Tile
					key={focused.id}
					index={FULL_TILE}
					camera={focused}
					quality={quality.get(FULL_TILE) ?? "main"}
					choice={choices.get(focused.id) ?? "auto"}
					selected={false}
					full
					active={active}
					onSelect={() => undefined}
					onOpen={() => undefined}
					onClose={() => onFocus(null)}
					onClear={() => undefined}
					onChoice={(choice) => onChoice(focused.id, choice)}
				/>
			</div>
		);
	}

	if (!view) return null;
	return (
		<div
			className={`wall-box wall-${fit}`}
			style={{
				gridTemplateColumns: `repeat(${view.spec.cols}, minmax(0, 1fr))`,
				gridTemplateRows: `repeat(${view.spec.rows}, minmax(0, 1fr))`,
				width: view.boxWidth,
				height: view.boxHeight,
				gap: GAP,
			}}
		>
			{placed.map((tile) => {
				const camera = tile.camera ? (cameras.get(tile.camera) ?? null) : null;
				return (
					<div
						key={tile.index}
						className="cell"
						style={{ gridColumn: tile.column, gridRow: tile.row }}
					>
						<Tile
							index={tile.index}
							camera={camera}
							quality={quality.get(tile.index) ?? "sub"}
							choice={(camera && choices.get(camera.id)) ?? "auto"}
							selected={wall.selected === tile.index}
							full={false}
							active={active}
							onSelect={() => (compact && camera ? onFocus(camera.id) : onSelect(tile.index))}
							onOpen={() => camera && onFocus(camera.id)}
							onClose={() => onFocus(null)}
							onClear={() => onClear(tile.index)}
							onChoice={(choice) => camera && onChoice(camera.id, choice)}
						/>
					</div>
				);
			})}
		</div>
	);
}
