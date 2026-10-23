import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { createPortal } from "react-dom";
import {
	Wifi,
	WifiOff,
	Bluetooth,
	BluetoothOff,
	Volume1,
	Volume2,
	VolumeX,
	ChevronUp,
	Lock,
	Moon,
	LogOut,
	X,
	RotateCw,
	Power,
	Terminal,
	Settings as SettingsIcon,
	FileText,
	Calculator,
	Palette,
	Scissors,
	Activity,
	StickyNote,
	Image as ImageIcon,
	Camera,
	ShoppingBag,
	Headphones,
	Check,
	ChevronRight,
	Pin,
	PinOff,
} from "lucide-react";
import { motion, AnimatePresence, animate, useMotionValue, useTransform } from "framer-motion";
import { initTheme, applyTheme } from "./theme";
import { WifiPanel } from "./components/WifiPanel";
import { BluetoothPanel } from "./components/BluetoothPanel";
import TimeGun, { POMO_DEFAULT_DURATIONS, phaseMs, type PomodoroDurations, type PomodoroPhase } from "./TimeGun";
import { MediaTab } from "./MediaTab";
import "./Sidebar.css";

interface AppInfo {
	name: string;
	path: string;
	icon: string | null;
	is_running: boolean;
	hwnd?: number;
	executable?: string;
	all_hwnds?: [number, string][];
}

// A pinned app (Settings key bloom-sidebar-pins, a JSON list): enough to launch it and draw its icon.
interface PinApp {
	name: string;
	path: string;
	executable?: string;
	icon?: string | null;
}
const parsePins = (v: any): PinApp[] => {
	try {
		const a = typeof v === "string" ? JSON.parse(v) : v;
		if (!Array.isArray(a)) return [];
		return a
			.filter((p) => p && typeof p.path === "string" && typeof p.name === "string")
			.map((p) => ({ name: p.name, path: p.path, executable: p.executable || undefined, icon: p.icon ?? null }));
	} catch {
		return [];
	}
};

// An app as drawn on the bar. vkey tells apart the same app in two workspaces (one button in each).
type ViewApp = AppInfo & { vkey: string; min?: boolean };

// Timer state sent by the main window (App.tsx, event "pomo-state"). endAt is a Date.now() time, the same clock here.
interface PomoSync {
	active: boolean;
	running: boolean;
	endAt: number;
	remainingMs: number;
	phase: string;
	rounds?: number;
	durations?: PomodoroDurations;
}

interface WifiStatus {
	enabled: boolean;
	connected: boolean;
	ssid: string | null;
}

interface AudioSession {
	pid: number;
	name: string;
	process_path: string | null;
	volume: number;
	is_muted: boolean;
}

// Now-playing state sent by the main window (App.tsx, event "sb-media-state"): the same object as "media-update".
interface MediaSync {
	title: string;
	artist: string;
	is_playing: boolean;
	has_media: boolean;
	artwork?: string[];
	album?: string;
	source_app?: string;
	position_ms?: number;
	duration_ms?: number;
	seek_enabled?: boolean;
	position_updated_at?: number;
}

type PopupId = "wifi" | "bluetooth" | "volume" | "power" | "windows" | "appmenu" | "timer" | "controls" | "media";

// Size of each popup in CSS px (the sidebar page is zoomed with Bloom's UI scale, so these follow it).
// PANEL_H is the height of the popup; the volume one grows with the number of apps making sound.
const POPUP_W: Record<PopupId, number> = { wifi: 350, bluetooth: 350, volume: 300, power: 200, windows: 300, appmenu: 220, timer: 600, controls: 350, media: 600 };
const POPUP_H: Record<PopupId, number> = { wifi: 270, bluetooth: 270, volume: 150, power: 198, windows: 0, appmenu: 0, timer: 264, controls: 230, media: 250 }; // windows / appmenu: grow with their rows (see WIN_* and MENU_* below)
// The right-click menu on an app button: a title row (the app) and one row per action. Keep equal to .sb-pow / .sb-pow-row / .sb-menu-title in Sidebar.css.
const MENU_PAD = 10; // top and bottom padding
const MENU_TITLE = 26; // height of the title row
const MENU_ROW = 32; // height of an action row
const MENU_GAP = 3; // gap between rows
// The window picker (click an app that has several windows open): one row per window, a picture and the title.
const WIN_ROW = 76; // height of a row; keep equal to .sb-win-row in Sidebar.css
const WIN_GAP = 6; // keep equal to .sb-win gap
const WIN_PAD = 10; // keep equal to .sb-win padding (top and bottom)
const WIN_MAX = 5; // rows shown before the list scrolls
// The power menu (right-click on the Bloom button): a slim column of icon buttons on the screen edge farthest from the bar.
// Keep OV_PAD / OV_BTN / OV_GAP equal to .sb-ov-col / .sb-ov-btn in Sidebar.css.
const OV_PAD = 8;
const OV_BTN = 40;
const OV_GAP = 6;
const OV_W = 2 * OV_PAD + OV_BTN; // plus OV_EDGE when the bar has its frame strips
const OV_EDGE = 11; // the thin strip along the far screen edge; keep equal to --sb-strip in Sidebar.css
const OV_COUNT = 5; // number of buttons (POWER_ACTIONS)
const OV_H = 2 * OV_PAD + OV_COUNT * OV_BTN + (OV_COUNT - 1) * OV_GAP;
const POPUP_MARGIN = 24; // the power menu's clearance from the top and bottom of the screen
// A popup's own curved joins must not run into the bar's joins at the screen edge, or two arcs overlap. From the screen edge:
// the frame strip (FRAME_STRIP), then the bar's join (JOIN), then the popup's join (JOIN) before the popup itself.
const FRAME_STRIP = 11; // keep equal to --sb-strip in Sidebar.css
const JOIN = 20; // keep equal to --sb-fillet in Sidebar.css
const POPUP_EDGE = FRAME_STRIP + 2 * JOIN;
const BAR_W = 56; // keep equal to --sb-bar-w in Sidebar.css and BAR_RESERVE_W in sidebar.rs
// Room the bar window gains while a popup is open. A little wider than the widest popup, because the
// spring overshoots a few percent before it settles.
const POPUP_WIN_W = 370;
// The popup grows the way the notch does: the box itself changes width and height (springs taken from
// the notch), and the content fades in once there is room. It starts as a small bud at the icon.
const ICON = 34; // height of a bar button; the popup grows out of this
const BUD_W = 6; // width of the bud on the bar edge, before it opens
const GROW_W = { type: "spring", stiffness: 400, damping: 31 } as const;
const GROW_H = { type: "spring", stiffness: 450, damping: 29 } as const;
// Closing is overdamped on purpose: an underdamped spring would overshoot below zero width.
const SHRINK = { type: "spring", stiffness: 700, damping: 56 } as const;
// Focus highlight: a drop that stretches towards the next app. The edge in front moves first and the one
// behind follows, so it stretches while it travels and pulls back into a circle when it lands.
// Springy on purpose: the leading edge overshoots the icon a little and settles back, the trailing edge
// follows and wobbles once. For less bounce raise the damping values; for more, lower them.
// Damping is close to critical now: one small overshoot, then it settles without wobbling.
const DROP_LEAD = { type: "spring", stiffness: 900, damping: 48, restDelta: 0.2, restSpeed: 0.5 } as const;
const DROP_TRAIL = { type: "spring", stiffness: 480, damping: 36, restDelta: 0.2, restSpeed: 0.5 } as const;
const BTN = 36; // size of an app button; keep equal to .sb-btn in Sidebar.css
// komorebi workspaces of the monitor the bar is on (event "komorebi-workspaces", see komorebi.rs).
interface WorkspaceInfo {
	monitor: number;
	active: number;
	occupied: boolean[];
}
// The hwnds of each workspace of komorebi monitor `monitor` (sidebar_workspace_windows); refreshed when windows
// or focus change. null while `on` is false or komorebi cannot answer.
function useWorkspaceWindows(on: boolean, monitor: number, sig: string) {
	const [wins, setWins] = useState<number[][] | null>(null);
	useEffect(() => {
		if (!on) {
			setWins(null);
			return;
		}
		let dead = false;
		let t: number | undefined;
		const pull = () =>
			invoke<number[][] | null>("sidebar_workspace_windows", { monitor })
				.then((r) => {
					if (!dead) setWins(r ?? null);
				})
				.catch(() => {});
		const soon = () => {
			window.clearTimeout(t);
			t = window.setTimeout(pull, 180);
		};
		pull();
		const a = listen("windows-changed", soon);
		const b = listen<number>("sidebar-focus", soon);
		const iv = setInterval(pull, 10000);
		return () => {
			dead = true;
			window.clearTimeout(t);
			clearInterval(iv);
			a.then((f) => f());
			b.then((f) => f());
		};
	}, [on, monitor, sig]);
	return wins;
}
const PAD = 2; // how far the focus pill reaches above and below the button; keep equal to .sb-apps padding in Sidebar.css
// The focus drop is a true circle behind the focused app's icon: DOT_W wide (keep it equal to the width of .sb-focus in
// Sidebar.css) and DOT tall at rest, the same, so it is round. It moves and stretches between apps like a drop. Set DOT
// taller than DOT_W for a pill instead.
const DOT_W = 32;
const DOT = DOT_W;
const DOT_INSET = (BTN + 2 * PAD - DOT) / 2;
const DOT_X = (BTN - DOT_W) / 2; // centred on the focused button

// Apps whose own icon is a small glyph on a coloured tile (Windows Terminal, Settings, Notepad and the other
// Store-style inbox apps) look blurry and out of place on the bar. They are drawn with a line icon in the bar's
// text colour instead, like the volume / Wi-Fi / Bluetooth icons. Matched on the executable and app name
// (lower case). To cover another app, add a line: [regex, icon].
type Glyph = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
const APP_GLYPHS: [RegExp, Glyph][] = [
	[/windowsterminal|\bwt\.exe|powershell|pwsh|cmd\.exe|command prompt|terminal/, Terminal],
	[/systemsettings|(^|\s)(windows )?settings$/, SettingsIcon],
	[/notepad/, FileText],
	[/calculator|calc\.exe/, Calculator],
	[/mspaint|(^|\s)paint$/, Palette],
	[/snippingtool|screensketch|snip & sketch/, Scissors],
	[/taskmgr|task manager/, Activity],
	[/stickynotes|sticky notes/, StickyNote],
	[/\bphotos\b/, ImageIcon],
	[/windowscamera|(^|\s)camera$/, Camera],
	[/winstore|microsoft store/, ShoppingBag]
];
const glyphFor = (a: AppInfo): Glyph | null => {
	const id = `${(a.executable || "").toLowerCase()} ${(a.name || "").toLowerCase()}`;
	for (const [re, Icon] of APP_GLYPHS) if (re.test(id)) return Icon;
	return null;
};

const keyOf = (a: { path: string; executable?: string; name: string }) =>
	`${a.path.toLowerCase()}|${(a.executable || "").toLowerCase()}|${(a.name || "").toLowerCase()}`;

// ---------------------------------------------------------------- popups
// Each popup reuses what the notch already has (the Wi-Fi and Bluetooth views, the volume commands).
// They only draw inside the room the bar window gains while a popup is open (see sidebar_set_popup).

function WifiPopup({
	status,
	refresh,
	onClose,
	onPin
}: {
	status: WifiStatus | null;
	refresh: () => void;
	onClose: () => void;
	onPin: (p: boolean) => void;
}) {
	const toggle = async () => {
		const next = !(status?.enabled ?? false);
		try {
			await invoke("set_wifi_state", { enabled: next });
		} catch (e) {
			console.error("Failed to toggle Wi-Fi:", e);
		}
		// The radio and association take a moment to settle.
		setTimeout(refresh, 800);
		refresh();
	};
	return (
		<WifiPanel enabled={status?.enabled ?? false} onToggle={toggle} onBack={onClose} onPinChange={onPin} />
	);
}

function BluetoothPopup({
	enabled,
	refresh,
	onClose,
	onPin
}: {
	enabled: boolean;
	refresh: () => void;
	onClose: () => void;
	onPin: (p: boolean) => void;
}) {
	const toggle = async () => {
		try {
			await invoke("set_bluetooth_state", { enabled: !enabled });
		} catch (e) {
			console.error("Failed to toggle Bluetooth:", e);
		}
		setTimeout(refresh, 600);
		refresh();
	};
	return <BluetoothPanel enabled={enabled} onToggle={toggle} onBack={onClose} onPinChange={onPin} />;
}

// The window picker. One row per window of the app: a small picture (taken by sidebar_window_preview in
// sidebar.rs; the app's icon stands in until it arrives, or when Windows cannot capture that window) and the title.
// Every row has an X that closes just that window. After a right-click on the app (closeMode) the X is always
// visible, clicking a row closes it instead of focusing it, and a footer row closes them all.
function WindowsPopup({
	wins,
	appName,
	icon,
	current,
	closeMode,
	minimized,
	pinned,
	onPick,
	onCloseOne,
	onCloseAll,
	onTogglePin
}: {
	wins: [number, string][];
	appName: string;
	icon: string | null;
	current: number | null;
	closeMode: boolean;
	minimized: number[];
	pinned: boolean;
	onPick: (hwnd: number) => void;
	onCloseOne: (hwnd: number) => void;
	onCloseAll: () => void;
	onTogglePin: () => void;
}) {
	const [shots, setShots] = useState<Record<number, string>>({});
	const ids = wins.map(([h]) => h).join(",");
	useEffect(() => {
		let dead = false;
		(async () => {
			for (const [h] of wins) {
				if (shots[h]) continue;
				try {
					const r = await invoke<string | null>("sidebar_window_preview", { hwnd: h, maxW: 224, maxH: 140 });
					if (dead) return;
					if (r) setShots((p) => ({ ...p, [h]: r }));
				} catch {}
			}
		})();
		return () => {
			dead = true;
		};
	}, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
	const act = (h: number) => (closeMode ? onCloseOne(h) : onPick(h));
	return (
		<div className={`sb-win ${closeMode ? "closing-mode" : ""}`}>
			<div className="sb-win-list">
				{wins.map(([h, title]) => (
					<div
						key={h}
						role="button"
						tabIndex={0}
						className={`sb-win-row ${h === current ? "cur" : ""} ${minimized.includes(h) ? "min" : ""}`}
						onClick={() => act(h)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								act(h);
							}
						}}
					>
						<span className="sb-win-thumb">
							{shots[h] ? (
								<img src={shots[h]} alt="" draggable={false} />
							) : icon ? (
								<img className="ico" src={icon} alt="" draggable={false} />
							) : null}
							{minimized.includes(h) && <span className="sb-win-tag">Minimized</span>}
						</span>
						<span className="sb-win-title">{title || appName}</span>
						<button
							className="sb-win-x"
							onClick={(e) => {
								e.stopPropagation();
								onCloseOne(h);
							}}
						>
							<X size={14} strokeWidth={2} />
						</button>
					</div>
				))}
			</div>
			{closeMode && (
				<button className="sb-pow-row danger" onClick={onCloseAll}>
					<X size={16} strokeWidth={1.8} />
					<span>Close all {wins.length} windows</span>
				</button>
			)}
			{closeMode && (
				<button className="sb-pow-row" onClick={onTogglePin}>
					{pinned ? <PinOff size={16} strokeWidth={1.8} /> : <Pin size={16} strokeWidth={1.8} />}
					<span>{pinned ? "Unpin from top" : "Pin to top"}</span>
				</button>
			)}
		</div>
	);
}

