import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { animate as animateValue, motion, useMotionValue, useReducedMotion, type MotionValue } from "framer-motion";
import { ChevronLeft, FolderOpen, Save, Search, Shuffle, Trash2, X } from "lucide-react";
import "./WallpaperPanel.css";

// The wallpaper switcher as a notch panel (opened with Alt+A, see wallpaper.rs), dressed as a memory
// archive: every wallpaper is a numbered "memory disk" (MEM-001, MEM-002, ...). Three layouts:
// "Strips" (a port of the Python switcher: the selected strip is wide, its neighbours share the rest
// of the row, like disk spines in a drawer), "Grid", and "Pick" (a centred carousel of floppy disks:
// the selected one is lifted out of the rack, the row sliding past it). Applying a wallpaper changes the real Windows wallpaper and
// then runs update-colors.ps1, so pywal (and with it Bloom's own colours) follows the new image.
//
// Just start typing to filter by file name (the search box is focused when the panel opens).
// Keys: the arrow keys (also while typing in the search box), Tab or the mouse wheel browse, Enter or
// a click on the selected card applies, Shift keeps the panel open afterwards, Esc clears the search
// and then closes, Alt+A toggles. The shuffle button applies a random one.

/** Height of the whole notch while this panel is open: the 36px bar plus the panel below it. */
export const WALLPAPER_PANEL_HEIGHT = 254;
/** Width of the notch while this panel is open (a bit under a screen on small monitors). */
export const wallpaperPanelWidth = (viewportWidth: number, scale: number) =>
	Math.max(420, Math.min(900, Math.floor(viewportWidth / scale) - 40));

type Entry = { path: string; name: string };
type MonitorInfo = { index: number; id: string; width: number; height: number };
type WpState = { current: string; monitors: MonitorInfo[]; per_monitor: boolean };
type Layout = "strip" | "grid" | "pick";

const FIT_STYLES = ["fill", "fit", "stretch", "tile", "center", "span"] as const;
type FitStyle = (typeof FIT_STYLES)[number];
const FIT_LABELS: Record<FitStyle, string> = {
	fill: "Fill",
	fit: "Fit",
	stretch: "Stretch",
	tile: "Tile",
	center: "Center",
	span: "Span"
};
const LAYOUTS: Layout[] = ["strip", "grid", "pick"];
const LAYOUT_LABELS: Record<Layout, string> = { strip: "Strips", grid: "Grid", pick: "Pick" };

// Settings keys (also mirrored to Bloom's settings file with save_setting).
const K_FOLDER = "bloom-wallpaper-folder";
const K_STYLE = "bloom-wallpaper-style";
const K_MONITOR = "bloom-wallpaper-monitor"; // "all" or a monitor index
const K_LAYOUT = "bloom-wallpaper-layout";
const K_SCRIPT = "bloom-wallpaper-colors-script"; // optional path to update-colors.ps1
const K_COLORS = "bloom-wallpaper-update-colors"; // "false" skips the pywal refresh
// How long the delete animation runs (the .wp-card.deleting rule in WallpaperPanel.css must match).
const DELETE_ANIM_MS = 420;

// Strips layout numbers, same as AccordionLayout in switcher_flow.py.
const ACTIVE_FRACTION = 0.42;
const MIN_STRIP = 56;
const MAX_STRIPS = 17;
const STRIP_H = 132;
// Pick layout: floppy disks (square), the selected one in the middle of the row.
const PICK_GAP = 16;
// The selected disk in the Pick layout floats: it leans a little from side to side like a pendulum, bobs up and down and
// drifts sideways by a pixel or two, each at its own pace so it never repeats exactly. It is like this from the moment the
// panel opens. When the selection moves, the disk that comes up arrives leaning in from the side the row came from and
// settles into the float with a soft spring; the one put back in the rack settles upright with the same spring. The glow
// behind it and the flashlight are in WallpaperPanel.css (.wp-card::before and .wp-panel::after).
const SWAY_DEG = 2.6; // how far it leans each way, in degrees
const SWAY_SECONDS = 5.2; // one lean there and back
const BOB_PX = 2; // how far it floats up and down
const BOB_SECONDS = 3.7;
const DRIFT_PX = 1.2; // how far it drifts sideways
const DRIFT_SECONDS = 6.3;
const LEAN_DEG = 7; // how far it leans on arrival, away from the side it came from
const SETTLE = { type: "spring" as const, stiffness: 60, damping: 9 }; // lower stiffness = lazier, lower damping = more wobble
/** Width of a disk in the Pick layout (they are square). */
const pickCardW = (W: number) => clamp(W * 0.13, 96, STRIP_H - 20);
// Space between the search box and the option chips; must match .wp-chipbar margin-left.
const DRAWER_GAP = 6;
// Grid layout.
const GRID_COLS = 7;
const GRID_ROWS = 2;
const GRID_GAP = 6;
// Thumbnail size asked from the backend (crop-to-fill, shared by both layouts).
// (wallpaper.rs builds the same size ahead of time: WARM_THUMB_W / WARM_THUMB_H)
const THUMB_W = 640;
const THUMB_H = 360;
const THUMB_CONCURRENCY = 4;
const THUMB_PREFETCH = 6; // cards loaded ahead on each side of the selection
// Preview on the real screen: a window of its own (wallpaper.rs, drawn by WallpaperPreview.tsx) sits
// just above the desktop, behind every app window, the dock and this notch, and crossfades to the
// selected wallpaper without applying it. The small thumbnail goes first, the screen-sized picture
// follows once the selection has rested for PREVIEW_DELAY ms.
const PREVIEW_DELAY = 80;
const PREVIEW_PREFETCH = 3; // screen-sized pictures decoded ahead on each side of the selection
const PRIME_THUMBS = 12; // thumbnails requested around the wallpaper in use as soon as the app starts
// After Enter the preview stays up this long, so Windows' own wallpaper change happens behind it.
// Windows needs about 1.2 s after SetWallpaper returns before the desktop really shows the new picture
// (measured on screen recordings). A shorter hold fades the preview out onto the OLD wallpaper for a
// moment, and then the new one pops in.
const APPLY_HOLD_MS = 2200;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pad3 = (n: number) => String(n).padStart(3, "0");
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const normPath = (p: string) => p.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").toLowerCase();
const samePath = (a: string, b: string) => normPath(a) === normPath(b);
/** Index of the wallpaper in use inside the list: by path, else by file name when that is unambiguous. */
const findCurrent = (list: Entry[], cur: string): number => {
	if (!cur) return -1;
	const c = normPath(cur);
	const exact = list.findIndex((f) => normPath(f.path) === c);
	if (exact >= 0) return exact;
	const name = c.split("\\").pop();
	const hits: number[] = [];
	list.forEach((f, i) => {
		if (normPath(f.path).split("\\").pop() === name) hits.push(i);
	});
	return hits.length === 1 ? hits[0] : -1;
};

