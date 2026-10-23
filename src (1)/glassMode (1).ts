import { useEffect, useState } from "react";

// Whether the dashboard and performance tabs use the glass look (the default) or the classic one
// they had before. It is chosen with the weather icon on the dashboard tab and remembered between
// runs. Classic is a class on <html> (.dash-classic) that the glass stylesheets check, so the tabs
// are right as soon as they open, before anything renders.
const KEY = "bloom.dashGlass";

const read = (): boolean => {
	try {
		return localStorage.getItem(KEY) !== "0";
	} catch {
		return true;
	}
};

let glass = read();
const listeners = new Set<() => void>();

const apply = () => document.documentElement.classList.toggle("dash-classic", !glass);
apply();

const flip = () => {
	glass = !glass;
	apply();
	try {
		localStorage.setItem(KEY, glass ? "1" : "0");
	} catch {
		// Still switched for this session if it could not be remembered.
	}
	listeners.forEach((l) => l());
};

let switching = false;

// Switches the look: the tab fades out, the look changes while it is invisible, and it fades back
// in. (A browser view transition would cross-fade the two looks, but while one runs the page counts
// as not hovered, which collapses the notch. This fades the real elements, so the pointer stays on
// them.) With reduced motion, or when the tab is not on screen, it just switches.
export function toggleDashGlass() {
	const body = document.querySelector<HTMLElement>(".dash-body");
	if (!body || !body.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
		flip();
		return;
	}
	if (switching) return;
	switching = true;
	let flipped = false;
	const change = () => {
		if (!flipped) {
			flipped = true;
			flip();
		}
	};
	const out = body.animate({ opacity: [1, 0] }, { duration: 130, easing: "ease-in", fill: "forwards" });
	out.finished
		.then(() => {
			change();
			// The way back starts at 0, so there is no flash when the first animation is dropped.
			const back = body.animate({ opacity: [0, 1] }, { duration: 200, easing: "ease-out" });
			out.cancel();
			return back.finished;
		})
		.catch(() => {})
		.finally(() => {
			change();
			switching = false;
		});
}

export function useDashGlass(): boolean {
	const [value, setValue] = useState(glass);
	useEffect(() => {
		const sync = () => setValue(glass);
		listeners.add(sync);
		sync();
		return () => {
			listeners.delete(sync);
		};
	}, []);
	return value;
}