// Right-click on an app button: close its window. "Close window" closes the one that is in front (the focused one,
// else the app's main one); an app with several windows also gets "Close all". The window is asked to close the
// way its own X does, so an app with unsaved work still gets to ask first.
function AppMenuPopup({
	name,
	icon,
	count,
	pinned,
	onClose,
	onCloseAll,
	onTogglePin
}: {
	name: string;
	icon: string | null;
	count: number;
	pinned: boolean;
	onClose: () => void;
	onCloseAll: () => void;
	onTogglePin: () => void;
}) {
	return (
		<div className="sb-pow">
			<div className="sb-menu-title">
				{icon ? <img src={icon} alt="" draggable={false} /> : null}
				<span>{name}</span>
			</div>
			{count > 0 && (
				<button className="sb-pow-row danger" onClick={onClose}>
					<X size={16} strokeWidth={1.8} />
					<span>Close window</span>
				</button>
			)}
			{count > 1 && (
				<button className="sb-pow-row danger" onClick={onCloseAll}>
					<X size={16} strokeWidth={1.8} />
					<span>Close all {count} windows</span>
				</button>
			)}
			<button className="sb-pow-row" onClick={onTogglePin}>
				{pinned ? <PinOff size={16} strokeWidth={1.8} /> : <Pin size={16} strokeWidth={1.8} />}
				<span>{pinned ? "Unpin from top" : "Pin to top"}</span>
			</button>
		</div>
	);
}

// Right-click on the Bloom button: dim the screen and show these as icon buttons (the name is the tooltip).
// Same actions (and names) as the dashboard's power buttons.
const POWER_ACTIONS = [
	{ action: "lock", label: "Bear Mode", Icon: Lock },
	{ action: "sleep", label: "Nap Time", Icon: Moon },
	{ action: "sign_out", label: "Dip Out", Icon: LogOut },
	{ action: "restart", label: "Oops, Reboot", Icon: RotateCw },
	{ action: "shutdown", label: "Rage Quit", Icon: Power }
] as const;

function PowerColumn({ onClose, edge, far }: { onClose: () => void; edge: number; far: "left" | "right" }) {
	return (
		<div className="sb-ov-col" style={{ [far === "left" ? "paddingLeft" : "paddingRight"]: OV_PAD + edge } as CSSProperties}>
			{POWER_ACTIONS.map(({ action, Icon }) => (
				<button
					key={action}
					className={`sb-ov-btn ${action === "restart" || action === "shutdown" ? "danger" : ""}`}
					onClick={() => {
						invoke("system_power_action", { action }).catch(() => {});
						onClose();
					}}
				>
					<Icon size={18} strokeWidth={1.8} />
				</button>
			))}
		</div>
	);
}

// The Bloom button's picture, always drawn as a circle. Chosen in Settings > Side Bar (Bar icon), or a new
// image can be picked here with a middle click. Settings keys: bloom-sidebar-icon = bloom | recycle | custom,
// bloom-sidebar-icon-custom = the picked image (a 128px PNG as a data URL).
// The recycle preset is drawn like the bar's other icons (thin round-capped strokes, 24px grid), in the same
// colour as the volume / Wi-Fi / Bluetooth icons, so it follows the same pywal text colour.
const RECYCLE_PATH =
	"M19.37 13.84A7.6 7.6 0 0 1 12.27 19.60M12.27 19.60L14.98 17.55M12.27 19.60L15.12 21.45M6.72 17.47A7.6 7.6 0 0 1 5.29 8.43M5.29 8.43L5.70 11.81M5.29 8.43L2.26 9.98M9.91 4.69A7.6 7.6 0 0 1 18.45 7.97M18.45 7.97L15.32 6.64M18.45 7.97L18.62 4.58";
// The saved opacity is a percent (10 to 100) as text; anything else (or nothing) means "use the icon's default".
function parseOpacity(v: unknown): number | null {
	const n = Number(v);
	return v !== "" && v != null && Number.isFinite(n) && n >= 5 && n <= 100 ? n / 100 : null;
}
function RecycleIcon() {
	return (
		<svg className="sb-recycle" viewBox="0 0 24 24" aria-hidden="true">
			<path d={RECYCLE_PATH} />
		</svg>
	);
}