const readSetting = (key: string): string | null => {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
};
const saveSetting = (key: string, value: string) => {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore */
	}
	invoke("save_setting", { key, value }).catch(() => {});
};

// ── Caches that outlive the panel, so reopening it is instant (like _SHARED_THUMBS in Python) ──
const thumbCache = new Map<string, string>();
const thumbFailed = new Set<string>();
const thumbPending = new Map<string, Promise<void>>();
type Waiter = { path: string; run: () => void };
const thumbWaiting: Waiter[] = [];
let thumbActive = 0;
const showPreview = (path: string, style: string, thumb: string | null, full: boolean) => {
	invoke("wallpaper_preview_show", { path, style, thumb, full }).catch(() => {});
};
const endPreview = (hold: number) => {
	invoke("wallpaper_preview_end", { hold }).catch(() => {});
};
let listCache: { folder: string; files: Entry[] } | null = null;
let wpCache: WpState | null = null;
let lastIndex = 0;

// Where the picker opens: on the wallpaper in use (once it is known), else where it was left.
const initialIndex = () => {
	if (listCache && wpCache?.current) {
		const at = findCurrent(listCache.files, wpCache.current);
		if (at >= 0) return at;
	}
	return lastIndex;
};

const pumpThumbs = () => {
	while (thumbActive < THUMB_CONCURRENCY && thumbWaiting.length) {
		// Newest request first: the cards on screen now matter more than ones already scrolled past.
		thumbWaiting.pop()!.run();
	}
};

/** Queues a thumbnail. Does not start anything: call pumpThumbs() once after queueing a batch, so the
 *  order of the batch (last queued = loaded first) is respected. */
const requestThumb = (path: string): Promise<void> => {
	if (thumbCache.has(path) || thumbFailed.has(path)) return Promise.resolve();
	const existing = thumbPending.get(path);
	if (existing) {
		// Still waiting from an earlier batch (e.g. as a prefetch): move it to the front of the line.
		const at = thumbWaiting.findIndex((w) => w.path === path);
		if (at >= 0) thumbWaiting.push(thumbWaiting.splice(at, 1)[0]);
		return existing;
	}
	const p = new Promise<void>((resolve) => {
		thumbWaiting.push({
			path,
			run: () => {
				thumbActive++;
				invoke<string>("wallpaper_thumbnail", { path, width: THUMB_W, height: THUMB_H })
					.then((url) => thumbCache.set(path, url))
					.catch((err) => {
						// Shown as a flat tile instead of an endless shimmer, and logged for the console.
						thumbFailed.add(path);
						console.warn("Wallpaper thumbnail failed:", path, err);
					})
					.finally(() => {
						thumbActive--;
						thumbPending.delete(path);
						resolve();
						pumpThumbs();
					});
			}
		});
	});
	thumbPending.set(path, p);
	return p;
};

// Runs as soon as this module is loaded (app start): the first time the panel opens it already has the
// file list, the wallpaper in use and the thumbnails around it.
const primeCaches = async () => {
	const dir = readSetting(K_FOLDER);
	if (!dir) return;
	try {
		const [list, state] = await Promise.all([
			invoke<Entry[]>("wallpaper_list", { folder: dir }),
			invoke<WpState>("wallpaper_state")
		]);
		listCache = { folder: dir, files: list };
		wpCache = state;
		const n = list.length;
		if (!n) return;
		const centre = Math.max(0, findCurrent(list, state.current));
		const wanted: number[] = [centre];
		for (let k = 1; k <= Math.min(PRIME_THUMBS, n); k++) {
			for (const i of [(centre + k) % n, (centre - k + 2 * n) % n]) if (!wanted.includes(i)) wanted.push(i);
		}
		// Furthest first, so the nearest ends up on top of the queue.
		for (const i of wanted.reverse()) requestThumb(list[i].path);
		pumpThumbs();
	} catch {
		/* the panel loads everything itself when it opens */
	}
};
if (typeof window !== "undefined") void primeCaches();

