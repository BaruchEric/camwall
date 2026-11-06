import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

export function Dialog({
	title,
	wide = false,
	onClose,
	children,
}: {
	title: string;
	wide?: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (dialog && !dialog.open) dialog.showModal();
	}, []);
	return (
		<dialog ref={ref} className={wide ? "dialog dialog-wide" : "dialog"} onClose={onClose}>
			<header className="dialog-head">
				<h2>{title}</h2>
				<button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
					<X size={18} />
				</button>
			</header>
			<div className="dialog-body">{children}</div>
		</dialog>
	);
}

/** A button with a panel under it. Clicking away or pressing Escape closes the panel. */
export function Menu({
	label,
	button,
	active = false,
	align = "end",
	children,
}: {
	label: string;
	button: ReactNode;
	active?: boolean;
	align?: "start" | "end";
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (event: PointerEvent) => {
			if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", key);
		};
	}, [open]);
	return (
		<div className="menu" ref={root}>
			<button
				type="button"
				className={active ? "tool tool-on" : "tool"}
				aria-label={label}
				aria-expanded={open}
				title={label}
				onClick={() => setOpen((value) => !value)}
			>
				{button}
			</button>
			{open && (
				<div className={`menu-panel menu-panel-${align}`}>{children(() => setOpen(false))}</div>
			)}
		</div>
	);
}

/** Asks once more on the same button, so removing something takes two deliberate clicks. */
export function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
	const [armed, setArmed] = useState(false);
	return (
		<button
			type="button"
			className={armed ? "button button-danger" : "button button-quiet"}
			onClick={() => (armed ? onConfirm() : setArmed(true))}
			onBlur={() => setArmed(false)}
		>
			{armed ? "Click again to remove" : label}
		</button>
	);
}

/** Text that saves when you leave the field or press Enter. */
export function NameField({
	label,
	value,
	onSave,
}: {
	label: string;
	value: string;
	onSave: (name: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	const save = () => {
		const name = draft.trim();
		if (name !== "" && name !== value) onSave(name);
		else setDraft(value);
	};
	return (
		<input
			className="field"
			aria-label={label}
			value={draft}
			maxLength={60}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={save}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
		/>
	);
}
