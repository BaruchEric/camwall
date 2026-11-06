import { type RefObject, useEffect, useState } from "react";

export function useMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const list = window.matchMedia(query);
		const update = () => setMatches(list.matches);
		update();
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, [query]);
	return matches;
}

export function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
	const [size, setSize] = useState({ width: 0, height: 0 });
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			setSize({ width: element.clientWidth, height: element.clientHeight });
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

export function usePageVisible(): boolean {
	const [visible, setVisible] = useState(!document.hidden);
	useEffect(() => {
		const update = () => setVisible(!document.hidden);
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return visible;
}

export function useClock(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 1000);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/** Browser storage can throw in private windows, and nothing here depends on it. */
export function readPref(key: string): string | null {
	try {
		return localStorage.getItem(`camwall.${key}`);
	} catch {
		return null;
	}
}

export function writePref(key: string, value: string): void {
	try {
		localStorage.setItem(`camwall.${key}`, value);
	} catch {
		// The preference just lasts until the page closes.
	}
}