type Slot = { idx: number; x: number; y: number; w: number; h: number; d?: number };

/** The body of a card. In the Pick layout the selected disk (`spin`) floats; every other card is a plain box. The lift itself
 *  (the pop) is the CSS `translate` of .wp-card-body, so it does not fight the rotation and offsets set here. */
function DiskBody({
	spin,
	lean,
	reduceMotion,
	children
}: {
	spin: boolean;
	lean: number;
	reduceMotion: boolean;
	children: React.ReactNode;
}) {
	const sway = useMotionValue(0);
	const bob = useMotionValue(0);
	const drift = useMotionValue(0);
	const leanRef = useRef(lean);
	leanRef.current = lean;
	useEffect(() => {
		const running: ReturnType<typeof animateValue>[] = [];
		const loop = (mv: MotionValue<number>, keys: number[], seconds: number) =>
			running.push(animateValue(mv, keys, { duration: seconds, ease: "easeInOut", repeat: Infinity }));
		if (spin && !reduceMotion) {
			loop(bob, [0, -BOB_PX, 0, BOB_PX * 0.6, 0], BOB_SECONDS);
			loop(drift, [0, DRIFT_PX, 0, -DRIFT_PX, 0], DRIFT_SECONDS);
			const startSway = () => loop(sway, [0, SWAY_DEG, 0, -SWAY_DEG, 0], SWAY_SECONDS);
			if (leanRef.current) {
				// Arrive leaning in, then settle into the float (the loop starts from upright, at rest, so there is no jump).
				sway.set(leanRef.current * LEAN_DEG);
				running.push(animateValue(sway, 0, { ...SETTLE, onComplete: startSway }));
			} else {
				startSway();
			}
		} else if (sway.get() !== 0 || bob.get() !== 0 || drift.get() !== 0) {
			// Put back: settle upright and stop floating.
			for (const mv of [sway, bob, drift]) running.push(animateValue(mv, 0, SETTLE));
		}
		return () => running.forEach((a) => a.stop());
	}, [spin, reduceMotion, sway, bob, drift]);
	return (
		<motion.div className="wp-card-body" style={{ rotate: sway, x: drift, y: bob }}>
			{children}
		</motion.div>
	);
}

