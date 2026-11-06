import { ContextMenu } from "@/web/components/ContextMenu";
import { useClock } from "@/web/lib/hooks";
import { buildMenu, type MenuContext, type MenuSpec, type TileCell } from "@/web/lib/menus";
import { tileRate, useStatuses } from "@/web/lib/status";
import type { MenuTarget } from "@/web/lib/wall";

export type WallMenuContext = Omit<MenuContext, "statuses" | "cells" | "ratio" | "rate">;

/**
 * Rebuilds the menu on every change, so a tile that drops while its menu is open
 * shows it at once. The clock keeps the bit rate in the header moving.
 */
export function WallMenu({
	target,
	spec,
	x,
	y,
	keyboard,
	sheet,
	cells,
	ratio,
	context,
	onClose,
}: {
	target: MenuTarget;
	spec: MenuSpec | null;
	x: number;
	y: number;
	keyboard: boolean;
	sheet: boolean;
	cells: readonly TileCell[];
	ratio: number;
	context: WallMenuContext;
	onClose: () => void;
}) {
	useClock();
	const statuses = useStatuses();
	const placed = cells.map((cell) => ({ ...cell, camera: context.wall.slots[cell.index] ?? null }));
	const built =
		spec ?? buildMenu(target, { ...context, statuses, cells: placed, ratio, rate: tileRate });
	return (
		<ContextMenu spec={built} x={x} y={y} keyboard={keyboard} sheet={sheet} onClose={onClose} />
	);
}
