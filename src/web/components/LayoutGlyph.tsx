import { type FixedLayoutId, LAYOUTS } from "@/shared/layouts";

const W = 28;
const H = 18;

export function LayoutGlyph({ layout }: { layout: FixedLayoutId }) {
	const { cols, rows, cells } = LAYOUTS[layout];
	const cw = W / cols;
	const ch = H / rows;
	return (
		<svg className="glyph" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
			{cells.map((cell) => (
				<rect
					key={`${cell.x}-${cell.y}`}
					x={cell.x * cw + 0.5}
					y={cell.y * ch + 0.5}
					width={cell.w * cw - 1}
					height={cell.h * ch - 1}
					rx="0.6"
				/>
			))}
		</svg>
	);
}