export default function WallpaperPanel({ width, onClose }: { width: number; onClose: () => void }) {
	const [, bump] = useReducer((n: number) => n + 1, 0);
	const [allFiles, setFiles] = useState<Entry[]>(() => listCache?.files ?? []);
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(initialIndex);
	const [folder, setFolder] = useState(() => readSetting(K_FOLDER) || "");
	const [style, setStyle] = useState<FitStyle>(() => {
		const v = readSetting(K_STYLE) as FitStyle | null;
		return v && FIT_STYLES.includes(v) ? v : "fill";
	});
	const [monitor, setMonitor] = useState<number | null>(() => {
		const v = readSetting(K_MONITOR);
		return v && v !== "all" && Number.isFinite(Number(v)) ? Number(v) : null;
	});
	const [layout, setLayout] = useState<Layout>(() => {
		const v = readSetting(K_LAYOUT) as Layout | null;
		return v && LAYOUTS.includes(v) ? v : "strip";
	});
	const [wp, setWp] = useState<WpState | null>(() => wpCache);
	const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
	const [loading, setLoading] = useState(false);
	const reduceMotion = useReducedMotion();
	// True from the moment a wallpaper is chosen (Enter or a click) until just after it is applied: the disk slides into a drive.
	const [chosen, setChosen] = useState(false);
	// The wallpaper being deleted (its card plays the erase animation) and a guard against a second Delete meanwhile.
	const [deleting, setDeleting] = useState<string | null>(null);
	const deletingRef = useRef(false);

	const mountedRef = useRef(true);
	const pickingRef = useRef(false);
	const applyingRef = useRef(false);
	const appliedRef = useRef(false);
	const previewShownRef = useRef(false);
	const userMovedRef = useRef(false);
	const lastWheelRef = useRef(0);
	// First visible grid row. The grid scrolls a row at a time, only when the selection leaves the
	// window, instead of re-centring (and sliding every card) on each key press.
	const gridTopRef = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);
	// The option chips live in a drawer that slides out from the top-right toggle and pushes the
	// search box. The drawer animates to the measured width of its content.
	const [chipsOpen, setChipsOpen] = useState(false);
	const [chipsW, setChipsW] = useState(0);
	const chipsRef = useRef<HTMLDivElement>(null);
	// The width the layout is computed for is measured, not taken from the `width` prop: the notch is
	// not always exactly as wide as it was asked to be, and a layout built for the wrong width puts the
	// middle card off-centre and clips the last strip.
	const rootRef = useRef<HTMLDivElement>(null);
	const [rootW, setRootW] = useState(0);
	// No slide transitions while the notch is still growing, or the cards would chase its width.
	const [settled, setSettled] = useState(false);
	const statusTimerRef = useRef<number | null>(null);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
		};
	}, []);

	// Build the (hidden) preview window now, so it is ready by the time the selection first moves.
	useEffect(() => {
		invoke("wallpaper_preview_prepare").catch(() => {});
	}, []);

	// Closing the panel (Esc, hotkey, clicking away) fades the preview out.
	useEffect(
		() => () => {
			if (!previewShownRef.current) return;
			previewShownRef.current = false;
			endPreview(appliedRef.current || applyingRef.current ? APPLY_HOLD_MS : 0);
		},
		[]
	);

	const flash = useCallback((text: string, error = false, ms = 2200) => {
		setStatus({ text, error });
		if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
		statusTimerRef.current = window.setTimeout(() => setStatus(null), ms);
	}, []);

	// What the search box leaves: every word must appear in the path below the wallpaper folder, so
	// "forest night" finds forest_night.png and a sub-folder called forest/night alike.
	const files = useMemo(() => {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (!tokens.length) return allFiles;
		const root = folder.toLowerCase();
		return allFiles.filter((f) => {
			let hay = f.path.toLowerCase();
			if (root && hay.startsWith(root)) hay = hay.slice(root.length);
			return tokens.every((t) => hay.includes(t));
		});
	}, [allFiles, query, folder]);

	const count = files.length;
	const wrap = useCallback((i: number) => (count ? ((i % count) + count) % count : 0), [count]);
	// Which way the selection just moved (-1 left, 1 right, the short way round the folder): the disk that comes up leans in from there.
	const prevIndexRef = useRef(index);
	const leanRef = useRef(0);
	if (prevIndexRef.current !== index) {
		let d = index - prevIndexRef.current;
		if (count > 1) {
			if (d > count / 2) d -= count;
			else if (d < -count / 2) d += count;
		}
		leanRef.current = Math.sign(d);
		prevIndexRef.current = index;
	}

	// A new search starts from its first hit; clearing it goes back to the wallpaper in use. Done here, in the same
	// batch as setQuery, so there is never a render with the new (short) list and the old (too big) index.
	const changeQuery = useCallback(
		(q: string) => {
			setQuery(q);
			userMovedRef.current = true;
			let next = 0;
			if (!q.trim() && wp?.current) {
				const at = findCurrent(allFiles, wp.current);
				if (at >= 0) next = at;
			}
			// The row jumps to another list: no lean-in, and no bogus direction worked out from the old count.
			leanRef.current = 0;
			prevIndexRef.current = next;
			setIndex(next);
		},
		[allFiles, wp]
	);

	// Remember where we were for the next open.
	useEffect(() => {
		lastIndex = index;
	}, [index]);

	// Settings saved in Bloom's settings file win over the browser copy.
	useEffect(() => {
		invoke<Record<string, unknown>>("load_settings")
			.then((s) => {
				if (!mountedRef.current || !s) return;
				const f = s[K_FOLDER];
				if (typeof f === "string" && f) setFolder(f);
				const st = s[K_STYLE];
				if (typeof st === "string" && FIT_STYLES.includes(st as FitStyle)) setStyle(st as FitStyle);
				const m = s[K_MONITOR];
				if (m !== undefined) setMonitor(m === "all" || m === null ? null : Number(m));
				const l = s[K_LAYOUT];
				if (typeof l === "string" && LAYOUTS.includes(l as Layout)) setLayout(l as Layout);
			})
			.catch(() => {});
	}, []);

	// Current wallpaper + monitors.
	useEffect(() => {
		invoke<WpState>("wallpaper_state")
			.then((s) => {
				wpCache = s;
				if (mountedRef.current) setWp(s);
			})
			.catch(() => {});
	}, []);

	// The image list for the folder (cached; refreshed in the background on every open).
	const loadFiles = useCallback((dir: string) => {
		if (!dir) {
			setFiles([]);
			return;
		}
		setLoading(!(listCache && listCache.folder === dir));
		invoke<Entry[]>("wallpaper_list", { folder: dir })
			.then((list) => {
				if (!mountedRef.current) return;
				listCache = { folder: dir, files: list };
				setFiles(list);
				setLoading(false);
			})
			.catch((e) => {
				if (!mountedRef.current) return;
				setLoading(false);
				setFiles([]);
				flash(String(e), true, 4000);
			});
	}, [flash]);

	useEffect(() => {
		if (listCache && listCache.folder === folder) setFiles(listCache.files);
		loadFiles(folder);
	}, [folder, loadFiles]);

	// Start on the wallpaper that is set right now, unless the user already moved.
	useEffect(() => {
		if (userMovedRef.current || !wp?.current || !files.length) return;
		const at = findCurrent(files, wp.current);
		if (at >= 0) setIndex(at);
	}, [wp?.current, files]);

	useEffect(() => {
		if (count && index >= count) setIndex(0);
	}, [count, index]);


	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const measure = () => setRootW(el.clientWidth);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const t = window.setTimeout(() => setSettled(true), 500);
		return () => window.clearTimeout(t);
	}, []);

	useLayoutEffect(() => {
		const el = chipsRef.current;
		if (!el) return;
		const measure = () => setChipsW(el.offsetWidth + DRAWER_GAP);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// The search box is ready to type into as soon as the panel opens.
	useEffect(() => {
		const t = window.setTimeout(() => inputRef.current?.focus(), 80);
		return () => window.clearTimeout(t);
	}, []);

	// ── Geometry ──
	const W = Math.max(240, (rootW || width) - 32); // stage width: the root minus its 16px side padding

	const slots: Slot[] = useMemo(() => {
		if (!count) return [];
		const out: Slot[] = [];
		if (layout === "grid") {
			const totalRows = Math.ceil(count / GRID_COLS);
			const selRow = Math.floor(index / GRID_COLS);
			let top = gridTopRef.current;
			if (selRow < top) top = selRow;
			else if (selRow > top + GRID_ROWS - 1) top = selRow - (GRID_ROWS - 1);
			top = clamp(top, 0, Math.max(0, totalRows - GRID_ROWS));
			gridTopRef.current = top;
			const cellW = (W - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS;
			const cellH = (STRIP_H - GRID_GAP * (GRID_ROWS - 1)) / GRID_ROWS;
			// One extra row above and below, parked outside the stage, so scrolling slides rows in.
			const first = Math.max(0, (top - 1) * GRID_COLS);
			const last = Math.min(count - 1, (top + GRID_ROWS + 1) * GRID_COLS - 1);
			for (let idx = first; idx <= last; idx++) {
				out.push({
					idx,
					x: (idx % GRID_COLS) * (cellW + GRID_GAP),
					y: (Math.floor(idx / GRID_COLS) - top) * (cellH + GRID_GAP),
					w: cellW,
					h: cellH
				});
			}
			return out;
		}
		if (layout === "pick") {
			const cardW = pickCardW(W);
			const cardH = cardW; // square, like the disk in the media tab
			const pitch = cardW + PICK_GAP;
			// one card past each edge, waiting to slide in
			const reach = Math.ceil(W / 2 / pitch) + 1;
			for (let idx = 0; idx < count; idx++) {
				let d = (((idx - index) % count) + count) % count;
				if (d > count / 2) d -= count; // shortest way round the folder
				if (Math.abs(d) > reach) continue;
				out.push({
					idx,
					x: W / 2 - cardW / 2 + d * pitch,
					y: (STRIP_H - cardH) / 2 + 6, // rest a little low, so the selected card has room to rise
					w: cardW,
					h: cardH,
					d
				});
			}
			return out;
		}
		// Strips: n bands, the active one ACTIVE_FRACTION of the row, wrapping around the folder.
		const n = clamp(1 + Math.floor((W * (1 - ACTIVE_FRACTION)) / MIN_STRIP), 1, Math.min(MAX_STRIPS, count));
		const half = Math.floor(n / 2);
		const activeW = n === 1 ? W : W * ACTIVE_FRACTION;
		const otherW = n > 1 ? (W - activeW) / (n - 1) : W;
		let x = 0;
		for (let i = 0; i < n; i++) {
			const idx = wrap(index - half + i);
			const w = idx === index ? activeW : otherW;
			out.push({ idx, x, y: 0, w, h: STRIP_H });
			x += w;
		}
		// One extra strip waiting off-screen on each side, so scrolling slides strips in and out.
		if (count >= n + 2) {
			out.push({ idx: wrap(index - half - 1), x: -otherW, y: 0, w: otherW, h: STRIP_H });
			out.push({ idx: wrap(index - half + n), x: W, y: 0, w: otherW, h: STRIP_H });
		}
		return out;
	}, [count, index, layout, W, wrap]);

	// ── Thumbnails for whatever is on screen, plus a few cards either side ──
	useEffect(() => {
		if (!count) return;
		const around = new Set<number>(slots.map((s) => s.idx));
		for (let k = 1; k <= THUMB_PREFETCH; k++) {
			around.add(wrap(index + k));
			around.add(wrap(index - k));
		}
		const dist = (i: number) => {
			const d = Math.abs(i - index);
			return Math.min(d, count - d); // the way round the folder
		};
		// Furthest first, so the nearest ends up on top of the queue and is loaded first.
		const wanted = [...around].sort((a, b) => dist(b) - dist(a));
		let cancelled = false;
		for (const idx of wanted) {
			const f = files[idx];
			if (!f || thumbCache.has(f.path) || thumbFailed.has(f.path)) continue;
			requestThumb(f.path).then(() => !cancelled && mountedRef.current && bump());
		}
		pumpThumbs();
		return () => {
			cancelled = true;
		};
	}, [slots, files, index, count, wrap]);

	// ── Actions ──
	const move = useCallback(
		(delta: number, mode: "wrap" | "clamp" | "abs" = "wrap") => {
			if (!count) return;
			userMovedRef.current = true;
			setIndex((i) =>
				mode === "abs" ? clamp(delta, 0, count - 1) : mode === "clamp" ? clamp(i + delta, 0, count - 1) : wrap(i + delta)
			);
		},
		[count, wrap]
	);
	// Strips wrap around the folder; the grid stops at its ends so it never leaps from the last row to the first.
	const step = useCallback((delta: number) => move(delta, layout === "grid" ? "clamp" : "wrap"), [move, layout]);

	const apply = useCallback(
		async (path: string, keepOpen = false) => {
			if (applyingRef.current) return;
			applyingRef.current = true;
			setChosen(true);
			setStatus({ text: "Restoring memory…", error: false });
			try {
				await invoke("wallpaper_apply", {
					path,
					monitor,
					style,
					updateColors: readSetting(K_COLORS) !== "false",
					colorsScript: readSetting(K_SCRIPT) || null
				});
				if (!mountedRef.current) return;
				appliedRef.current = true;
				setWp((w) => (w ? { ...w, current: path } : w));
				if (wpCache) wpCache = { ...wpCache, current: path };
				flash("Memory restored");
				if (!keepOpen) window.setTimeout(() => mountedRef.current && onClose(), 260);
			} catch (e) {
				if (mountedRef.current) flash(String(e), true, 4000);
			} finally {
				applyingRef.current = false;
				window.setTimeout(() => mountedRef.current && setChosen(false), 900);
			}
		},
		[monitor, style, flash, onClose]
	);

	// Delete the selected wallpaper: its card is erased while the file goes to the Recycle Bin and its cache files
	// (thumbnail, preview, colours) are removed. The wallpaper in use is never deleted.
	const removeActive = useCallback(async () => {
		const f = files[index];
		if (!f || deletingRef.current || applyingRef.current) return;
		if (wp?.current && samePath(f.path, wp.current)) {
			flash("That one is in use. Pick another wallpaper first.", true, 3200);
			return;
		}
		const path = f.path;
		const remaining = files.length - 1;
		deletingRef.current = true;
		setDeleting(path);
		setStatus({ text: "Erasing memory…", error: false });
		try {
			await Promise.all([
				invoke("wallpaper_delete", { path }),
				new Promise<void>((resolve) => window.setTimeout(resolve, DELETE_ANIM_MS))
			]);
			thumbCache.delete(path);
			thumbFailed.delete(path);
			if (listCache) listCache = { ...listCache, files: listCache.files.filter((x) => !samePath(x.path, path)) };
			if (!mountedRef.current) return;
			userMovedRef.current = true;
			setFiles((list) => list.filter((x) => !samePath(x.path, path)));
			setIndex((i) => Math.max(0, Math.min(i, remaining - 1)));
			flash("Memory erased");
		} catch (e) {
			if (mountedRef.current) flash(String(e), true, 4000);
		} finally {
			deletingRef.current = false;
			if (mountedRef.current) setDeleting(null);
		}
	}, [files, index, wp?.current, flash]);

	const applyRandom = useCallback(() => {
		if (!count) return;
		let at = Math.floor(Math.random() * count);
		if (count > 1 && files[at] && wp?.current && samePath(files[at].path, wp.current)) at = wrap(at + 1);
		userMovedRef.current = true;
		setIndex(at);
		apply(files[at].path);
	}, [count, files, wp?.current, wrap, apply]);

	const pickFolder = useCallback(async () => {
		pickingRef.current = true;
		try {
			const picked = await invoke<string | null>("wallpaper_pick_folder");
			if (picked && mountedRef.current) {
				saveSetting(K_FOLDER, picked);
				userMovedRef.current = false;
				setIndex(0);
				setFolder(picked);
			}
		} catch (e) {
			if (mountedRef.current) flash(String(e), true, 4000);
		} finally {
			pickingRef.current = false;
			inputRef.current?.focus();
		}
	}, [flash]);

	const cycleStyle = () => {
		const next = FIT_STYLES[(FIT_STYLES.indexOf(style) + 1) % FIT_STYLES.length];
		setStyle(next);
		saveSetting(K_STYLE, next);
	};
	const cycleLayout = () => {
		const next = LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length];
		setLayout(next);
		saveSetting(K_LAYOUT, next);
	};
	const monitors = wp?.monitors ?? [];
	const cycleMonitor = () => {
		// null (all) -> 0 -> 1 ... -> null
		const next = monitor === null ? 0 : monitor + 1 >= monitors.length ? null : monitor + 1;
		setMonitor(next);
		saveSetting(K_MONITOR, next === null ? "all" : String(next));
	};

	// ── Keyboard (works whenever Bloom's window has focus) ──
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const inInput = e.target === inputRef.current;
			const target = e.target as HTMLElement | null;
			if (!inInput && target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
			switch (e.key) {
				case "Escape":
					e.preventDefault();
					if (inInput && query) changeQuery("");
					else onClose();
					break;
				case "ArrowLeft":
				case "ArrowRight":
					// Always browse, also while the search box has focus (no need to click out of it first).
					e.preventDefault();
					step(e.key === "ArrowLeft" ? -1 : 1);
					break;
				case "ArrowUp":
					e.preventDefault();
					step(layout === "grid" ? -GRID_COLS : -1);
					break;
				case "ArrowDown":
					e.preventDefault();
					step(layout === "grid" ? GRID_COLS : 1);
					break;
				case "Tab":
					e.preventDefault();
					step(e.shiftKey ? -1 : 1);
					break;
				case "Home":
				case "End":
					if (inInput) return;
					e.preventDefault();
					move(e.key === "Home" ? 0 : count - 1, "abs");
					break;
				case "Delete":
					// In the search box Delete edits the text; once it is empty (or with Ctrl) it erases the wallpaper.
					if (inInput && !e.ctrlKey && inputRef.current?.value) return;
					e.preventDefault();
					removeActive();
					break;
				case "Enter":
					if (files[index]) {
						e.preventDefault();
						apply(files[index].path, e.shiftKey);
					}
					break;
				default:
					// Typing with focus somewhere else (after a click on a card, say) goes to the search box.
					if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
						inputRef.current?.focus();
					}
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, move, step, layout, count, files, index, apply, query, changeQuery, removeActive]);

	// Close when the window loses focus again (clicking another app), but not while the folder
	// dialog is open and not if Bloom never had focus in the first place.
	useEffect(() => {
		let had = document.hasFocus();
		const onFocus = () => {
			had = true;
		};
		const onBlur = () => {
			if (had && !pickingRef.current) onClose();
		};
		window.addEventListener("focus", onFocus);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("focus", onFocus);
			window.removeEventListener("blur", onBlur);
		};
	}, [onClose]);

	const onWheel = (e: React.WheelEvent) => {
		e.stopPropagation(); // the notch must not treat this as "switch panel"
		const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
		if (Math.abs(d) < 4) return;
		const now = performance.now();
		if (now - lastWheelRef.current < 110) return;
		lastWheelRef.current = now;
		step(d > 0 ? 1 : -1);
	};

	const active = files[index];
	const activeSlot = slots.find((s) => s.idx === index);

	// ── Preview on the real screen ──
	// Only once the user has moved the selection, and never for the wallpaper that is already set.
	useEffect(() => {
		const f = active;
		if (!f || !wp || !userMovedRef.current || samePath(f.path, wp.current)) {
			if (previewShownRef.current) {
				previewShownRef.current = false;
				// Right after Enter the real wallpaper is still changing, so hold the preview a moment.
				endPreview(appliedRef.current ? APPLY_HOLD_MS : 0);
			}
			appliedRef.current = false;
			return;
		}
		previewShownRef.current = true;
		// The thumbnail is already loaded for most cards, so something appears straight away.
		const thumb = thumbCache.get(f.path) ?? null;
		if (thumb) showPreview(f.path, style, thumb, false);
		// The screen-sized picture is only decoded once the selection has rested.
		const t = window.setTimeout(() => showPreview(f.path, style, null, true), PREVIEW_DELAY);
		return () => {
			window.clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active?.path, wp, style]);

	// Decode the screen-sized pictures around the selection ahead of time, so previewing them is instant
	// instead of a blurry thumbnail that sharpens a moment later.
	useEffect(() => {
		if (!count || !wp) return;
		const t = window.setTimeout(() => {
			const paths: string[] = [];
			for (let k = 0; k <= PREVIEW_PREFETCH; k++) {
				for (const idx of k === 0 ? [index] : [wrap(index + k), wrap(index - k)]) {
					const f = files[idx];
					if (f && !samePath(f.path, wp.current) && !paths.includes(f.path)) paths.push(f.path);
				}
			}
			if (paths.length) invoke("wallpaper_preview_prefetch", { paths }).catch(() => {});
		}, 200);
		return () => window.clearTimeout(t);
	}, [index, files, count, wp, wrap]);
	const monitorLabel =
		monitor === null
			? "All monitors"
			: monitors[monitor]
				? `Monitor ${monitor + 1} · ${monitors[monitor].width}×${monitors[monitor].height}`
				: `Monitor ${monitor + 1}`;

	// Folder, monitor, fit, layout and shuffle. Next to the search box on a wide notch, in the bottom
	// row on a narrow one.
	const chips = (
		<>
			<button className="wp-chip wp-folder" onClick={pickFolder} title={folder || "Choose a folder"}>
				<FolderOpen size={12} strokeWidth={2.2} />
				<span>{folder ? baseName(folder) : "Choose folder"}</span>
			</button>
			{monitors.length > 1 && (
				<button className="wp-chip" onClick={cycleMonitor} title="Which monitor to change">
					{monitorLabel}
				</button>
			)}
			<button className="wp-chip" onClick={cycleStyle} title="Fit style">
				{FIT_LABELS[style]}
			</button>
			<button className="wp-chip" onClick={cycleLayout} title="Layout">
				{LAYOUT_LABELS[layout]}
			</button>
			<button className="wp-icon" onClick={applyRandom} title="Random wallpaper" disabled={!count}>
				<Shuffle size={13} strokeWidth={2.2} />
			</button>
			<button className="wp-icon wp-trash" onClick={removeActive} title="Delete wallpaper (Del)" disabled={!count || !!deleting}>
				<Trash2 size={13} strokeWidth={2.2} />
			</button>
		</>
	);

	return (
		<div ref={rootRef} className="wp-root" onWheel={onWheel} onClick={(e) => e.stopPropagation()}>
			<div className="wp-top">
				<label className="wp-search">
					<span className="wp-search-head" aria-hidden>
						<i className="wp-search-led" />
						<Search size={13} strokeWidth={2.2} className="wp-search-icon" />
					</span>
					<input
						ref={inputRef}
						className="wp-search-input"
						value={query}
						onChange={(e) => changeQuery(e.target.value)}
						placeholder="Searching memories…"
						spellCheck={false}
						autoComplete="off"
					/>
					{query && (
						<button
							type="button"
							className="wp-search-clear"
							title="Clear (Esc)"
							onClick={(e) => {
								e.preventDefault();
								changeQuery("");
								inputRef.current?.focus();
							}}
						>
							<X size={11} strokeWidth={2.6} />
						</button>
					)}
					<span className="wp-search-count">{count ? `${pad3(index + 1)}/${pad3(count)}` : "000"}</span>
				</label>
				<div className="wp-drawer" style={{ width: chipsOpen ? chipsW : 0 }} aria-hidden={!chipsOpen}>
					<div className="wp-chipbar" ref={chipsRef}>
						{chips}
					</div>
				</div>
				<button
					className={`wp-toggle${chipsOpen ? " open" : ""}`}
					onClick={() => setChipsOpen((o) => !o)}
					title={chipsOpen ? "Hide options" : "Options"}
					aria-expanded={chipsOpen}
				>
					<ChevronLeft size={14} strokeWidth={2.4} />
				</button>
			</div>

			<div key={layout} className={`wp-stage ${layout}${settled ? "" : " settling"}${chosen ? " chosen" : ""}`} style={{ height: STRIP_H + 8 }}>
				{!folder ? (
					<button className="wp-empty" onClick={pickFolder}>
						<Save size={18} strokeWidth={2} />
						<span>No disk in drive</span>
						<em>Choose your wallpaper folder</em>
					</button>
				) : loading && !count ? (
					<div className="wp-empty reading">Reading disk…</div>
				) : !count ? (
					<div className="wp-empty">
						{query.trim() ? `No memory matches “${query.trim()}”` : `Empty disk: no images in ${baseName(folder)}`}
					</div>
				) : (
					// Always rendered in index order: React then never has to move a card in the DOM, and
					// moving a node cancels its CSS transition (that was the missing animation going left).
					<div className="wp-track">
					{[...slots]
						.sort((a, b) => a.idx - b.idx)
						.map((s) => {
							const f = files[s.idx];
							if (!f) return null;
							const isActive = s.idx === index; // the real selection (what a click applies)
							const lit = isActive; // what looks selected
							const isCurrent = !!wp?.current && samePath(f.path, wp.current);
							const focus =
							layout === "grid"
								? 0.6
								: layout === "pick"
									? Math.max(0, 1 - Math.abs(s.d ?? 0) * 0.35)
									: activeSlot
										? Math.min(1, s.w / activeSlot.w)
										: 0.5;
							const src = thumbCache.get(f.path);
							return (
								<div
									key={f.path}
									className={`wp-card${lit ? " active" : ""}${isCurrent ? " current" : ""}${deleting && samePath(f.path, deleting) ? " deleting" : ""}`}
									style={{
										width: s.w,
										height: s.h,
										transform: `translate(${s.x}px, ${s.y + 4}px)`,
										filter: lit ? undefined : `brightness(${0.45 + 0.5 * focus})`,
										zIndex: lit ? 2 : 1
									}}
									onClick={(e) => {
										e.stopPropagation();
										if (deleting) return;
										if (isActive) apply(f.path, e.shiftKey);
										else move(s.idx, "abs");
									}}
									title={f.name}
								>
									<DiskBody
										spin={layout === "pick" && isActive && !chosen}
										lean={isActive ? leanRef.current : 0}
										reduceMotion={!!reduceMotion}
									>
										{/* Pick layout only (hidden otherwise): the arrow engraved top left and the two holes along the bottom. */}
										<span className="wp-arrow" aria-hidden />
										<span className="wp-holes" aria-hidden />
										<span className="wp-shutter" aria-hidden>
											<i />
										</span>
										<div className="wp-label">
											{src ? (
												<img src={src} alt="" draggable={false} />
											) : (
												<div
													className={`wp-skel${thumbFailed.has(f.path) ? " failed" : ""}`}
													title={thumbFailed.has(f.path) ? "Couldn't read this image" : undefined}
												/>
											)}
										</div>
										<span className="wp-tag">
											<b>MEM-</b>
											{pad3(s.idx + 1)}
										</span>
									</DiskBody>
								</div>
							);
						})}
					</div>
				)}
			</div>

			<div className="wp-foot">
				<div className={`wp-pill${status?.error ? " error" : ""}`}>
					{status ? (
						status.text
					) : active ? (
						<>
							<span className="wp-pill-no">MEM-{pad3(index + 1)}</span>
							<span className="wp-pill-name">
								<span className="wp-pill-text">{active.name}</span>
							</span>
							<span className="wp-pill-fit">{FIT_LABELS[style]}</span>
						</>
					) : (
						"NO DISK"
					)}
				</div>
			</div>
		</div>
	);
}