function VolumePopup({
	volume,
	muted,
	onResize
}: {
	volume: number;
	muted: boolean;
	onResize: (h: number) => void;
}) {
	const [sessions, setSessions] = useState<AudioSession[]>([]);
	const [icons, setIcons] = useState<Record<string, string>>({});
	const [master, setMaster] = useState(volume);
	const dragging = useRef(false);

	useEffect(() => {
		if (!dragging.current) setMaster(volume);
	}, [volume]);

	useEffect(() => {
		let alive = true;
		const load = async () => {
			try {
				const list = await invoke<AudioSession[]>("get_audio_sessions");
				if (!alive) return;
				setSessions(list);
				list.forEach(async (s) => {
					const p = s.process_path;
					if (!p) return;
					try {
						const ic = await invoke<string | null>("get_app_icon", { path: p });
						if (ic && alive) setIcons((m) => (m[p] ? m : { ...m, [p]: ic }));
					} catch {}
				});
			} catch {}
		};
		void load();
		const t = setInterval(load, 2000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, []);

	// Header row + master row + one row per app.
	useEffect(() => {
		onResize(Math.min(340, 96 + sessions.length * 40 + (sessions.length ? 20 : 0)));
	}, [sessions.length, onResize]);

	const setAppVol = (pid: number, v: number) => {
		setSessions((l) => l.map((s) => (s.pid === pid ? { ...s, volume: v, is_muted: false } : s)));
		invoke("set_app_volume", { pid, volume: v }).catch(() => {});
	};
	const toggleAppMute = (s: AudioSession) => {
		setSessions((l) => l.map((x) => (x.pid === s.pid ? { ...x, is_muted: !s.is_muted } : x)));
		invoke("set_app_mute", { pid: s.pid, muted: !s.is_muted }).catch(() => {});
	};

	return (
		<div className="sb-vol" onClick={(e) => e.stopPropagation()}>
			<div className="sb-vol-title">Volume</div>
			<div className="sb-vol-row">
				<span className="sb-vol-name">{muted ? "Muted" : "Output"}</span>
				<input
					type="range"
					min={0}
					max={100}
					value={Math.round(master * 100)}
					onPointerDown={() => (dragging.current = true)}
					onPointerUp={() => (dragging.current = false)}
					onChange={(e) => {
						const v = Number(e.target.value) / 100;
						setMaster(v);
						invoke("set_volume", { volume: v }).catch(() => {});
					}}
				/>
				<span className="sb-vol-pct">{Math.round(master * 100)}</span>
			</div>
			{sessions.length > 0 && <div className="sb-vol-sep" />}
			{sessions.map((s) => (
				<div className={`sb-vol-row ${s.is_muted ? "muted" : ""}`} key={s.pid}>
					<button
						className="sb-vol-app"
						onClick={() => toggleAppMute(s)}
					>
						{s.process_path && icons[s.process_path] ? (
							<img src={icons[s.process_path]} alt="" draggable={false} />
						) : (
							<span>{s.name?.[0]}</span>
						)}
					</button>
					<input
						type="range"
						min={0}
						max={100}
						value={Math.round(s.volume * 100)}
						onChange={(e) => setAppVol(s.pid, Number(e.target.value) / 100)}
					/>
					<span className="sb-vol-pct">{Math.round(s.volume * 100)}</span>
				</div>
			))}
		</div>
	);
}

// The media widget in the middle of the bar, styled like the YASB media pill (media_now): a glass pill with fully rounded
// ends, the album art behind it (65 % opaque, faded out at both ends), a note, and "title - artist" running down it as
// rotated text. Like YASB's controls_hide, the previous / play / next buttons only show while the pill is hovered. When the
// text is longer than the pill it keeps running and loops by itself (two copies one after the other, so there is no jump);
// a short text stays in place. Click opens the media popup; middle-click and right-click play / pause.
const MQ_GAP = 28; // empty space between the end of the text and its copy; keep equal to .sb-mq-gap in Sidebar.css
const MQ_SPEED = 30; // px per second, like the notch's title
const MEDIA_SEP = " - "; // between title and artist (separator in YASB's config)
function MediaWidget({
	media,
	onOpen,
	onToggle
}: {
	media: MediaSync | null;
	onOpen: (el: HTMLElement) => void;
	onToggle: () => void;
}) {
	const has = !!media?.has_media;
	const playing = has && !!media?.is_playing;
	const text = has ? [media?.title, media?.artist].filter(Boolean).join(MEDIA_SEP) : "";
	const art = has ? (media?.artwork?.[0] ?? null) : null;
	const boxRef = useRef<HTMLDivElement>(null);
	const txtRef = useRef<HTMLSpanElement>(null);
	const [len, setLen] = useState(0); // length of the text in px
	const [room, setRoom] = useState(0); // height of the text area in px
	// The title keeps running: a short one too, looped with as many copies as it takes to fill the room.
	const over = has && len > 0 && room > 0;
	const copies = over ? Math.ceil(room / (len + MQ_GAP)) + 1 : 1;
	useLayoutEffect(() => {
		const box = boxRef.current;
		const t = txtRef.current;
		if (!box || !t) return;
		const measure = () => {
			setLen(t.offsetHeight);
			setRoom(box.clientHeight);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(box);
		ro.observe(t);
		return () => ro.disconnect();
	}, [text]);
	return (
		<div
			role="button"
			tabIndex={0}
			className={`sb-media ${has ? "" : "idle"} ${playing ? "play" : ""} ${art ? "art" : ""}`}
			onClick={(e) => onOpen(e.currentTarget)}
			onMouseDown={(e) => e.button === 1 && e.preventDefault()}
			onAuxClick={(e) => {
				if (e.button !== 1) return;
				e.preventDefault();
				if (has) onToggle();
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				if (has) onToggle();
			}}
		>
			{!has && (
				<div className="sb-idle" aria-label="Nothing playing">
					<svg className="sb-idle-note" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
						<path d="M9 18V5l12-2v13" />
						<circle cx="6" cy="18" r="3" />
						<circle cx="18" cy="16" r="3" />
					</svg>
					<span className="sb-idle-t">No media</span>
					<span className="sb-idle-bars" aria-hidden="true">
						<i />
						<i />
						<i />
						<i />
					</span>
				</div>
			)}
			<div className="sb-pill">
				{art && <i className="sb-media-thumb" style={{ backgroundImage: `url(${JSON.stringify(art)})` }} />}
				{has && (
					<div className="sb-cover" style={art ? { backgroundImage: `url(${JSON.stringify(art)})` } : undefined} aria-hidden="true">
						{!art && (
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M9 18V5l12-2v13" />
								<circle cx="6" cy="18" r="3" />
								<circle cx="18" cy="16" r="3" />
							</svg>
						)}
					</div>
				)}
				<div ref={boxRef} className={`sb-mq ${over ? "over" : ""}`}>
					<div
						className="sb-mq-track"
						style={over ? ({ "--mq-shift": `${len + MQ_GAP}px`, "--mq-dur": `${(len + MQ_GAP) / MQ_SPEED}s` } as CSSProperties) : undefined}
					>
						<span ref={txtRef} className="sb-mq-t">
							{text}
						</span>
						{over &&
							Array.from({ length: copies - 1 }, (_, i) => (
								<Fragment key={i}>
									<i className="sb-mq-gap" />
									<span className="sb-mq-t" aria-hidden="true">
										{text}
									</span>
								</Fragment>
							))}
					</div>
				</div>
				{has && (
					<span className="sb-eq" aria-hidden="true">
						<i />
						<i />
						<i />
						<i />
					</span>
				)}
			</div>
		</div>
	);
}

// The media popup: the Media tab of the dashboard, from the state the main window sends. The buttons talk to the
// media commands directly (this window can call them too). Changing the picture beside the cover stays in the dashboard.
function MediaPopup({
	media,
	slot,
	onPlayPause,
	onPrevious,
	onNext
}: {
	media: MediaSync | null;
	slot: string | null;
	onPlayPause: () => void;
	onPrevious: () => void;
	onNext: () => void;
}) {
	const m = media;
	return (
		<div className="sb-mt" onClick={(e) => e.stopPropagation()}>
			<MediaTab
				media={{
					hasMedia: !!m?.has_media,
					title: m?.title ?? "",
					artist: m?.artist ?? "",
					album: m?.album ?? "",
					source: m?.source_app ?? "",
					art: m?.artwork?.[0] ?? null,
					isPlaying: !!m?.is_playing,
					positionMs: m?.position_ms ?? 0,
					durationMs: m?.duration_ms ?? 0,
					seekEnabled: m?.seek_enabled ?? false,
					positionUpdatedAt: m?.position_updated_at ?? 0
				}}
				onPlayPause={onPlayPause}
				onPrevious={onPrevious}
				onNext={onNext}
				slotImage={slot}
			/>
		</div>
	);
}

// The Time gun, as a popup (left click on the clock). The timer itself runs in the main window; this popup draws the
// same TimeGun panel the notch used to show, from the state the main window sends ("pomo-state"), and sends
// the buttons back as "pomo-cmd". TimeGun brings its own styles; .sb-tg only drops it into the popup's box.
function TimerPopup({ pomo, now }: { pomo: PomoSync | null; now: number }) {
	const [quote, setQuote] = useState(0);
	const dur: PomodoroDurations = pomo?.durations ?? POMO_DEFAULT_DURATIONS;
	const phase = (pomo?.phase as PomodoroPhase | undefined) ?? "focus";
	const running = !!pomo?.running;
	const total = phaseMs(phase, dur);
	const remaining = pomo ? (running ? Math.max(0, pomo.endAt - now) : pomo.remainingMs) : total;
	const send = (cmd: string, extra?: Record<string, unknown>) => emit("pomo-cmd", { cmd, ...extra }).catch(() => {});
	return (
		<div className="sb-tg">
			<div className="tg-panel" onClick={(e) => e.stopPropagation()}>
				<TimeGun
					phase={phase}
					running={running}
					remainingMs={remaining}
					totalMs={total}
					rounds={pomo?.rounds ?? 0}
					durations={dur}
					quoteSignal={quote}
					onToggle={() => {
						// A fresh focus session (not a resume) shows the quote, like in the notch.
						if (!running && phase === "focus" && remaining >= total - 50) setQuote((q) => q + 1);
						send("toggle");
					}}
					onSkip={() => send("skip")}
					onReset={() => send("reset")}
					onDuration={(ph: PomodoroPhase, delta: number) => send("duration", { phase: ph, delta })}
				/>
			</div>
		</div>
	);
}

// The Controls popup (right click on the clock): the quick switches and sliders of the notch's Controls panel.
// ---------------------------------------------------------------- text colour (same picker as the notch's Controls)
const HEX_RE = /^#[0-9a-f]{6}$/i;

function normalizeHex(input: string): string | null {
	let v = input.trim().replace(/^#/, "").toLowerCase();
	if (/^[0-9a-f]{3}$/.test(v)) v = v.split("").map((c) => c + c).join("");
	return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

function textColorMuted(hex: string): string {
	const n = parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.65)`;
}

function hsvToHex(h: number, s: number, v: number): string {
	const f = (n: number) => {
		const k = (n + h / 60) % 6;
		const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
		return Math.round(c * 255).toString(16).padStart(2, "0");
	};
	return `#${f(5)}${f(3)}${f(1)}`;
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
	const n = parseInt(hex.slice(1), 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

// The text colour the current theme is painting right now (used to start the picker)
function currentThemeTextHex(): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue("--bloom-text").trim();
	return normalizeHex(v) ?? "#ffffff";
}

function TextColorIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M6 16 12 4l6 12" />
			<path d="M8.4 12h7.2" />
			<path d="M4 21h16" strokeWidth="3" />
		</svg>
	);
}

function CcIcon({ children, size = 18, sw = 2.5, style }: { children: ReactNode; size?: number; sw?: number; style?: CSSProperties }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
			{children}
		</svg>
	);
}
const CcWifi = ({ enabled, connected }: { enabled: boolean; connected: boolean }) => (
	<CcIcon style={{ opacity: !enabled ? 0.4 : connected ? 1 : 0.7 }}>
		<path d="M5 12.55a11 11 0 0 1 14.08 0" />
		<path d="M1.42 9a16 16 0 0 1 21.16 0" />
		<path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
		<line x1="12" y1="20" x2="12.01" y2="20" />
	</CcIcon>
);
const CcBluetooth = () => (
	<CcIcon>
		<path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
	</CcIcon>
);
const CcTheme = () => (
	<CcIcon sw={2}>
		<circle cx="12" cy="12" r="9" />
		<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
	</CcIcon>
);
const CcAudio = () => (
	<CcIcon size={16}>
		<path d="M11 5L6 9H2v6h4l5 4V5z" />
		<path d="M15.5 8.5a5 5 0 0 1 0 7" />
		<path d="M18.5 5.5a9 9 0 0 1 0 13" />
	</CcIcon>
);
const CcGame = () => (
	<CcIcon size={16} sw={2}>
		<line x1="6" y1="12" x2="10" y2="12" />
		<line x1="8" y1="10" x2="8" y2="14" />
		<line x1="15" y1="13" x2="15.01" y2="13" />
		<line x1="18" y1="11" x2="18.01" y2="11" />
		<path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" />
	</CcIcon>
);
const CcSettings = () => (
	<CcIcon size={16}>
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
	</CcIcon>
);
const CcReload = () => (
	<CcIcon size={16}>
		<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
	</CcIcon>
);
const CcMonitor = () => (
	<CcIcon size={16} sw={2}>
		<rect x="2" y="4" width="8" height="12" rx="1" />
		<rect x="14" y="4" width="8" height="12" rx="1" />
		<path d="M6 20h12M12 16v4" />
	</CcIcon>
);
const CcNotch = () => (
	<CcIcon>
		<path d="M4 3h16a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
		<path d="M9 9v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V9" />
	</CcIcon>
);
const CcVolume = () => (
	<CcIcon size={12} sw={2} style={{ opacity: 0.5 }}>
		<path d="M11 5L6 9H2v6h4l5 4V5z" />
	</CcIcon>
);
const CcBrightness = () => (
	<CcIcon size={12} sw={2} style={{ opacity: 0.5 }}>
		<circle cx="12" cy="12" r="5" fill="currentColor" />
	</CcIcon>
);

// Keep the sizes equal to .sb-ctl in Sidebar.css (POPUP_H.controls).
function ControlsPopup({
	wifi,
	bt,
	vol,
	refreshWifi,
	refreshBt,
	openPopup,
	onClose,
	onPin,
	textColor,
	onTextColor,
	onTextColorReset
}: {
	wifi: WifiStatus | null;
	bt: boolean;
	vol: { volume: number; muted: boolean };
	refreshWifi: () => void;
	refreshBt: () => void;
	openPopup: (id: PopupId, el: HTMLElement) => void;
	onClose: () => void;
	onPin: (pinned: boolean) => void;
	textColor: string;
	onTextColor: (hex: string) => void;
	onTextColorReset: () => void;
}) {
	// Sound output and text colour open as a sheet over the popup, like the notch's Controls.
	const [sheet, setSheet] = useState<null | "audio" | "text">(null);
	const [outputs, setOutputs] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
	const [hsv, setHsv] = useState({ h: 0, s: 0, v: 1 });
	const [hexDraft, setHexDraft] = useState("#ffffff");
	const refreshOutputs = useCallback(() => {
		invoke<{ id: string; name: string; isDefault: boolean }[]>("list_audio_outputs")
			.then(setOutputs)
			.catch((e) => console.error("Failed to list audio outputs:", e));
	}, []);
	const pickOutput = (id: string) => {
		setOutputs((list) => list.map((d) => ({ ...d, isDefault: d.id === id })));
		invoke("set_audio_output", { id })
			.catch((e) => console.error("Failed to switch audio output:", e))
			.finally(() => window.setTimeout(refreshOutputs, 400));
	};
	const toggleAudio = () => {
		if (sheet === "audio") return setSheet(null);
		refreshOutputs();
		setSheet("audio");
	};
	const toggleText = () => {
		if (sheet === "text") return setSheet(null);
		const base = HEX_RE.test(textColor) ? textColor : currentThemeTextHex();
		setHexDraft(base);
		setHsv(hexToHsv(base));
		setSheet("text");
	};
	const liveText = (hex: string) => onTextColor(hex.toLowerCase());
	const pickSV = (e: ReactPointerEvent<HTMLDivElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const sat = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		const val = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
		const hex = hsvToHex(hsv.h, sat, val);
		setHsv({ h: hsv.h, s: sat, v: val });
		setHexDraft(hex);
		liveText(hex);
	};
	// The picker is dragged with the pointer capture; keep the popup open if the pointer strays outside it.
	const pinRef = useRef(onPin);
	pinRef.current = onPin;
	useEffect(() => () => pinRef.current(false), []);
	const [bright, setBright] = useState<number | null>(null);
	const [master, setMaster] = useState(vol.volume);
	const [theme, setTheme] = useState(() => localStorage.getItem("bloom-theme-mode") || "dark");
	const dragging = useRef(false);
	const briTimer = useRef<number | undefined>(undefined);
	useEffect(() => {
		invoke<number>("get_brightness")
			.then(setBright)
			.catch(() => {});
	}, []);
	useEffect(() => {
		if (!dragging.current) setMaster(vol.volume);
	}, [vol.volume]);
	const toggleWifi = async () => {
		try {
			await invoke("set_wifi_state", { enabled: !(wifi?.enabled ?? false) });
		} catch (e) {
			console.error("Failed to toggle Wi-Fi:", e);
		}
		setTimeout(refreshWifi, 800);
		refreshWifi();
	};
	const toggleBt = async () => {
		try {
			await invoke("set_bluetooth_state", { enabled: !bt });
		} catch (e) {
			console.error("Failed to toggle Bluetooth:", e);
		}
		setTimeout(refreshBt, 600);
		refreshBt();
	};
	const cycleTheme = () => {
		emit("controls-cmd", { cmd: "theme" }).catch(() => {});
		window.setTimeout(() => setTheme(localStorage.getItem("bloom-theme-mode") || "dark"), 300);
	};
	const setBrightness = (v: number) => {
		setBright(v);
		window.clearTimeout(briTimer.current);
		briTimer.current = window.setTimeout(() => invoke("set_brightness", { brightness: v }).catch(() => {}), 50);
	};
	return (
		<div className="sb-ctl">
			<div className="sb-cc-pills">
				<div
					className={`sb-cc-pill ${wifi?.enabled ? "active" : ""}`}
					onClick={toggleWifi}
					onContextMenu={(e) => {
						e.preventDefault();
						openPopup("wifi", e.currentTarget);
					}}
				>
					<div className="sb-cc-pill-icon">
						<CcWifi enabled={!!wifi?.enabled} connected={!!wifi?.connected} />
					</div>
					<div className="sb-cc-pill-info">
						<span className="sb-cc-pill-title">Wi-Fi</span>
						<span className="sb-cc-pill-status">
							{wifi == null ? "…" : !wifi.enabled ? "Off" : wifi.connected ? (wifi.ssid ?? "Connected") : "Not connected"}
						</span>
					</div>
					<button
						className="sb-cc-pill-more"
						onClick={(e) => {
							e.stopPropagation();
							openPopup("wifi", e.currentTarget);
						}}
					>
						<ChevronRight />
					</button>
				</div>
				<div className="sb-cc-pill" onClick={cycleTheme}>
					<div className="sb-cc-pill-icon">
						<CcTheme />
					</div>
					<div className="sb-cc-pill-info">
						<span className="sb-cc-pill-title">Theme</span>
						<span className="sb-cc-pill-status">{theme.charAt(0).toUpperCase() + theme.slice(1)}</span>
					</div>
				</div>
				<div
					className={`sb-cc-pill ${bt ? "active" : ""}`}
					onClick={toggleBt}
					onContextMenu={(e) => {
						e.preventDefault();
						openPopup("bluetooth", e.currentTarget);
					}}
				>
					<div className="sb-cc-pill-icon">
						<CcBluetooth />
					</div>
					<div className="sb-cc-pill-info">
						<span className="sb-cc-pill-title">Bluetooth</span>
						<span className="sb-cc-pill-status">{bt ? "On" : "Off"}</span>
					</div>
					<button
						className="sb-cc-pill-more"
						onClick={(e) => {
							e.stopPropagation();
							openPopup("bluetooth", e.currentTarget);
						}}
					>
						<ChevronRight />
					</button>
				</div>
				<div className="sb-cc-pill locked">
					<div className="sb-cc-pill-icon">
						<CcNotch />
					</div>
					<div className="sb-cc-pill-info">
						<span className="sb-cc-pill-title">Notch Mode</span>
						<span className="sb-cc-pill-status">Peek</span>
					</div>
					<span className="sb-cc-lock">
						<Lock size={12} strokeWidth={2.4} />
					</span>
				</div>
			</div>
			<div className="sb-cc-actions">
				<button className={`sb-cc-btn ${sheet === "audio" ? "active" : ""}`} onClick={toggleAudio}>
					<CcAudio />
				</button>
				<button className="sb-cc-btn" onClick={() => invoke("launch_game_overlay").catch(() => {})}>
					<CcGame />
				</button>
				<button className={`sb-cc-btn ${HEX_RE.test(textColor) ? "active" : ""}`} onClick={toggleText}>
					<TextColorIcon />
				</button>
				<button
					className="sb-cc-btn"
					onClick={() => {
						invoke("open_settings_window").catch(() => {});
						onClose();
					}}
				>
					<CcSettings />
				</button>
				<button className="sb-cc-btn" onClick={() => invoke("restart_bloom").catch(() => {})}>
					<CcReload />
				</button>
				<button className="sb-cc-btn" onClick={() => invoke("cycle_bloom_monitor").catch(() => {})}>
					<CcMonitor />
				</button>
			</div>
			<div className="sb-cc-sliders">
				<div className="sb-cc-row">
					<div className="sb-cc-label">
						<CcVolume />
						<span>Volume</span>
					</div>
					<div className="sb-cc-track">
						<input
							type="range"
							min={0}
							max={100}
							value={Math.round(master * 100)}
							onPointerDown={() => (dragging.current = true)}
							onPointerUp={() => (dragging.current = false)}
							onChange={(e) => {
								const v = Number(e.target.value) / 100;
								setMaster(v);
								invoke("set_volume", { volume: v }).catch(() => {});
							}}
						/>
						<div className="sb-cc-fill" style={{ width: `${master * 100}%` }} />
					</div>
					<span className="sb-cc-pct">{Math.round(master * 100)}%</span>
				</div>
				<div className="sb-cc-row">
					<div className="sb-cc-label">
						<CcBrightness />
						<span>Brightness</span>
					</div>
					<div className="sb-cc-track">
						<input
							type="range"
							min={1}
							max={100}
							value={bright ?? 50}
							disabled={bright == null}
							onChange={(e) => setBrightness(Number(e.target.value))}
						/>
						<div className="sb-cc-fill" style={{ width: `${bright ?? 50}%` }} />
					</div>
					<span className="sb-cc-pct">{bright ?? "–"}%</span>
				</div>
			</div>
			<AnimatePresence>
				{sheet && (
					<motion.div
						key={sheet}
						className="sb-sheet"
						initial={{ opacity: 0, y: 24 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 16, transition: { duration: 0.12 } }}
						transition={{ type: "spring", stiffness: 420, damping: 32 }}
					>
						<div className="sb-sheet-head">
							<span>{sheet === "audio" ? "Sound Output" : "Text Color"}</span>
							<button className="sb-sheet-close" onClick={() => setSheet(null)}>
								<X size={13} strokeWidth={2.2} />
							</button>
						</div>
						{sheet === "audio" ? (
							<div className="sb-sheet-list">
								{outputs.length === 0 ? (
									<div className="sb-sheet-empty">No output devices found</div>
								) : (
									outputs.map((d) => (
										<button key={d.id} className={`sb-sheet-item ${d.isDefault ? "on" : ""}`} onClick={() => pickOutput(d.id)}>
											<Headphones size={14} />
											<span>{d.name}</span>
											{d.isDefault && <Check size={14} strokeWidth={2.6} />}
										</button>
									))
								)}
							</div>
						) : (
							<div className="sb-tc">
								<div className="sb-tc-left">
									<div
										className="sb-tc-sv"
										style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))` }}
										onPointerDown={(e) => {
											e.currentTarget.setPointerCapture(e.pointerId);
											onPin(true);
											pickSV(e);
										}}
										onPointerMove={(e) => {
											if (e.currentTarget.hasPointerCapture(e.pointerId)) pickSV(e);
										}}
										onPointerUp={() => onPin(false)}
										onPointerCancel={() => onPin(false)}
									>
										<div className="sb-tc-knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
									</div>
									<input
										type="range"
										className="sb-tc-hue"
										min={0}
										max={360}
										value={Math.round(hsv.h)}
										onPointerDown={() => onPin(true)}
										onPointerUp={() => onPin(false)}
										onChange={(e) => {
											const h = Number(e.target.value);
											const hex = hsvToHex(h, hsv.s, hsv.v);
											setHsv({ ...hsv, h });
											setHexDraft(hex);
											liveText(hex);
										}}
									/>
								</div>
								<div className="sb-tc-right">
									<div className="sb-tc-swatch" style={{ background: HEX_RE.test(textColor) ? textColor : currentThemeTextHex() }} />
									<input
										className="sb-tc-hex"
										value={hexDraft}
										maxLength={7}
										spellCheck={false}
										onFocus={() => onPin(true)}
										onChange={(e) => {
											const v = e.target.value;
											setHexDraft(v);
											const hex = /^#?[0-9a-fA-F]{6}$/.test(v) ? normalizeHex(v) : null;
											if (hex) {
												setHsv(hexToHsv(hex));
												liveText(hex);
											}
										}}
										onBlur={() => {
											onPin(false);
											const hex = normalizeHex(hexDraft);
											if (hex) {
												setHexDraft(hex);
												setHsv(hexToHsv(hex));
												liveText(hex);
											} else {
												setHexDraft(HEX_RE.test(textColor) ? textColor : currentThemeTextHex());
											}
										}}
										onKeyDown={(e) => {
											e.stopPropagation();
											if (e.key === "Enter") e.currentTarget.blur();
										}}
									/>
									<button
										className={`sb-tc-auto ${textColor === "auto" ? "on" : ""}`}
										onClick={() => {
											onTextColorReset();
											window.setTimeout(() => {
												const base = currentThemeTextHex();
												setHexDraft(base);
												setHsv(hexToHsv(base));
											}, 50);
										}}
									>
										Auto
									</button>
								</div>
							</div>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

// ---------------------------------------------------------------- bar

export default function Sidebar() {
	const [running, setRunning] = useState<AppInfo[]>([]);
	// Order the apps first showed up in. get_active_windows answers in focus order, so using its order
	// directly made the icons swap places every time a window got focus (same fix as the dock).
	const [order, setOrder] = useState<string[]>([]);
	const pollSeq = useRef(0);
	const [icons, setIcons] = useState<Record<string, string>>({});
	const [mode, setMode] = useState("smart");
	const [side, setSide] = useState<"left" | "right">("left");
	const [overlap, setOverlap] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [now, setNow] = useState(new Date());
	// The Time gun's countdown, shown in the clock slot while the timer is running or paused part way.
	const [pomo, setPomo] = useState<PomoSync | null>(null);
	const [pomoNow, setPomoNow] = useState(() => Date.now());
	const iconsRef = useRef<Record<string, string>>({});

	// Status shown by the bottom icons.
	const [wifi, setWifi] = useState<WifiStatus | null>(null);
	const [bt, setBt] = useState(true);
	const [vol, setVol] = useState({ volume: 0.5, muted: false });
	// Which window has focus (hwnd), and whether the Windows tray popup is open.
	const [fg, setFg] = useState(0);
	const [trayOpen, setTrayOpen] = useState(false);
	const trayTimer = useRef<number | null>(null);

	// Open popup: which one, and the vertical centre of the icon that opened it.
	const [popup, setPopup] = useState<{ id: PopupId; iconY: number; appKey?: string; close?: boolean } | null>(null);
	// Windows that were just asked to close: hidden from the picker straight away (they leave the list for good
	// once the next window poll no longer has them; one that refuses to close, say for a save prompt, comes back).
	const [closing, setClosing] = useState<number[]>([]);
	const [iconKind, setIconKind] = useState("bloom");
	const [customIcon, setCustomIcon] = useState<string | null>(null);
	// Opacity of the Bloom button's picture, 0.1 to 1 (Settings > Side Bar > Icon opacity). null = each icon's own default.
	const [startOp, setStartOp] = useState<number | null>(null);
	// komorebi workspaces of the monitor the bar is on (null when komorebi is not running), and the setting.
	const [showWs, setShowWs] = useState(false);
	const [wsRaw, setWs] = useState<WorkspaceInfo | null>(null);
	// The same for the next monitor in komorebi's list (the second screen); null with one monitor.
	const [ws2Raw, setWs2] = useState<WorkspaceInfo | null>(null);
	// While an app is being sent to another workspace the backend focuses windows and may switch workspaces for a
	// moment, and komorebi reports every step. The bar would show the focus and the active workspace jumping around,
	// so what it shows of the workspaces is held still until the move is done (see dropApp).
	const [wsLock, setWsLock] = useState<{ ws: WorkspaceInfo | null; ws2: WorkspaceInfo | null } | null>(null);
	const ws = wsLock ? wsLock.ws : wsRaw;
	const ws2 = wsLock ? wsLock.ws2 : ws2Raw;
	const wsLockTimer = useRef<number | undefined>(undefined);
	// Windows that were just dropped on a workspace, shown in their new workspace at once, without waiting for
	// komorebi to report the move (that takes about half a second). Dropped from here when komorebi agrees.
	const [moves, setMoves] = useState<Map<number, { mon: number; idx: number }>>(() => new Map());
	// Pinned apps, in the order they were pinned.
	const [pins, setPins] = useState<PinApp[]>([]);
	const iconInput = useRef<HTMLInputElement>(null);
	const pickStartIcon = (file: File | undefined) => {
		if (!file) return;
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			const c = document.createElement("canvas");
			c.width = c.height = 128;
			const g = c.getContext("2d");
			if (g) {
				// Centre-crop to a circle, so the picked image is always round.
				const k = Math.max(128 / img.width, 128 / img.height);
				const w = img.width * k, h = img.height * k;
				g.beginPath();
				g.arc(64, 64, 64, 0, Math.PI * 2);
				g.clip();
				g.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
				const data = c.toDataURL("image/png");
				setCustomIcon(data);
				setIconKind("custom");
				invoke("save_setting", { key: "bloom-sidebar-icon-custom", value: data }).catch(() => {});
				invoke("save_setting", { key: "bloom-sidebar-icon", value: "custom" }).catch(() => {});
			}
			URL.revokeObjectURL(url);
		};
		img.onerror = () => URL.revokeObjectURL(url);
		img.src = url;
	};

	const [volH, setVolH] = useState(POPUP_H.volume);
	// True from the moment a popup opens until its exit animation has finished: the bar window stays wide
	// (and the bar on screen) that long, so the exit is not cut off.
	const [widened, setWidened] = useState(false);
	const popupRef = useRef<typeof popup>(null);
	const pinned = useRef(false);
	const leaveTimer = useRef<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	// Theme + settings
	useEffect(() => {
		try {
			(initTheme as any)?.();
		} catch {}
		invoke<Record<string, any>>("load_settings")
			.then((s) => {
				if (s["bloom-sidebar-mode"]) setMode(String(s["bloom-sidebar-mode"]));
				if (s["bloom-sidebar-side"]) setSide(s["bloom-sidebar-side"] === "right" ? "right" : "left");
				if (s["bloom-sidebar-icon"]) setIconKind(String(s["bloom-sidebar-icon"]));
				if (s["bloom-sidebar-icon-custom"]) setCustomIcon(String(s["bloom-sidebar-icon-custom"]));
				setStartOp(parseOpacity(s["bloom-sidebar-icon-opacity"]));
				setShowWs(String(s["bloom-sidebar-workspaces"]) === "true");
				setPins(parsePins(s["bloom-sidebar-pins"]));
			})
			.catch(() => {});
		const un = listen<{ key: string; value: any }>("settings-changed", (e) => {
			if (e.payload.key === "bloom-sidebar-mode") setMode(String(e.payload.value));
			if (e.payload.key === "bloom-sidebar-side") setSide(e.payload.value === "right" ? "right" : "left");
			if (e.payload.key === "bloom-sidebar-icon") setIconKind(String(e.payload.value || "bloom"));
			if (e.payload.key === "bloom-sidebar-icon-custom") setCustomIcon(e.payload.value ? String(e.payload.value) : null);
			if (e.payload.key === "bloom-sidebar-icon-opacity") setStartOp(parseOpacity(e.payload.value));
			if (e.payload.key === "bloom-sidebar-workspaces") setShowWs(String(e.payload.value) === "true");
			if (e.payload.key === "bloom-sidebar-pins") setPins(parsePins(e.payload.value));
		});
		return () => {
			un.then((f) => f());
		};
	}, []);

	// Text colour: picked in the Controls popup (or in the notch's Controls), saved like the theme settings.
	// The theme rewrites --bloom-text whenever it is applied, so the chosen colour is put back after each write.
	const [textColor, setTextColor] = useState<string>(() => {
		const saved = localStorage.getItem("bloom-text-color") || "auto";
		return HEX_RE.test(saved) ? saved.toLowerCase() : "auto";
	});
	const textColorRef = useRef(textColor);
	const textPersistTimer = useRef<number | undefined>(undefined);
	const persistTextColor = useCallback((value: string) => {
		localStorage.setItem("bloom-text-color", value);
		invoke("save_setting", { key: "bloom-text-color", value }).catch(() => {});
	}, []);
	const liveTextColor = useCallback(
		(hex: string) => {
			textColorRef.current = hex;
			setTextColor(hex);
			window.clearTimeout(textPersistTimer.current);
			textPersistTimer.current = window.setTimeout(() => persistTextColor(hex), 400);
		},
		[persistTextColor]
	);
	const repaintTheme = useCallback(() => {
		applyTheme(
			localStorage.getItem("bloom-theme-mode") || "dark",
			localStorage.getItem("bloom-theme-color") || "#007aff",
			parseFloat(localStorage.getItem("bloom-theme-opacity") || "0.80"),
			parseFloat(localStorage.getItem("bloom-theme-saturation") || "0.50"),
			parseFloat(localStorage.getItem("bloom-theme-brightness") || "0.15")
		);
	}, []);
	const resetTextColor = useCallback(() => {
		window.clearTimeout(textPersistTimer.current);
		textColorRef.current = "auto";
		setTextColor("auto");
		persistTextColor("auto");
		repaintTheme();
	}, [persistTextColor, repaintTheme]);
	useEffect(() => {
		const root = document.documentElement;
		const reapply = () => {
			const hex = textColorRef.current;
			if (!HEX_RE.test(hex)) return;
			const muted = textColorMuted(hex);
			if (
				root.style.getPropertyValue("--bloom-text").trim().toLowerCase() !== hex ||
				root.style.getPropertyValue("--bloom-text-muted").trim() !== muted
			) {
				root.style.setProperty("--bloom-text", hex);
				root.style.setProperty("--bloom-text-muted", muted);
			}
		};
		reapply();
		const observer = new MutationObserver(reapply);
		observer.observe(root, { attributes: true, attributeFilter: ["style"] });
		return () => observer.disconnect();
	}, [textColor]);
	// A colour picked in the notch's Controls (the other window) arrives as a settings event.
	useEffect(() => {
		invoke<Record<string, any>>("load_settings")
			.then((s) => {
				const v = String(s["bloom-text-color"] ?? "auto").toLowerCase();
				const next = HEX_RE.test(v) ? v : "auto";
				textColorRef.current = next;
				setTextColor(next);
			})
			.catch(() => {});
		const un = listen<{ key: string; value: any }>("settings-changed", (e) => {
			if (e.payload.key !== "bloom-text-color") return;
			const v = String(e.payload.value ?? "auto").toLowerCase();
			const next = HEX_RE.test(v) ? v : "auto";
			localStorage.setItem("bloom-text-color", next);
			textColorRef.current = next;
			setTextColor(next);
			if (next === "auto") repaintTheme();
		});
		return () => {
			un.then((f) => f());
		};
	}, [repaintTheme]);

	useEffect(() => {
		const a = listen<boolean>("sidebar-overlap", (e) => setOverlap(e.payload));
		const b = listen<string>("sidebar-mode", (e) => setMode(e.payload));
		const c = listen<string>("sidebar-side", (e) => setSide(e.payload === "right" ? "right" : "left"));
		return () => {
			[a, b, c].forEach((p) => p.then((f) => f()));
		};
	}, []);

	const fetchIcon = useCallback(async (a: AppInfo) => {
		const k = a.path;
		if (iconsRef.current[k]) return;
		try {
			const ic = await invoke<string | null>("get_app_icon", { path: a.path });
			if (ic) {
				iconsRef.current[k] = ic;
				setIcons({ ...iconsRef.current });
			}
		} catch {}
	}, []);

	// The icons of the pinned apps (a pinned app need not be running).
	useEffect(() => {
		pins.forEach((p) => fetchIcon({ ...p, is_running: false, icon: p.icon ?? null }));
	}, [pins, fetchIcon]);

	// Running apps only (no pinned apps on the bar).
	useEffect(() => {
		const poll = async () => {
			const seq = ++pollSeq.current;
			try {
				const r = await invoke<AppInfo[]>("get_active_windows");
				// An older answer must never overwrite a newer one.
				if (seq !== pollSeq.current) return;
				setRunning(r);
				setOrder((prev) => {
					const ids = r.map(keyOf);
					return [...prev.filter((id) => ids.includes(id)), ...ids.filter((id) => !prev.includes(id))];
				});
				r.forEach((a) => fetchIcon(a));
			} catch {}
		};
		poll();
		const un = listen("windows-changed", poll);
		const t = setInterval(poll, 10000);
		return () => {
			clearInterval(t);
			un.then((f) => f());
		};
	}, [fetchIcon]);

	useEffect(() => {
		const t = setInterval(() => setNow(new Date()), 15000);
		return () => clearInterval(t);
	}, []);

	// Timer: the main window sends its state whenever it changes, and again when asked (this window may open later).
	useEffect(() => {
		const un = listen<PomoSync>("pomo-state", (e) => {
			setPomoNow(Date.now());
			setPomo(e.payload);
		});
		emit("pomo-request").catch(() => {});
		return () => {
			un.then((f) => f());
		};
	}, []);
	useEffect(() => {
		if (!pomo?.active || !pomo.running) return;
		const t = setInterval(() => setPomoNow(Date.now()), 250);
		return () => clearInterval(t);
	}, [pomo?.active, pomo?.running]);

	// Media: the main window sends the now-playing state whenever it changes, and again when asked (this window may open later).
	const [media, setMedia] = useState<MediaSync | null>(null);
	const [mediaSlot, setMediaSlot] = useState<string | null>(null);
	useEffect(() => {
		const un = listen<MediaSync>("sb-media-state", (e) => setMedia(e.payload));
		emit("sb-media-request").catch(() => {});
		return () => {
			un.then((f) => f());
		};
	}, []);
	const mediaCmd = (cmd: "media_play_pause" | "media_next" | "media_previous") => {
		invoke(cmd).catch(() => {});
		// Show the new play state at once; the real one follows from the main window.
		if (cmd === "media_play_pause") setMedia((m) => (m ? { ...m, is_playing: !m.is_playing } : m));
	};

	// Wi-Fi / Bluetooth / volume state for the icons.
	const refreshWifi = useCallback(() => {
		invoke<WifiStatus>("get_wifi_status")
			.then(setWifi)
			.catch(() => {});
	}, []);
	const refreshBt = useCallback(() => {
		invoke<boolean>("get_bluetooth_state")
			.then(setBt)
			.catch(() => {});
	}, []);
	useEffect(() => {
		refreshWifi();
		refreshBt();
		invoke<{ volume: number; is_muted: boolean }>("get_volume_state")
			.then((s) => setVol({ volume: s.volume, muted: s.is_muted }))
			.catch(() => {});
		const a = listen("wifi-changed", refreshWifi);
		const b = listen("bluetooth-changed", refreshBt);
		const c = listen<{ volume: number; is_muted: boolean }>("volume-change", (e) =>
			setVol({ volume: e.payload.volume, muted: e.payload.is_muted })
		);
		const t = setInterval(() => {
			refreshWifi();
			refreshBt();
		}, 10000);
		return () => {
			clearInterval(t);
			[a, b, c].forEach((p) => p.then((f) => f()));
		};
	}, [refreshWifi, refreshBt]);

	// Focus: the watcher in sidebar.rs emits "sidebar-focus" whenever the focused window changes.
	useEffect(() => {
		invoke<number>("sidebar_foreground_hwnd")
			.then(setFg)
			.catch(() => {});
		const un = listen<number>("sidebar-focus", (e) => setFg(e.payload));
		return () => {
			un.then((f) => f());
			if (trayTimer.current) window.clearInterval(trayTimer.current);
		};
	}, []);

	// Workspaces: sidebar-side komorebi.rs sends them whenever komorebi reports a change.
	useEffect(() => {
		invoke<WorkspaceInfo | null>("komorebi_workspaces")
			.then((w) => setWs(w ?? null))
			.catch(() => {});
		const un = listen<WorkspaceInfo | null>("komorebi-workspaces", (e) => setWs(e.payload ?? null));
		invoke<WorkspaceInfo | null>("komorebi_workspaces_2")
			.then((w) => setWs2(w ?? null))
			.catch(() => {});
		const un2 = listen<WorkspaceInfo | null>("komorebi-workspaces-2", (e) => setWs2(e.payload ?? null));
		return () => {
			un.then((f) => f());
			un2.then((f) => f());
		};
	}, []);

	// Pinned apps are not shown. Running apps keep the place they first appeared in.
	const items = useMemo(
		() =>
			order
				.map((id) => running.find((a) => keyOf(a) === id))
				.filter((a): a is AppInfo => !!a),
		[order, running]
	);

	// komorebi workspaces. With the workspaces setting on, the app icons are grouped by the workspace their windows
	// are in: a group (rounded, the focused workspace's stronger) around the icons of each workspace that has
	// windows, a dot for each empty one. Apps komorebi does not manage come last, ungrouped.
	const wsCount = ws?.occupied.length ?? 0;
	const wsOn = showWs && wsCount > 1;
	const wsActive = Math.max(0, Math.min(ws?.active ?? 0, wsCount - 1));
	const wsMon = ws?.monitor ?? 0;
	const wsSig = ws ? `${ws.monitor}:${ws.active}:${ws.occupied.map((o) => (o ? 1 : 0)).join("")}` : "";
	// hwnds of each workspace (komorebic state, read by the backend); refreshed when windows or focus change.
	const [wsWins, setWsWins] = useState<number[][] | null>(null);
	useEffect(() => {
		if (!wsOn) {
			setWsWins(null);
			return;
		}
		let dead = false;
		let t: number | undefined;
		const pull = () =>
			invoke<number[][] | null>("sidebar_workspace_windows", { monitor: wsMon })
				.then((r) => {
					if (!dead) setWsWins(r ?? null);
				})
				.catch(() => {});
		const soon = () => {
			window.clearTimeout(t);
			t = window.setTimeout(pull, 180);
		};
		pull();
		const a = listen("windows-changed", soon);
		const b = listen<number>("sidebar-focus", soon);
		const iv = setInterval(pull, 10000);
		return () => {
			dead = true;
			window.clearTimeout(t);
			clearInterval(iv);
			a.then((f) => f());
			b.then((f) => f());
		};
	}, [wsOn, wsMon, wsSig]);
	// The second monitor: its workspaces get a second list in the bar, above the tray. Its windows are taken out
	// of the first list, so no icon shows twice.
	const ws2Count = ws2?.occupied.length ?? 0;
	const ws2On = showWs && ws2Count > 0;
	const ws2Active = Math.max(0, Math.min(ws2?.active ?? 0, ws2Count - 1));
	const ws2Mon = ws2?.monitor ?? 1;
	const ws2Sig = ws2 ? `${ws2.monitor}:${ws2.active}:${ws2.occupied.map((o) => (o ? 1 : 0)).join("")}` : "";
	const wsWins2 = useWorkspaceWindows(ws2On, ws2Mon, ws2Sig);
	// komorebi drops a minimized window from its workspaces, so it used to fall to the bottom of the first list,
	// whatever monitor it was on. The workspace each window was last seen in is remembered, and a minimized window
	// is put back into that group (dimmed) until it is restored.
	const seen = useRef<Map<number, { side: 1 | 2; idx: number }>>(new Map());
	const alive = useMemo(() => {
		const s = new Set<number>();
		for (const a of items) {
			if (a.hwnd) s.add(a.hwnd);
			a.all_hwnds?.forEach(([h]) => s.add(h));
		}
		return s;
	}, [items]);
	const [effWins, effWins2, ghosts] = useMemo(() => {
		const now = new Set<number>([...(wsWins ?? []).flat(), ...(wsWins2 ?? []).flat()]);
		const ghost = new Set<number>();
		const put = (wins: number[][] | null, side: 1 | 2, count: number) => {
			if (!wins) return null;
			const out = Array.from({ length: Math.max(count, wins.length) }, (_, i) => [...(wins[i] ?? [])]);
			for (const [h, p] of seen.current) {
				if (p.side !== side || p.idx >= out.length || now.has(h) || !alive.has(h)) continue;
				out[p.idx].push(h);
				ghost.add(h);
			}
			// Windows that were just dropped on a workspace: take them out of wherever they were and put them there.
			if (moves.size) {
				const mon = side === 1 ? wsMon : ws2Mon;
				for (const [h, m] of moves) {
					for (const l of out) {
						const k = l.indexOf(h);
						if (k >= 0) l.splice(k, 1);
					}
					if (m.mon === mon && m.idx < out.length) out[m.idx].push(h);
				}
			}
			return out;
		};
		return [put(wsWins, 1, wsCount), put(wsWins2, 2, ws2Count), ghost] as const;
	}, [wsWins, wsWins2, wsCount, ws2Count, alive, moves, wsMon, ws2Mon]);
	// komorebi now has the window where it was dropped: the real list takes over from the temporary one.
	useEffect(() => {
		if (!moves.size) return;
		const done = [...moves].filter(([h, m]) => {
			const wins = m.mon === wsMon ? wsWins : m.mon === ws2Mon ? wsWins2 : null;
			return !!wins && (wins[m.idx] ?? []).includes(h);
		});
		if (!done.length) return;
		setMoves((prev) => {
			const n = new Map(prev);
			done.forEach(([h]) => n.delete(h));
			return n;
		});
	}, [moves, wsWins, wsWins2, wsMon, ws2Mon]);
	// Remember where each window is now (this runs after the render that used the earlier memory).
	useEffect(() => {
		for (const [side, wins] of [[1, wsWins], [2, wsWins2]] as const) {
			wins?.forEach((l, idx) => l.forEach((h) => seen.current.set(h, { side, idx })));
		}
		if (alive.size) for (const h of [...seen.current.keys()]) if (!alive.has(h)) seen.current.delete(h);
	}, [wsWins, wsWins2, alive]);
	const items1 = useMemo(() => {
		if (!ws2On || !effWins2) return items;
		const there = new Set(effWins2.flat());
		const out: AppInfo[] = [];
		for (const a of items) {
			const all = a.all_hwnds ?? (a.hwnd ? [[a.hwnd, a.name] as [number, string]] : []);
			const rest = all.filter(([h]) => !there.has(h));
			if (all.length && !rest.length) continue;
			out.push(
				rest.length === all.length
					? a
					: { ...a, hwnd: rest.some(([h]) => h === a.hwnd) ? a.hwnd : rest[0][0], all_hwnds: rest }
			);
		}
		return out;
	}, [ws2On, effWins2, items]);
	const groups = useMemo(() => {
		if (!wsOn || !effWins) return null;
		const placed = new Set<number>();
		const g: ViewApp[][] = Array.from({ length: wsCount }, (_, i) => {
			const mine = new Set(effWins[i] ?? []);
			const apps: ViewApp[] = [];
			for (const a of items1) {
				const wins = (a.all_hwnds ?? (a.hwnd ? [[a.hwnd, a.name] as [number, string]] : [])).filter(([h]) =>
					mine.has(h)
				);
				if (!wins.length) continue;
				wins.forEach(([h]) => placed.add(h));
				apps.push({
					...a,
					vkey: `${keyOf(a)}#${i}`,
					hwnd: wins.some(([h]) => h === a.hwnd) ? a.hwnd : wins[0][0],
					all_hwnds: wins,
					min: wins.every(([h]) => ghosts.has(h))
				});
			}
			return apps;
		});
		// An app with some windows in a workspace and others komorebi does not manage still gets a button for the
		// others here; it used to lose them (they could not be picked at all).
		const loose: ViewApp[] = [];
		for (const a of items1) {
			const all = a.all_hwnds ?? (a.hwnd ? [[a.hwnd, a.name] as [number, string]] : []);
			const rest = all.filter(([h]) => !placed.has(h));
			if (all.length && !rest.length) continue;
			loose.push(
				rest.length === all.length
					? { ...a, vkey: keyOf(a) }
					: { ...a, vkey: keyOf(a), hwnd: rest.some(([h]) => h === a.hwnd) ? a.hwnd : rest[0][0], all_hwnds: rest }
			);
		}
		return { g, loose };
	}, [wsOn, effWins, ghosts, wsCount, items1]);
	const viewApps: ViewApp[] = useMemo(
		() => (groups ? [...groups.g.flat(), ...groups.loose] : items1.map((a) => ({ ...a, vkey: keyOf(a) }))),
		[groups, items1]
	);
	// What changes where the buttons are: the focus highlight measures them again when this changes.
	const layoutSig = groups ? `${groups.g.map((x) => x.length).join(",")}|${groups.loose.length}` : "flat";

	// The app that owns the focused window (none when focus is on the desktop, Bloom or the taskbar).
	const focusedKey = useMemo(() => {
		if (!fg) return null;
		const a = viewApps.find((x) => x.hwnd === fg || x.all_hwnds?.some(([h]) => h === fg));
		return a ? a.vkey : null;
	}, [viewApps, fg]);

	// The focus highlight. It is one element that lives in the app list and follows the focused button,
	// by animating its top and bottom edges separately (that is what makes it stretch).
	const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
	const dropTop = useMotionValue(0);
	const dropBot = useMotionValue(0);
	const dropOpacity = useMotionValue(0);
	const dropX = useMotionValue(0);
	const dropY = useTransform(dropTop, (t: number) => t + DOT_INSET);
	const dropHeight = useTransform([dropTop, dropBot], ([t, b]: number[]) => Math.max(0, b - t - 2 * DOT_INSET));
	// Thins a little while it is stretched, like a drop pulling away.
	const dropScaleX = useTransform(
		[dropTop, dropBot],
		([t, b]: number[]) => 1 - Math.min(0.22, Math.max(0, b - t - (BTN + 2 * PAD)) / 450)
	);
	const dropShown = useRef(false);
	useLayoutEffect(() => {
		const el = focusedKey ? btnRefs.current[focusedKey] : null;
		if (!el) {
			if (dropShown.current) {
				dropShown.current = false;
				animate(dropOpacity, 0, { duration: 0.18 });
			}
			return;
		}
		dropX.set(el.offsetLeft + DOT_X);
		// The pill is a little taller than the button, so it reads as a pill and not a circle.
		const t = el.offsetTop - PAD;
		const b = el.offsetTop + el.offsetHeight + PAD;
		if (!dropShown.current) {
			// First focus (or back from none): appear in place.
			dropShown.current = true;
			dropTop.set(t);
			dropBot.set(b);
			animate(dropOpacity, 1, { duration: 0.12 });
			return;
		}
		const down = b > dropBot.get();
		animate(dropTop, t, down ? DROP_TRAIL : DROP_LEAD);
		animate(dropBot, b, down ? DROP_LEAD : DROP_TRAIL);
	}, [focusedKey, viewApps.length, layoutSig]); // eslint-disable-line react-hooks/exhaustive-deps

	// The second list: the apps of each workspace of the second monitor.
	const groups2 = useMemo(() => {
		if (!ws2On || !effWins2) return null;
		return Array.from({ length: ws2Count }, (_, i) => {
			const mine = new Set(effWins2[i] ?? []);
			const apps: ViewApp[] = [];
			for (const a of items) {
				const wins = (a.all_hwnds ?? (a.hwnd ? [[a.hwnd, a.name] as [number, string]] : [])).filter(([h]) =>
					mine.has(h)
				);
				if (!wins.length) continue;
				apps.push({
					...a,
					vkey: `${keyOf(a)}@2#${i}`,
					hwnd: wins.some(([h]) => h === a.hwnd) ? a.hwnd : wins[0][0],
					all_hwnds: wins,
					min: wins.every(([h]) => ghosts.has(h))
				});
			}
			return apps;
		});
	}, [ws2On, effWins2, ghosts, ws2Count, items]);
	const viewApps2: ViewApp[] = useMemo(() => (groups2 ? groups2.flat() : []), [groups2]);
	const focusedKey2 = useMemo(() => {
		if (!fg) return null;
		const a = viewApps2.find((x) => x.hwnd === fg || x.all_hwnds?.some(([h]) => h === fg));
		return a ? a.vkey : null;
	}, [viewApps2, fg]);
	// Its focus highlight sits behind the focused button and glides to the next one (CSS transition).
	const layoutSig2 = groups2 ? groups2.map((x) => x.length).join(",") : "off";
	const [pill2, setPill2] = useState<{ top: number; height: number; left: number } | null>(null);
	// The second list sits at the bottom of its room, so its buttons move when the room's height changes.
	const apps2Ref = useRef<HTMLDivElement>(null);
	const apps1Ref = useRef<HTMLDivElement>(null);
	const [room2, setRoom2] = useState(0);
	useLayoutEffect(() => {
		const el = apps2Ref.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setRoom2(el.clientHeight));
		ro.observe(el);
		return () => ro.disconnect();
	}, [!!groups2]); // eslint-disable-line react-hooks/exhaustive-deps
	useLayoutEffect(() => {
		const el = focusedKey2 ? btnRefs.current[focusedKey2] : null;
		setPill2(el ? { top: el.offsetTop - PAD, height: el.offsetHeight + 2 * PAD, left: el.offsetLeft + DOT_X } : null);
	}, [focusedKey2, layoutSig2, room2]);
	// A list that scrolls keeps the focused workspace in view (also after Shift + scroll steps to it).
	const keepActiveInView = (list: HTMLDivElement | null) => {
		const g = list?.querySelector<HTMLElement>(".sb-wsg.active, .sb-wsdot.active");
		if (!list || !g) return;
		const top = g.offsetTop - 2;
		const bottom = g.offsetTop + g.offsetHeight + 2;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
	};
	useLayoutEffect(() => keepActiveInView(apps2Ref.current), [ws2Active, layoutSig2, room2]); // eslint-disable-line react-hooks/exhaustive-deps
	useLayoutEffect(() => keepActiveInView(apps1Ref.current), [wsActive, layoutSig]); // eslint-disable-line react-hooks/exhaustive-deps

	const focusWorkspace = (i: number, monitor = wsMon) => {
		invoke("komorebi_focus_workspace", { monitor, index: i }).catch(() => {});
	};
	// Shift + scroll over a workspace list steps through the workspaces (like YASB's komorebi widget); a plain scroll
	// scrolls the list itself. (With Shift held the wheel can report its amount as deltaX, so both are read.)
	const wsWheelAt = useRef(0);
	const onAppsWheel = (e: WheelEvent<HTMLDivElement>) => {
		const d = e.deltaY || e.deltaX;
		if (!wsOn || !e.shiftKey || d === 0) return;
		const now = performance.now();
		if (now - wsWheelAt.current < 140) return;
		wsWheelAt.current = now;
		const next = Math.max(0, Math.min(wsCount - 1, wsActive + (d > 0 ? 1 : -1)));
		if (next !== wsActive) focusWorkspace(next);
	};
	const onApps2Wheel = (e: WheelEvent<HTMLDivElement>) => {
		const d = e.deltaY || e.deltaX;
		if (!ws2On || !e.shiftKey || d === 0) return;
		const now = performance.now();
		if (now - wsWheelAt.current < 140) return;
		wsWheelAt.current = now;
		const next = Math.max(0, Math.min(ws2Count - 1, ws2Active + (d > 0 ? 1 : -1)));
		if (next !== ws2Active) focusWorkspace(next, ws2Mon);
	};

	// komorebi hides the windows of the workspaces that are not showing, and a hidden window cannot take focus.
	// komorebi_reveal_window switches to the window's workspace and waits until the window is back on screen.
	const reveal = (h: number, monitor?: number, index?: number) =>
		invoke<boolean>("komorebi_reveal_window", { hwnd: h, monitor, index }).catch(() => false);
	// Focuses one window, from any workspace; a window that is already in front is minimized instead, like the
	// taskbar. (focus_window also minimizes when another window of the same app is in front, so it is not used here.)
	// Whether it is in front is read before komorebi switches workspaces, because the switch can focus it.
	const focusHwnd = async (h: number, toggle = true) => {
		const front = toggle ? await invoke<number>("sidebar_foreground_hwnd").catch(() => fg) : 0;
		const wasFocused = toggle && front === h;
		// A minimized window is not in komorebi's state: it goes back to the workspace it was last seen in.
		const p = seen.current.get(h);
		await reveal(h, p ? (p.side === 2 ? ws2Mon : wsMon) : undefined, p?.idx);
		await invoke(wasFocused ? "minimize_window" : "focus_window_exact", { hwnd: h }).catch(() => {});
	};

	// An app with one window focuses it. An app with several opens the window picker (pick one, with its
	// picture); Shift+click brings all of them forward, as a click used to.
	const click = async (a: ViewApp, e: ReactMouseEvent<HTMLButtonElement>, wsIdx?: number, second?: boolean) => {
		const el = e.currentTarget;
		try {
			// An app in another workspace: go there first, then bring the window up.
			const first = a.all_hwnds?.[0]?.[0] ?? a.hwnd;
			const other = !!first && wsIdx != null && wsIdx !== (second ? ws2Active : wsActive);
			if (first && other && wsIdx != null && !(await reveal(first, second ? ws2Mon : wsMon, wsIdx))) {
				// komorebi_reveal_window could not do it: switch the old way and give komorebi a moment.
				focusWorkspace(wsIdx, second ? ws2Mon : wsMon);
				await new Promise((r) => setTimeout(r, 160));
			}
			if (a.all_hwnds && a.all_hwnds.length > 1) {
				if (e.shiftKey) await invoke("focus_app_windows", { hwnds: a.all_hwnds.map(([h]) => h) });
				else openPopup("windows", el, a.vkey);
			} else if (a.hwnd) {
				// Switching workspaces can focus the window by itself, so it would look "already in front" and get minimized:
				// coming from another workspace the click only focuses (no minimize toggle).
				await focusHwnd(a.hwnd, !other);
			} else {
				await invoke("open_app", { appName: a.path });
			}
		} catch (e) {
			console.error(e);
		}
	};

	// The pinned apps with all of their windows, from any workspace or monitor (minimized ones too).
	const pinViews: ViewApp[] = useMemo(
		() =>
			pins.map((p) => {
				const k = keyOf(p);
				const wins: [number, string][] = [];
				for (const a of items) {
					if (keyOf(a) !== k) continue;
					for (const w of a.all_hwnds ?? (a.hwnd ? [[a.hwnd, a.name] as [number, string]] : [])) wins.push(w);
				}
				return { ...p, icon: p.icon ?? null, is_running: wins.length > 0, hwnd: wins[0]?.[0], all_hwnds: wins, vkey: `pin:${k}` };
			}),
		[pins, items]
	);
	// The top block (Bloom button, pinned apps, divider) is made exactly as long as the bottom block (divider, tray,
	// clock). The pinned apps sit at the bottom of it, right above their divider like the tray under its own; any room
	// left over goes between the Bloom button and the pinned apps. (The bar's padding is 3px on top and 10px below;
	// the 7px difference is given back in .sb-apps in Sidebar.css so the media space stays centred.)
	const barRef = useRef<HTMLDivElement>(null);
	const sepRef = useRef<HTMLDivElement>(null);
	const trayRef = useRef<HTMLDivElement>(null);
	const clockRef = useRef<HTMLDivElement>(null);
	const [topH, setTopH] = useState(0);
	// The pinned strip only ever shows whole icons: its height is rounded down to a whole number of rows, so no
	// icon is cut off at its bottom edge (the leftover is empty space above the divider).
	const pinsRoomRef = useRef<HTMLDivElement>(null);
	const [pinsMax, setPinsMax] = useState(0);
	const hasPins = pinViews.length > 0;
	useLayoutEffect(() => {
		const el = pinsRoomRef.current;
		if (!el) return;
		const PIN_ROW = 44; // button 36 + gap 8; one row of the strip with its 4px padding is exactly this tall (keep equal to .sb-pins in Sidebar.css)
		const measure = () => setPinsMax(Math.max(PIN_ROW, Math.floor(el.clientHeight / PIN_ROW) * PIN_ROW));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [hasPins]);
	useLayoutEffect(() => {
		const bar = barRef.current;
		const s = sepRef.current;
		const c = clockRef.current;
		if (!bar || !s || !c) return;
		const measure = () => {
			setTopH(Math.max(0, Math.round(c.offsetTop + c.offsetHeight - s.offsetTop)));
		};
		measure();
		const ro = new ResizeObserver(measure);
		[bar, s, c].forEach((el) => ro.observe(el));
		if (trayRef.current) ro.observe(trayRef.current);
		return () => ro.disconnect();
	}, []);

	// Pin / unpin from the right-click menu.
	const togglePin = (a: PinApp) => {
		const k = keyOf(a);
		const next = pins.some((p) => keyOf(p) === k)
			? pins.filter((p) => keyOf(p) !== k)
			: [...pins, { name: a.name, path: a.path, executable: a.executable, icon: icons[a.path] ?? a.icon ?? null }];
		setPins(next);
		invoke("save_setting", { key: "bloom-sidebar-pins", value: JSON.stringify(next) }).catch(() => {});
		closePopup();
	};
	// A pinned app only opens: with windows already open a press goes to one of them (the picker when there are
	// several, even on another workspace or monitor), otherwise it launches. The app itself is on the workspace lists.
	const pinClick = async (p: ViewApp, e: ReactMouseEvent<HTMLButtonElement>) => {
		const el = e.currentTarget;
		try {
			const wins = p.all_hwnds ?? [];
			if (wins.length > 1) openPopup("windows", el, p.vkey);
			else if (wins.length === 1) await focusHwnd(wins[0][0], false);
			else await invoke("open_app", { appName: p.path });
		} catch (err) {
			console.error(err);
		}
	};

	// ---- drag and drop. Pointer events, not HTML5 drag and drop: Tauri's own file-drop handler swallows the webview's
	// dragstart/drop events on Windows. Two things can be dragged:
	//  - an app button inside a workspace group, onto another workspace (a group or an empty dot, on either monitor):
	//    all of that button's windows are sent there (komorebi_move_windows);
	//  - a pinned app, inside the pinned strip: it drops between two icons and the order is saved.
	type DropAt = { ws: string | null; pinAt: number | null };
	// The ghost follows the pointer through a ref and a transform, not through state: re-rendering the whole bar on
	// every pointer move made the drag choppy. The state only changes when the target under the pointer changes.
	const dragPos = useRef({ x: 0, y: 0 });
	const ghostRef = useRef<HTMLDivElement>(null);
	const ghostAt = (x: number, y: number) => `translate3d(${x - 18}px, ${y - 18}px, 0) scale(1.12)`;
	const [drag, setDrag] = useState<
		({ x: number; y: number; kind: "app" | "pin"; src: string; img: string | null; G: Glyph | null; letter: string } & DropAt) | null
	>(null);
	useEffect(() => {
		document.body.classList.toggle("sb-dragging", !!drag);
		return () => document.body.classList.remove("sb-dragging");
	}, [!!drag]); // eslint-disable-line react-hooks/exhaustive-deps

	const dragTarget = (x: number, y: number, kind: "app" | "pin"): DropAt => {
		if (kind === "app") {
			const el = document.elementFromPoint(x, y) as HTMLElement | null;
			return { ws: el?.closest<HTMLElement>("[data-ws]")?.dataset.ws ?? null, pinAt: null };
		}
		const strip = document.querySelector<HTMLElement>(".sb-pins");
		if (!strip) return { ws: null, pinAt: null };
		const r = strip.getBoundingClientRect();
		if (x < r.left - 12 || x > r.right + 12 || y < r.top - 12 || y > r.bottom + 12) return { ws: null, pinAt: null };
		// The drop goes before the first icon whose middle is below the pointer (after the last one otherwise).
		const btns = Array.from(strip.querySelectorAll<HTMLElement>(".sb-pin"));
		let at = btns.length;
		for (let i = 0; i < btns.length; i++) {
			const b = btns[i].getBoundingClientRect();
			if (y < b.top + b.height / 2) {
				at = i;
				break;
			}
		}
		return { ws: null, pinAt: at };
	};

	// Starts on pointer down; nothing happens until the pointer has moved a few pixels, so plain clicks still click.
	const beginDrag = (e: ReactPointerEvent<HTMLElement>, kind: "app" | "pin", a: ViewApp, onDrop: (t: DropAt) => void) => {
		if (e.button !== 0) return;
		const el = e.currentTarget;
		const pid = e.pointerId;
		const sx = e.clientX;
		const sy = e.clientY;
		const img = icons[a.path] ?? a.icon ?? null;
		const G = glyphFor(a);
		let on = false;
		let raf = 0;
		// Moves the ghost (no render) and only updates the state when the target under the pointer is another one.
		const follow = () => {
			const { x, y } = dragPos.current;
			if (ghostRef.current) ghostRef.current.style.transform = ghostAt(x, y);
			const t = dragTarget(x, y, kind);
			setDrag((prev) =>
				prev && prev.src === a.vkey && prev.ws === t.ws && prev.pinAt === t.pinAt
					? prev
					: { x, y, kind, src: a.vkey, img, G, letter: a.name?.[0] ?? "", ...t }
			);
		};
		// A pinned strip that scrolls follows the pointer when it is near its top or bottom edge. It keeps scrolling
		// every frame while the pointer is held there, even when the pointer itself is not moving.
		const autoscroll = () => {
			raf = 0;
			if (!on || kind !== "pin") return;
			const strip = document.querySelector<HTMLElement>(".sb-pins");
			const r = strip?.getBoundingClientRect();
			if (!strip || !r) return;
			const y = dragPos.current.y;
			const speed = y < r.top + 18 ? -6 : y > r.bottom - 18 ? 6 : 0;
			if (!speed) return;
			strip.scrollTop += speed;
			follow();
			raf = requestAnimationFrame(autoscroll);
		};
		const move = (ev: PointerEvent) => {
			if (!on) {
				if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
				on = true;
				closePopup();
				try {
					el.setPointerCapture(pid); // keep getting the pointer if it leaves the bar
				} catch {}
			}
			dragPos.current = { x: ev.clientX, y: ev.clientY };
			follow();
			if (kind === "pin" && !raf) raf = requestAnimationFrame(autoscroll);
		};
		const end = (ev: PointerEvent) => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
			if (raf) cancelAnimationFrame(raf);
			if (!on) return;
			try {
				el.releasePointerCapture(pid);
			} catch {}
			// The click that follows the release must not focus, open or unpin anything.
			const swallow = (c: Event) => {
				c.stopPropagation();
				c.preventDefault();
			};
			window.addEventListener("click", swallow, { capture: true, once: true });
			setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 60);
			setDrag(null);
			if (ev.type === "pointerup") onDrop(dragTarget(ev.clientX, ev.clientY, kind));
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
	};

	// Dropped on a workspace: send the button's windows there. `from` is the workspace the button was in.
	const dropApp = (a: ViewApp, from: string, t: DropAt) => {
		if (!t.ws || t.ws === from) return;
		const [m, i] = t.ws.split(":").map(Number);
		const hwnds = (a.all_hwnds ?? (a.hwnd ? [[a.hwnd, a.name] as [number, string]] : [])).map(([h]) => h);
		if (!hwnds.length || Number.isNaN(m) || Number.isNaN(i)) return;
		// Show the move now: the icon slides to its new workspace while komorebi is still doing it.
		setMoves((prev) => {
			const n = new Map(prev);
			hwnds.forEach((h) => n.set(h, { mon: m, idx: i }));
			return n;
		});
		const undo = () =>
			setMoves((prev) => {
				const n = new Map(prev);
				hwnds.forEach((h) => n.delete(h));
				return n;
			});
		setWsLock({ ws, ws2 });
		window.clearTimeout(wsLockTimer.current);
		invoke("komorebi_move_windows", { hwnds, monitor: m, index: i })
			.catch(undo) // it failed: put the icon back
			.finally(() => {
				window.clearTimeout(wsLockTimer.current);
				wsLockTimer.current = window.setTimeout(() => setWsLock(null), 350);
			});
		// Safety net: if komorebi never reports the window there, stop showing it there.
		window.setTimeout(undo, 4000);
	};
	// Dropped in the pinned strip: move pin `from` to the gap `at` (0 = before the first icon, pins.length = after the last).
	const dropPin = (from: number, t: DropAt) => {
		if (t.pinAt == null) return;
		const to = t.pinAt > from ? t.pinAt - 1 : t.pinAt;
		if (to === from) return;
		const next = [...pins];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setPins(next);
		invoke("save_setting", { key: "bloom-sidebar-pins", value: JSON.stringify(next) }).catch(() => {});
	};

	// ---- slide animation. When an app lands in another workspace (or an icon is opened, closed, pinned or reordered), every
	// icon whose place changed slides from its old place to its new one: measure before and after (FLIP) and play the
	// difference with the Web Animations API. Places are measured relative to the bar, so the bar sliding out of view or
	// changing width does not count as a move. An icon that is new pops in.
	const flipPos = useRef<Map<string, { x: number; y: number }>>(new Map());
	const flipSnap = useCallback((animateChanges: boolean) => {
		const bar = barRef.current;
		if (!bar) return;
		const b = bar.getBoundingClientRect();
		const calm = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const next = new Map<string, { x: number; y: number }>();
		bar.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
			const id = el.dataset.flip as string;
			const r = el.getBoundingClientRect();
			const p = { x: r.left - b.left, y: r.top - b.top };
			next.set(id, p);
			if (!animateChanges || calm) return;
			const old = flipPos.current.get(id);
			if (!old) {
				if (flipPos.current.size) {
					el.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }], {
						duration: 240,
						easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
					});
				}
				return;
			}
			const dx = old.x - p.x;
			const dy = old.y - p.y;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
			el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(1.12)` }, { transform: "none" }], {
				duration: 340,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
			});
		});
		flipPos.current = next;
	}, []);
	const flipSig = [...viewApps, ...viewApps2].map((a) => `${a.vkey}:${a.hwnd ?? 0}`).join(",") + "|" + pins.map(keyOf).join(",");
	useLayoutEffect(() => flipSnap(true), [flipSig, layoutSig, layoutSig2]); // eslint-disable-line react-hooks/exhaustive-deps

	// fixed: always shown. smart: hidden while a window overlaps (hover reveals).
	// peek: hidden until hovered. An open popup keeps the bar on screen.
	const hidden = popup || widened
		? false
		: mode === "peek"
			? !hovered
			: mode === "smart"
				? overlap && !hovered
				: false;

	useEffect(() => {
		invoke("sidebar_set_collapsed", { collapsed: hidden }).catch(() => {});
	}, [hidden]);

	// One app button (with its windows' workspace index when the list is grouped).
	const appButton = (a: ViewApp, wsIdx?: number, second?: boolean) => (
			<button
				key={a.vkey}
				ref={(el) => {
					btnRefs.current[a.vkey] = el;
				}}
				className={`sb-btn live ${focusedKey === a.vkey || focusedKey2 === a.vkey ? "focused" : ""} ${a.min ? "min" : ""} ${drag?.src === a.vkey ? "dragging-src" : ""}`}
				onClick={(e) => click(a, e, wsIdx, second)}
				data-flip={a.hwnd ? `w${a.hwnd}` : a.vkey}
				onPointerDown={
					wsIdx != null
						? (e) => beginDrag(e, "app", a, (t) => dropApp(a, `${second ? ws2Mon : wsMon}:${wsIdx}`, t))
						: undefined
				}
				onContextMenu={(e) => {
					e.preventDefault();
					// An app with several windows gets the picker in close mode (pick which one to close);
					// an app with one window gets the small close menu.
					const multi = (a.all_hwnds?.length ?? 0) > 1;
					openPopup(multi ? "windows" : "appmenu", e.currentTarget, a.vkey, multi);
				}}
			>
				{(() => {
					const G = glyphFor(a);
					if (G) return <G size={18} strokeWidth={1.8} className="sb-glyph" />;
					return icons[a.path] ? <img src={icons[a.path]} alt="" draggable={false} /> : <span>{a.name?.[0]}</span>;
				})()}
				{(a.all_hwnds?.length ?? 0) > 1 && <span className="sb-count">{a.all_hwnds!.length}</span>}
			</button>
	);

	// ---- popup open / close. The bar window gets wider while one is open.
	const winApp =
		popup?.id === "windows"
			? (viewApps.find((x) => x.vkey === popup.appKey) ?? viewApps2.find((x) => x.vkey === popup.appKey) ?? pinViews.find((x) => x.vkey === popup.appKey))
			: undefined;
	const winList = (winApp?.all_hwnds ?? []).filter(([h]) => !closing.includes(h));
	const winRows = Math.max(1, Math.min(winList.length, WIN_MAX));
	// The right-click menu: the app it was opened on, its windows, and the one that gets closed.
	const menuApp =
		popup?.id === "appmenu"
			? (viewApps.find((x) => x.vkey === popup.appKey) ?? viewApps2.find((x) => x.vkey === popup.appKey) ?? pinViews.find((x) => x.vkey === popup.appKey))
			: undefined;
	const menuHwnds = menuApp ? (menuApp.all_hwnds?.map(([h]) => h) ?? (menuApp.hwnd ? [menuApp.hwnd] : [])) : [];
	const menuRows = (menuHwnds.length > 0 ? 1 : 0) + (menuHwnds.length > 1 ? 1 : 0) + 1; // close, close all, pin
	const isPinned = (a?: PinApp) => !!a && pins.some((p) => keyOf(p) === keyOf(a));
	const menuTarget = menuHwnds.includes(fg) ? fg : menuHwnds.includes(menuApp?.hwnd ?? -1) ? menuApp!.hwnd! : menuHwnds[0];
	const closeHwnds = (list: number[]) => {
		for (const h of list) invoke("sidebar_close_window", { hwnd: h }).catch(() => {});
		closePopup();
	};
	// Close one window of the picker and keep the picker open, so several can be closed one after another.
	const closeOne = (h: number) => {
		invoke("sidebar_close_window", { hwnd: h }).catch(() => {});
		setClosing((p) => (p.includes(h) ? p : [...p, h]));
		window.setTimeout(() => setClosing((p) => p.filter((x) => x !== h)), 2500);
	};
	const popupH = popup
		? popup.id === "volume"
			? volH
			: popup.id === "windows"
				? 2 * WIN_PAD + winRows * WIN_ROW + (winRows - 1) * WIN_GAP + (popup.close ? 2 * (WIN_GAP + MENU_ROW) : 0)
				: popup.id === "appmenu"
					? 2 * MENU_PAD + MENU_TITLE + menuRows * (MENU_ROW + MENU_GAP)
					: POPUP_H[popup.id]
		: 0;
	const popupW = popup ? POPUP_W[popup.id] : 0;
	popupRef.current = popup;

	const isOpen = !!popup;
	useEffect(() => {
		if (popup?.id !== "media") return;
		invoke<string | null>("get_media_slot")
			.then(setMediaSlot)
			.catch(() => {});
	}, [popup?.id]);
	const popupWinW = popup ? Math.max(POPUP_WIN_W, POPUP_W[popup.id] + 20) : 0;
	useEffect(() => {
		if (!isOpen) return;
		setWidened(true);
		invoke("sidebar_set_popup", { width: popupWinW }).catch(() => {});
	}, [isOpen, popupWinW]);

	// The power menu needs the window to cover the whole monitor (for the dim); every other popup does not.
	const powerOpen = popup?.id === "power";
	useEffect(() => {
		if (powerOpen) invoke("sidebar_set_overlay", { on: true }).catch(() => {});
		else if (popupRef.current) invoke("sidebar_set_overlay", { on: false }).catch(() => {});
	}, [powerOpen]);

	// Called when the last popup has finished animating out (not when one popup swaps for another).
	const onPopupExited = useCallback(() => {
		if (popupRef.current) return;
		setWidened(false);
		invoke("sidebar_set_overlay", { on: false }).catch(() => {});
		invoke("sidebar_set_popup", { width: 0 }).catch(() => {});
	}, []);

	const closePopup = useCallback(() => {
		pinned.current = false;
		setPopup(null);
	}, []);

	const openPopup = (id: PopupId, el: HTMLElement, appKey?: string, close?: boolean) => {
		if (popup?.id === id && popup.appKey === appKey && !!popup.close === !!close) {
			closePopup();
			return;
		}
		const r = el.getBoundingClientRect();
		setPopup({ id, iconY: r.top + r.height / 2, appKey, close });
	};

	// The menu closes by itself once its app is gone (that is what closing its last window does).
	useEffect(() => {
		if (popup?.id === "appmenu" && !menuApp) closePopup();
	}, [popup, menuApp, closePopup]);

	// Which windows of the open picker are minimized (marked in the list); asked again while it stays open.
	const [minWins, setMinWins] = useState<number[]>([]);
	const winIds = winList.map(([h]) => h).join(",");
	useEffect(() => {
		if (popup?.id !== "windows" || !winIds) return;
		let dead = false;
		const pull = () =>
			invoke<number[]>("minimized_windows", { hwnds: winIds.split(",").map(Number) })
				.then((r) => {
					if (!dead) setMinWins(r);
				})
				.catch(() => {});
		pull();
		const iv = setInterval(pull, 800);
		return () => {
			dead = true;
			clearInterval(iv);
		};
	}, [popup?.id, winIds]);

	// The picker closes by itself once the app is down to one window (or none). It waits a moment first: the
	// window list is briefly short while komorebi switches workspaces, and that used to shut the picker.
	useEffect(() => {
		if (popup?.id !== "windows" || winList.length >= 2) return;
		const t = window.setTimeout(closePopup, 350);
		return () => window.clearTimeout(t);
	}, [popup, winList.length, closePopup]);

	useEffect(() => {
		if (!popup) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePopup();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [popup, closePopup]);

	// Pointer leaves the whole sidebar page (bar + popup): close after a moment, unless the popup
	// is pinned (a password or pairing prompt is open).
	const onLeave = () => {
		setHovered(false);
		if (!popup) return;
		if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
		leaveTimer.current = window.setTimeout(() => {
			if (!pinned.current) closePopup();
		}, 450);
	};
	const onEnter = () => {
		setHovered(true);
		if (leaveTimer.current) {
			window.clearTimeout(leaveTimer.current);
			leaveTimer.current = null;
		}
	};

	// Popup position: centred on its icon, kept inside the screen.
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const top = popup
		? Math.max(POPUP_EDGE, Math.min(popup.iconY - popupH / 2, vh - popupH - POPUP_EDGE))
		: 0;
	const iconTop = popup ? popup.iconY - ICON / 2 : 0;
	// The power menu sits on the screen edge away from the bar, centred vertically.
	const far = side === "left" ? "right" : "left";
	const ovTop = Math.max(POPUP_MARGIN, (vh - OV_H) / 2);
	// The menu is attached to the far strip of the frame (peek has no frame), so it is as much wider as the strip is thick.
	const ovEdge = mode === "peek" ? 0 : OV_EDGE;
	const ovW = OV_W + ovEdge;

	const pomoSecs = pomo?.active
		? Math.max(0, Math.ceil((pomo.running ? pomo.endAt - pomoNow : pomo.remainingMs) / 1000))
		: 0;
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");

	const VolIcon = vol.muted || vol.volume === 0 ? VolumeX : vol.volume < 0.5 ? Volume1 : Volume2;

	// Opens the Windows tray popup beside the bar (or closes it), and follows its open state so the
	// button can show it. The popup takes a moment to appear, so "closed" is ignored until it has been seen.
	const toggleTray = (el: HTMLElement) => {
		closePopup();
		if (trayTimer.current) {
			window.clearInterval(trayTimer.current);
			trayTimer.current = null;
		}
		const r = el.getBoundingClientRect();
		const opening = !trayOpen;
		setTrayOpen(opening);
		invoke("sidebar_toggle_tray", { anchorY: r.top + r.height / 2 }).catch(() => {});
		if (!opening) return;
		let seen = false;
		const started = Date.now();
		trayTimer.current = window.setInterval(async () => {
			let open = false;
			try {
				open = await invoke<boolean>("sidebar_tray_is_open");
			} catch {}
			const done = seen ? !open : Date.now() - started > 3500;
			if (open) seen = true;
			if (done) {
				setTrayOpen(false);
				if (trayTimer.current) window.clearInterval(trayTimer.current);
				trayTimer.current = null;
			}
		}, 250);
	};

	const status = (
		id: PopupId,
		icon: ReactNode,
		_title: string,
		on: boolean
	): ReactNode => (
		<button
			className={`sb-btn sb-status ${on ? "on" : ""} ${popup?.id === id ? "open" : ""}`}
			onClick={(e) => openPopup(id, e.currentTarget)}
		>
			{icon}
		</button>
	);

	return (
		<div
			ref={rootRef}
			className={`sb-root ${side} m-${mode} ${hidden ? "hidden" : ""} ${popup ? "has-popup" : ""}`}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
		>
			<i className="sb-fillet top" />
			<i className="sb-fillet bottom" />
			<div
				className="sb-bar"
				ref={barRef}
			>
				<div className="sb-top" style={topH ? { height: topH } : undefined}>
				<button
					className="sb-btn sb-start"
					style={startOp != null ? ({ "--sb-start-op": startOp } as CSSProperties) : undefined}
					onClick={() => invoke("open_app", { appName: "bloom-settings" }).catch(() => {})}
					onContextMenu={(e) => {
						e.preventDefault();
						openPopup("power", e.currentTarget);
					}}
					onMouseDown={(e) => e.button === 1 && e.preventDefault()}
					onAuxClick={(e) => {
						if (e.button !== 1) return;
						e.preventDefault();
						iconInput.current?.click();
					}}
				>
					{iconKind === "recycle" ? (
						<RecycleIcon />
					) : iconKind === "eye" ? (
						<span className="sb-eye" aria-hidden="true" />
					) : (
						<img
							src={iconKind === "custom" && customIcon ? customIcon : "/bloom.png"}
							alt=""
							draggable={false}
						/>
					)}
				</button>
				<input
					ref={iconInput}
					type="file"
					accept="image/*"
					style={{ display: "none" }}
					onChange={(e) => {
						pickStartIcon(e.target.files?.[0]);
						e.target.value = "";
					}}
				/>
				{pinViews.length > 0 && (
					<div className="sb-pins-room" ref={pinsRoomRef}>
					<div className={`sb-pins ${drag?.kind === "pin" ? "dragging" : ""}`} style={pinsMax ? { maxHeight: pinsMax } : undefined} onScroll={() => flipSnap(false)}>
						{pinViews.map((p, pi) => (
							<button
								key={p.vkey}
								className={`sb-btn sb-pin ${drag?.src === p.vkey ? "dragging-src" : ""} ${drag?.kind === "pin" && drag.pinAt === pi ? "ins-before" : ""} ${drag?.kind === "pin" && drag.pinAt === pi + 1 && pi === pinViews.length - 1 ? "ins-after" : ""}`}
								onClick={(e) => pinClick(p, e)}
								data-flip={p.vkey}
								onPointerDown={(e) => beginDrag(e, "pin", p, (t) => dropPin(pi, t))}
								onContextMenu={(e) => {
									e.preventDefault();
									openPopup("appmenu", e.currentTarget, p.vkey);
								}}
							>
								{(() => {
									const G = glyphFor(p);
									if (G) return <G size={18} strokeWidth={1.8} className="sb-glyph" />;
									const src = icons[p.path] ?? p.icon;
									return src ? <img src={src} alt="" draggable={false} /> : <span>{p.name?.[0]}</span>;
								})()}
							</button>
						))}
					</div>
					</div>
				)}
				<div className="sb-sep" />
				</div>
				{drag &&
					createPortal(
						<div className="sb-drag-ghost" ref={ghostRef} style={{ transform: ghostAt(dragPos.current.x, dragPos.current.y) }}>
							{drag.G ? (
								<drag.G size={18} strokeWidth={1.8} />
							) : drag.img ? (
								<img src={drag.img} alt="" draggable={false} />
							) : (
								<span>{drag.letter}</span>
							)}
						</div>,
						document.body
					)}
				<div className="sb-apps" ref={apps1Ref} onWheel={onAppsWheel} onScroll={() => flipSnap(false)}>
					{/* The focus drop: a solid pywal-accent shape behind the focused app's icon. */}
					<motion.i
						className="sb-focus"
						style={{ top: dropY, left: dropX, height: dropHeight, scaleX: dropScaleX, opacity: dropOpacity }}
					/>
					{groups ? (
						<>
							{groups.g.map((apps, i) =>
								apps.length ? (
									<div
										key={`g${i}`}
										className={`sb-wsg ${i === wsActive ? "active" : ""} ${drag?.ws === `${wsMon}:${i}` ? "drop-over" : ""}`}
										data-ws={`${wsMon}:${i}`}
										onClick={(e) => e.target === e.currentTarget && focusWorkspace(i)}
									>
										{apps.map((a) => appButton(a, i))}
									</div>
								) : (
									<button
										key={`g${i}`}
										className={`sb-wsdot ${i === wsActive ? "active" : ""} ${drag?.ws === `${wsMon}:${i}` ? "drop-over" : ""}`}
										data-ws={`${wsMon}:${i}`}
										onClick={() => focusWorkspace(i)}
									>
										<i />
									</button>
								)
							)}
							{groups.loose.length > 0 && <div className="sb-wsg loose">{groups.loose.map((a) => appButton(a))}</div>}
						</>
					) : (
						viewApps.map((a) => appButton(a))
					)}
				</div>
				{/* The room between the two lists, kept free for the media widget (its height is --sb-media-h in Sidebar.css). Both lists get the same room, so this sits in the middle of the screen. */}
				<div className="sb-mid">
					<MediaWidget
						media={media}
						onOpen={(el) => openPopup("media", el)}
						onToggle={() => mediaCmd("media_play_pause")}
					/>
				</div>
				{!groups2 && <div className="sb-apps sb-apps2" aria-hidden="true" />}
				{groups2 && (
					<>
						{/* The second monitor's workspaces, above the volume and the rest of the tray. */}
						<div className="sb-apps sb-apps2" ref={apps2Ref} onWheel={onApps2Wheel} onScroll={() => flipSnap(false)}>
							<i
								className="sb-focus sb-focus-2"
								style={{ left: pill2?.left ?? 0, top: (pill2?.top ?? 0) + DOT_INSET, height: Math.max(0, (pill2?.height ?? 0) - 2 * DOT_INSET), opacity: pill2 ? 1 : 0 }}
							/>
							{groups2.map((apps, i) =>
								apps.length ? (
									<div
										key={`h${i}`}
										className={`sb-wsg ${i === ws2Active ? "active" : ""} ${drag?.ws === `${ws2Mon}:${i}` ? "drop-over" : ""}`}
										data-ws={`${ws2Mon}:${i}`}
										onClick={(e) => e.target === e.currentTarget && focusWorkspace(i, ws2Mon)}
									>
										{apps.map((a) => appButton(a, i, true))}
									</div>
								) : (
									<button
										key={`h${i}`}
										className={`sb-wsdot ${i === ws2Active ? "active" : ""} ${drag?.ws === `${ws2Mon}:${i}` ? "drop-over" : ""}`}
										data-ws={`${ws2Mon}:${i}`}
										onClick={() => focusWorkspace(i, ws2Mon)}
									>
										<i />
									</button>
								)
							)}
						</div>
					</>
				)}
				<div className="sb-sep low" ref={sepRef} />
				<div className="sb-tray" ref={trayRef}>
					{status(
						"volume",
						<VolIcon size={17} strokeWidth={1.8} />,
						`Volume ${Math.round(vol.volume * 100)}%`,
						!vol.muted
					)}
					{status(
						"bluetooth",
						bt ? <Bluetooth size={17} strokeWidth={1.8} /> : <BluetoothOff size={17} strokeWidth={1.8} />,
						bt ? "Bluetooth" : "Bluetooth off",
						bt
					)}
					{status(
						"wifi",
						wifi?.enabled ? <Wifi size={17} strokeWidth={1.8} /> : <WifiOff size={17} strokeWidth={1.8} />,
						wifi?.enabled ? (wifi.ssid ?? "Wi-Fi") : "Wi-Fi off",
						!!wifi?.enabled
					)}
					<motion.button
						className={`sb-btn sb-status sb-traybtn ${trayOpen ? "open on" : "on"}`}
						whileHover={{ scale: 1.08 }}
						whileTap={{ scale: 0.85 }}
						transition={{ type: "spring", stiffness: 500, damping: 24 }}
						onClick={(e) => toggleTray(e.currentTarget)}
					>
						{/* The chevron flips while the tray popup is open. */}
						<motion.span
							className="sb-trayicon"
							animate={{ rotate: trayOpen ? 180 : 0 }}
							transition={{ type: "spring", stiffness: 420, damping: 22 }}
						>
							<ChevronUp size={18} strokeWidth={2} />
						</motion.span>
					</motion.button>
				</div>
				<div
					ref={clockRef}
					className="sb-clock"
					onClick={(e) => openPopup("timer", e.currentTarget)}
					onContextMenu={(e) => {
						e.preventDefault();
						openPopup("controls", e.currentTarget);
					}}
				>
					<AnimatePresence initial={false} mode="wait">
						{pomo?.active ? (
							/* Timer running (or paused part way): its countdown takes the clock's place, minutes over seconds. */
							<motion.div
								key="timer"
								className={`sb-timer ${pomo.running ? "run" : "pause"}`}
								style={{ "--dot": pomo.phase === "focus" ? "#ff453a" : "#32D74B" } as CSSProperties}
								initial={{ opacity: 0, rotateX: -90 }}
								animate={{ opacity: 1, rotateX: 0 }}
								exit={{ opacity: 0, rotateX: 90 }}
								transition={{ duration: 0.14 }}
							>
								<i className="sb-timer-dot" />
								<span>{String(Math.floor(pomoSecs / 60)).padStart(2, "0")}</span>
								<span>{String(pomoSecs % 60).padStart(2, "0")}</span>
							</motion.div>
						) : (
							<motion.div
								key="clock"
								initial={{ opacity: 0, rotateX: -90 }}
								animate={{ opacity: 1, rotateX: 0 }}
								exit={{ opacity: 0, rotateX: 90 }}
								transition={{ duration: 0.14 }}
							>
								<span>{hh}</span>
								<span>{mm}</span>
							</motion.div>
						)}
					</AnimatePresence>
				</div>
			</div>

			{popup && popup.id !== "power" && (
				/* Click anywhere outside the popup (in the room the window gained) to close it. */
				<div className="sb-scrim" onMouseDown={closePopup} />
			)}
			{/* The power menu: the screen is dimmed (a click on the dim closes it) and a column of icon buttons grows out
			    of the screen edge farthest from the bar. It reuses the popup box, springs and curved joins. */}
			<AnimatePresence onExitComplete={onPopupExited}>
				{powerOpen && (
					<motion.div
						key="dim"
						className="sb-dim"
						onMouseDown={closePopup}
						initial={{ opacity: 0 }}
						animate={{ opacity: 1, transition: { duration: 0.2, delay: 0.05 } }}
						exit={{ opacity: 0, transition: { duration: 0.18 } }}
					/>
				)}
				{powerOpen && (
					<motion.div
						key="ov"
						className="sb-pwrap sb-ov"
						style={{ [far]: 0 } as CSSProperties}
						initial={{ width: BUD_W, height: ICON, top: vh / 2 - ICON / 2 }}
						animate={{ width: ovW, height: OV_H, top: ovTop }}
						exit={{
							width: BUD_W,
							height: ICON,
							top: vh / 2 - ICON / 2,
							opacity: 0,
							transition: { default: SHRINK, opacity: { duration: 0.12, delay: 0.1 } }
						}}
						// A short delay: the window needs a moment to widen to the whole screen first.
						transition={{ width: { ...GROW_W, delay: 0.05 }, height: { ...GROW_H, delay: 0.05 }, top: { ...GROW_H, delay: 0.05 } }}
					>
						<motion.i
							className="sb-pfillet top"
							style={{ transformOrigin: `${far} bottom` }}
							initial={{ scale: 0 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0, transition: SHRINK }}
							transition={{ ...GROW_H, delay: 0.05 }}
						/>
						<div className="sb-pbody">
							<div className="sb-pcontent" style={{ width: ovW, height: OV_H, [far]: 0 } as CSSProperties}>
								<PowerColumn onClose={closePopup} edge={ovEdge} far={far} />
							</div>
						</div>
						<motion.i
							className="sb-pfillet bottom"
							style={{ transformOrigin: `${far} top` }}
							initial={{ scale: 0 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0, transition: SHRINK }}
							transition={{ ...GROW_H, delay: 0.05 }}
						/>
					</motion.div>
				)}
			</AnimatePresence>
			<AnimatePresence onExitComplete={onPopupExited}>
				{popup && popup.id !== "power" && (
					/* One box for every popup, like the notch: it grows from a bud at the icon, and when another
					   icon is pressed it moves and resizes to the new popup instead of closing and reopening.
					   top and height move together, so it opens up and down from the icon's height. */
					<motion.div
						key="pop"
						className="sb-pwrap"
						style={{ [side]: BAR_W } as CSSProperties}
						initial={{ width: BUD_W, height: ICON, top: iconTop }}
						animate={{ width: popupW, height: popupH, top }}
						exit={{
							width: BUD_W,
							height: ICON,
							top: iconTop,
							opacity: 0,
							// Pulls back into the icon, then fades the last of it so no block is left behind.
							transition: { default: SHRINK, opacity: { duration: 0.12, delay: 0.1 } }
						}}
						transition={{ width: GROW_W, height: GROW_H, top: GROW_H }}
					>
						{/* The two curved joins to the bar grow with the box. */}
						<motion.i
							className="sb-pfillet top"
							style={{ transformOrigin: `${side} bottom` }}
							initial={{ scale: 0 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0, transition: SHRINK }}
							transition={GROW_H}
						/>
						<div className="sb-pbody">
							{/* The content keeps its full size and is revealed as the box opens. Swapping popups fades
							    the old one out, then the new one in (the notch does the same between its views). */}
							<AnimatePresence mode="wait">
								<motion.div
									key={popup.id + (popup.appKey ?? "") + (popup.close ? "x" : "")}
									className="sb-pcontent"
									style={{ width: popupW, height: popupH, [side]: 0 } as CSSProperties}
									initial={{ opacity: 0 }}
									animate={{ opacity: 1, transition: { delay: 0.06, duration: 0.1 } }}
									exit={{ opacity: 0, transition: { duration: 0.08 } }}
								>
									{popup.id === "wifi" && (
										<WifiPopup
											status={wifi}
											refresh={refreshWifi}
											onClose={closePopup}
											onPin={(p) => (pinned.current = p)}
										/>
									)}
									{popup.id === "bluetooth" && (
										<BluetoothPopup
											enabled={bt}
											refresh={refreshBt}
											onClose={closePopup}
											onPin={(p) => (pinned.current = p)}
										/>
									)}
									{popup.id === "volume" && (
										<VolumePopup volume={vol.volume} muted={vol.muted} onResize={setVolH} />
									)}
									{popup.id === "timer" && <TimerPopup pomo={pomo} now={pomoNow} />}
									{popup.id === "media" && (
										<MediaPopup
											media={media}
											slot={mediaSlot}
											onPlayPause={() => mediaCmd("media_play_pause")}
											onPrevious={() => mediaCmd("media_previous")}
											onNext={() => mediaCmd("media_next")}
										/>
									)}
									{popup.id === "controls" && (
										<ControlsPopup
											wifi={wifi}
											bt={bt}
											vol={vol}
											refreshWifi={refreshWifi}
											refreshBt={refreshBt}
											openPopup={(id, el) => openPopup(id, el)}
											onClose={closePopup}
											onPin={(p) => (pinned.current = p)}
											textColor={textColor}
											onTextColor={liveTextColor}
											onTextColorReset={resetTextColor}
										/>
									)}
									{popup.id === "appmenu" && menuApp && (
										<AppMenuPopup
											name={menuApp.name}
											icon={icons[menuApp.path] ?? null}
											count={menuHwnds.length}
											pinned={isPinned(menuApp)}
											onTogglePin={() => togglePin(menuApp)}
											onClose={() => menuTarget && closeHwnds([menuTarget])}
											onCloseAll={() => closeHwnds(menuHwnds)}
										/>
									)}
									{popup.id === "windows" && winApp && (
										<WindowsPopup
											wins={winList}
											appName={winApp.name}
											icon={icons[winApp.path] ?? null}
											current={fg}
											closeMode={!!popup.close}
											minimized={minWins}
											pinned={isPinned(winApp)}
											onTogglePin={() => togglePin(winApp)}
											onCloseOne={closeOne}
											onCloseAll={() => closeHwnds(winList.map(([h]) => h))}
											onPick={(h) => {
												focusHwnd(h);
												closePopup();
											}}
										/>
									)}
								</motion.div>
							</AnimatePresence>
						</div>
						<motion.i
							className="sb-pfillet bottom"
							style={{ transformOrigin: `${side} top` }}
							initial={{ scale: 0 }}
							animate={{ scale: 1 }}
							exit={{ scale: 0, transition: SHRINK }}
							transition={GROW_H}
						/>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
