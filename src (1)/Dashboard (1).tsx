import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import type { ComponentType, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
	AppWindow,
	ArrowDown,
	ArrowUp,
	ChevronLeft,
	Code,
	FileText,
	Film,
	Folder,
	Gamepad2,
	Globe,
	Headphones,
	ImagePlus,
	Lock,
	LogOut,
	Mail,
	MapPin,
	MessageCircle,
	Moon,
	Music,
	Pause,
	Play,
	Power,
	RotateCw,
	Settings,
	SkipBack,
	SkipForward,
	Terminal,
	X,
	type LucideIcon
} from "lucide-react";
import { Calendar } from "./Calendar";
import { clearDashGif, pickDashGif, useDashGif } from "./dashGif";
import "./Dashboard.css";
import "./DashboardSkin.css";
import "./DashboardNowPlaying.css";
import "./DashboardCalendar.css";
import { DashDisk } from "./DashDisk";
import { useDiskVariant } from "./useDiskVariant";
import "./DashboardGif.css";
import "./DashboardGlass.css";
import { toggleDashGlass, useDashGlass } from "./glassMode";
import "./DashScroll.css";
import "./DashboardProfile.css";
import { scopeTrace } from "./scopeTrace";
import { ScopeBackdrop } from "./ScopeBackdrop";

export type DashTab = "dashboard" | "performance" | "profile" | "windows";

export interface ProfileInfo {
	user: string;
	host: string;
	os: string;
	cpu: string;
	gpu: string;
	ramTotal: number;
	uptimeSecs: number;
}

export interface WindowEntry {
	key: string;
	hwnd: number;
	title: string;
	app: string;
	icon: string | null;
}

interface DashMediaState {
	hasMedia: boolean;
	title: string;
	artist: string;
	isPlaying: boolean;
	art: string | null;
}

const TABS: { id: DashTab; label: string }[] = [
	{ id: "dashboard", label: "Dashboard" },
	{ id: "performance", label: "Performance" },
	{ id: "profile", label: "Profile" },
	{ id: "windows", label: "Windows" }
];

const pad = (n: number) => String(n).padStart(2, "0");

const formatUptime = (secs: number): string => {
	const days = Math.floor(secs / 86400);
	const hours = Math.floor(secs / 3600) % 24;
	const minutes = Math.floor(secs / 60) % 60;
	if (days > 0) return `up ${days}d ${hours}h`;
	if (hours > 0) return `up ${hours}h ${minutes}m`;
	return `up ${minutes}m`;
};

function useNow(intervalMs: number) {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

// True when the wheel is over something that scrolls up and down (a long list, like the open windows
// or the sound outputs). It keeps the wheel: the tab only changes when the pointer is on something
// that has nothing to scroll.
const scrollsVertically = (target: EventTarget | null, host: HTMLElement): boolean => {
	let node = target instanceof HTMLElement ? target : null;
	while (node && node !== host) {
		if (node.scrollHeight > node.clientHeight + 1) {
			const overflowY = getComputedStyle(node).overflowY;
			if (overflowY === "auto" || overflowY === "scroll") return true;
		}
		node = node.parentElement;
	}
	return false;
};

export function DashTabs({
	tab,
	onChange,
	host
}: {
	tab: DashTab;
	onChange: (tab: DashTab) => void;
	host?: HTMLDivElement | null;
}) {
	const barRef = useRef<HTMLDivElement>(null);
	const tabRef = useRef(tab);
	tabRef.current = tab;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const leftoverRef = useRef(0);
	const lockedUntilRef = useRef(0);
	// The bar is the fallback host; App hands down the panel node so the wheel works
	// anywhere over the panel, including the cards below the tab bar.
	const hostRef = useRef<HTMLDivElement | null>(null);
	hostRef.current = host ?? barRef.current;

	useEffect(() => {
		const el = hostRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			// Not prevented, so the browser scrolls the list; stopped, so nothing above reacts to it.
			if (scrollsVertically(e.target, el)) {
				e.stopPropagation();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const now = performance.now();
			if (now < lockedUntilRef.current) return;
			const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
			leftoverRef.current += delta;
			const step = leftoverRef.current > 40 ? 1 : leftoverRef.current < -40 ? -1 : 0;
			if (!step) return;
			leftoverRef.current = 0;
			lockedUntilRef.current = now + 160;
			const i = TABS.findIndex((t) => t.id === tabRef.current);
			const next = TABS[(i + step + TABS.length) % TABS.length].id;
			if (next !== tabRef.current) onChangeRef.current(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [host]);

	return (
		<div
			ref={(el) => {
				barRef.current = el;
			}}
			className="dash-tabs"
		>
			{TABS.map((t) => (
				<button
					key={t.id}
					className={`dash-tab${tab === t.id ? " active" : ""}`}
					onClick={() => onChange(t.id)}
				>
					{t.label}
					{tab === t.id && (
						<motion.span
							layoutId="dash-tab-marker"
							className="dash-tab-marker"
							transition={{ type: "spring", stiffness: 320, damping: 24 }}
						/>
					)}
				</button>
			))}
		</div>
	);
}

// Which way the tab content slides: forward (1) when moving right along the tab bar.
export const dashDirection = (from: DashTab, to: DashTab): 1 | -1 => {
	const a = TABS.findIndex((t) => t.id === from);
	const b = TABS.findIndex((t) => t.id === to);
	const n = TABS.length;
	if (a < 0 || b < 0 || a === b) return 1;
	const forward = (b - a + n) % n;
	const backward = (a - b + n) % n;
	return forward <= backward ? 1 : -1;
};

const DASH_SLIDE_DISTANCE = 52;

// The slide springs and overshoots a little, which leaves a long, barely visible tail. The fade
// is a short tween so it finishes as the tab first reaches its spot instead of trailing behind.
const DASH_SPRING = { type: "spring", stiffness: 210, damping: 18, mass: 0.9 } as const;
const DASH_FADE_IN = { duration: 0.16, ease: "easeOut" } as const;
const DASH_FADE_OUT = { duration: 0.12, ease: "easeOut" } as const;

// The new tab springs in with a little overshoot; the old one leaves with a short, plain
// ease so it is gone quickly (the exit has to finish before the old layer is removed).
const dashSlide: Variants = {
	enter: (dir: number) => ({ x: dir * DASH_SLIDE_DISTANCE, opacity: 0 }),
	center: { x: 0, opacity: 1 },
	exit: (dir: number) => ({
		x: dir * -DASH_SLIDE_DISTANCE,
		opacity: 0,
		transition: {
			x: { duration: 0.24, ease: "easeIn" },
			opacity: DASH_FADE_OUT
		}
	})
};

// Holds the active tab and slides it in from the side while the old one slides out.
export function DashBody({ tab, dir, children }: { tab: DashTab; dir: 1 | -1; children: ReactNode }) {
	return (
		<div className="dash-body">
			<AnimatePresence initial={false} custom={dir}>
				<motion.div
					key={tab}
					className="dash-slide"
					custom={dir}
					variants={dashSlide}
					initial="enter"
					animate="center"
					exit="exit"
					transition={{ x: DASH_SPRING, opacity: DASH_FADE_IN }}
				>
					{children}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}

function Avatar({
	src,
	name,
	size,
	onPick,
	onReset,
	onClick,
	ariaExpanded
}: {
	src: string | null;
	name: string;
	size: number;
	onPick: () => void;
	onReset: () => void;
	onClick?: () => void;
	title?: string;
	ariaExpanded?: boolean;
}) {
	const initial = name.trim().charAt(0).toUpperCase() || "?";
	const activate = onClick ?? onPick;
	return (
		<motion.div
			className="dash-avatar"
			style={{ width: size, height: size, fontSize: size * 0.42, outline: "none" }}
			// Same spring as the now-playing album art.
			whileHover={{ scale: 1.045 }}
			whileTap={{ scale: 0.97 }}
			transition={{ type: "spring", stiffness: 360, damping: 20 }}
			aria-label="Profile picture"
			role="button"
			tabIndex={0}
			aria-haspopup={onClick ? "menu" : undefined}
			aria-expanded={ariaExpanded}
			onClick={activate}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					activate();
				}
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				onReset();
			}}
		>
			{src ? <img src={src} alt="" draggable={false} /> : <span>{initial}</span>}
		</motion.div>
	);
}

// The clock as two flip tiles (hours over minutes) with diamonds between them, the weekday and
// date above and an AM / PM switch below.
function DashClock() {
	const now = useNow(5000);
	const hours = now.getHours();
	const twelve = ((hours + 11) % 12) + 1;
	const pm = hours >= 12;
	return (
		<div className="dash-card dash-clock">
			<span className="dash-clk-date">
				{now.toLocaleDateString(undefined, { weekday: "short" })} <b>{now.getDate()}</b>
			</span>
			<span className="dash-clk-tile hours">{pad(twelve)}</span>
			<span className="dash-clk-dots" aria-hidden>
				<i />
				<i />
			</span>
			<span className="dash-clk-tile mins">{pad(now.getMinutes())}</span>
			<span className="dash-clk-ampm">
				<b className={pm ? "" : "on"}>AM</b>
				<b className={pm ? "on" : ""}>PM</b>
			</span>
		</div>
	);
}

// "Good evening" and so on, for the tag on the profile card.
function GreetingTag() {
	const now = useNow(60000);
	const h = now.getHours();
	const word = h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
	return <span className="dash-id-greet">Good {word}</span>;
}

// "Windows 11 Home 10.0.22631" -> "Windows 11".
const shortOs = (os: string | undefined): string => {
	if (!os) return "Windows";
	const m = os.replace(/^Microsoft\s+/i, "").match(/^(Windows\s+\d+)/i);
	return m ? m[1] : os;
};

// A picture card: click to choose a GIF or image, right-click to remove it.
function DashGif() {
	const src = useDashGif();
	return (
		<div
			className={`dash-card dash-gif${src ? " has-img" : ""}`}
			role="button"
			tabIndex={0}
			title={src ? "Click to change the picture, right-click to remove it" : "Click to add a GIF or image"}
			onClick={() => pickDashGif()}
			onContextMenu={(e) => {
				e.preventDefault();
				if (src) clearDashGif();
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					pickDashGif();
				}
			}}
		>
			{src ? (
				<img className="dash-gif-img" src={src} alt="" draggable={false} />
			) : (
				<>
					<ImagePlus size={20} strokeWidth={1.8} />
					<span>Add a GIF</span>
				</>
			)}
		</div>
	);
}

function DashMedia({ media }: { media: DashMediaState }) {
	// Which disk to show (Settings > Notch > Now Playing Disk): 1 is black, 2 is yellow.
	const diskVariant = useDiskVariant("dash");
	const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);
	useEffect(() => {
		if (optimisticPlaying === null) return;
		if (optimisticPlaying === media.isPlaying) {
			setOptimisticPlaying(null);
			return;
		}
		const timeout = window.setTimeout(() => setOptimisticPlaying(null), 2000);
		return () => window.clearTimeout(timeout);
	}, [media.isPlaying, optimisticPlaying]);
	const isPlaying = optimisticPlaying ?? media.isPlaying;

	if (!media.hasMedia) {
		return (
			<div className="dash-card dash-media empty">
				<Music size={26} />
				<span>Nothing playing</span>
			</div>
		);
	}
	const send = (command: string) => invoke(command).catch(() => {});
	const togglePlayback = async () => {
		setOptimisticPlaying(!isPlaying);
		try {
			await invoke("media_play_pause");
		} catch {
			setOptimisticPlaying(null);
		}
	};

	return (
		<div className="dash-card dash-media">
			<span className={`dash-np-tag${isPlaying ? " on" : ""}`}>Now playing</span>
			<motion.div
				className="dash-art"
				whileHover={{ scale: 1.045 }}
				whileTap={{ scale: 0.97 }}
				transition={{ type: "spring", stiffness: 360, damping: 20 }}
			>
				<DashDisk art={media.art} playing={isPlaying} variant={diskVariant} />
			</motion.div>
			<div className="dash-np-plate">
				<div className="dash-media-title" title={media.title}>
					{media.title}
				</div>
				<div className="dash-media-artist" title={media.artist}>
					{media.artist}
				</div>
			</div>
			<div className="dash-media-controls">
				<motion.button
					onClick={() => send("media_previous")}
					title="Previous"
					whileHover={{ scale: 1.12 }}
					whileTap={{ scale: 0.86 }}
					transition={{ type: "spring", stiffness: 480, damping: 16 }}
				>
					<SkipBack size={14} />
				</motion.button>
				<motion.button
					className={`main${isPlaying ? " on" : ""}`}
					onClick={togglePlayback}
					title={isPlaying ? "Pause" : "Play"}
					whileHover={{ scale: 1.1 }}
					whileTap={{ scale: 0.88 }}
					transition={{ type: "spring", stiffness: 480, damping: 16 }}
				>
					{isPlaying ? <Pause size={15} /> : <Play size={15} />}
				</motion.button>
				<motion.button
					onClick={() => send("media_next")}
					title="Next"
					whileHover={{ scale: 1.12 }}
					whileTap={{ scale: 0.86 }}
					transition={{ type: "spring", stiffness: 480, damping: 16 }}
				>
					<SkipForward size={14} />
				</motion.button>
			</div>
		</div>
	);
}
type SystemPowerAction = "lock" | "sleep" | "sign_out" | "restart" | "shutdown";

const POWER_ACTIONS: { action: SystemPowerAction; label: string; Icon: LucideIcon }[] = [
	{ action: "lock", label: "Bear Mode", Icon: Lock },
	{ action: "sleep", label: "Nap Time", Icon: Moon },
	{ action: "sign_out", label: "Dip Out", Icon: LogOut },
	{ action: "restart", label: "Oops, Reboot", Icon: RotateCw },
	{ action: "shutdown", label: "Rage Quit", Icon: Power }
];

// Replaces the whole dashboard grid with large Windows power buttons, the way the calendar's note
// sheet replaces the calendar. Sign out, restart and shut down take a second click to confirm.
const POWER_CONFIRM: Partial<Record<SystemPowerAction, string>> = {
	sign_out: "Sign out of Windows? Unsaved work in open apps may be lost.",
	restart: "Restart Windows? Unsaved work in open apps may be lost.",
	shutdown: "Shut down Windows? Unsaved work in open apps may be lost."
};

function PowerPanel({ onBack }: { onBack: () => void }) {
	const [armed, setArmed] = useState<SystemPowerAction | null>(null);
	const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onBack();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("keydown", closeOnEscape);
			if (armTimer.current) clearTimeout(armTimer.current);
		};
	}, [onBack]);

	const run = async (action: SystemPowerAction) => {
		if (POWER_CONFIRM[action] && armed !== action) {
			setArmed(action);
			if (armTimer.current) clearTimeout(armTimer.current);
			armTimer.current = setTimeout(() => setArmed(null), 4000);
			return;
		}
		onBack();
		try {
			await invoke("system_power_action", { action });
		} catch (error) {
			console.error("Windows power action failed:", error);
		}
	};

	return (
		<motion.div
			className="dash-power-panel"
			role="dialog"
			aria-label="Windows power options"
			initial={{ opacity: 0, y: 16, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 10, scale: 0.99, transition: DASH_FADE_OUT }}
			transition={{ y: DASH_SPRING, scale: DASH_SPRING, opacity: DASH_FADE_IN }}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="dash-power-head">
				<button type="button" className="dash-power-back" onClick={onBack} title="Back (Esc)">
					<ChevronLeft size={16} strokeWidth={2} />
				</button>
				<span className="dash-power-title">Power</span>
				<span className="dash-power-hint">{armed ? "Click again to confirm" : "Windows options"}</span>
			</div>
			<div className="dash-power-grid">
				{POWER_ACTIONS.map(({ action, label, Icon }, index) => (
					<motion.button
						key={action}
						type="button"
						className={`dash-power-tile${armed === action ? " armed" : ""}`}
						title={POWER_CONFIRM[action] ?? label}
						initial={{ opacity: 0, y: 12 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ ...DASH_SPRING, delay: 0.05 + index * 0.04 }}
						whileTap={{ scale: 0.95 }}
						onClick={() => run(action)}
					>
						<Icon size={26} strokeWidth={1.6} />
						<span>{armed === action ? "Confirm" : label}</span>
					</motion.button>
				))}
			</div>
		</motion.div>
	);
}

interface AvatarProps {
	avatar: string | null;
	onPickAvatar: () => void;
	onResetAvatar: () => void;
}

export function DashboardTab({
	weather,
	profile,
	uptimeSecs,
	avatar,
	onPickAvatar,
	onResetAvatar,
	notes,
	onSaveNote,
	media
}: AvatarProps & {
	weather: ReactNode;
	profile: ProfileInfo | null;
	uptimeSecs: number | null;
	notes: Record<string, string>;
	onSaveNote: (key: string, text: string) => void;
	// The usage numbers are no longer shown on the dashboard (the GIF card took their place). They
	// stay in the type so App.tsx keeps passing them without changes.
	cpu?: number;
	ram?: number;
	ramFree?: number | null;
	disk?: number | null;
	diskFree?: number | null;
	drive?: string;
	media: DashMediaState;
}) {
	const [powerOpen, setPowerOpen] = useState(false);

	const areas = weather
		? '"weather weather profile profile media" "clock calendar calendar bars media"'
		: '"profile profile profile profile media" "clock calendar calendar bars media"';
	return (
		<div className="dash-grid" style={{ gridTemplateAreas: areas }}>
			{weather}
			<div className="dash-card dash-profile">
				<div className="dash-profile-avatar-wrap">
					<Avatar
						src={avatar}
						name={profile?.user ?? ""}
						size={52}
						onPick={onPickAvatar}
						onReset={onResetAvatar}
						onClick={() => setPowerOpen(true)}
						ariaExpanded={powerOpen}
						title="Click for Windows power options, right-click to remove the picture"
					/>
				</div>
				<div className="dash-id">
					<div className="dash-id-top">
						<span className="dash-id-name" title={profile?.user}>
							{profile?.user || "--"}
						</span>
						<GreetingTag />
					</div>
					<span className="dash-id-handle" title={profile ? `${profile.user}@${profile.host}` : undefined}>
						@{profile?.host ?? "--"}
					</span>
					<div className="dash-id-tiles">
						<span className="dash-id-tile" title={profile?.os}>
							<i>OS</i>
							<b>{shortOs(profile?.os)}</b>
						</span>
						<span className="dash-id-tile">
							<i>Uptime</i>
							<b>{uptimeSecs !== null ? formatUptime(uptimeSecs).replace("up ", "") : "--"}</b>
						</span>
					</div>
				</div>
			</div>
			<DashClock />
			<div className="dash-card dash-calendar">
				<Calendar variant="dash" notes={notes} onSaveNote={onSaveNote} />
			</div>
			<DashGif />
			<DashMedia media={media} />
			<AnimatePresence>
				{powerOpen && <PowerPanel key="power" onBack={() => setPowerOpen(false)} />}
			</AnimatePresence>
		</div>
	);
}

export function ProfileTab({
	profile,
	uptimeSecs,
	avatar,
	onPickAvatar,
	onResetAvatar
}: AvatarProps & { profile: ProfileInfo | null; uptimeSecs: number | null }) {
	// [label, value, picked out]. Uptime is the highlighted line.
	const rows: [string, string, boolean?][] = profile
		? [
				["Computer", profile.host],
				["System", profile.os],
				["Processor", profile.cpu || "--"],
				["Graphics", profile.gpu || "--"],
				["Memory", `${(profile.ramTotal / 1024 ** 3).toFixed(1)} GiB`],
				["Uptime", uptimeSecs !== null ? formatUptime(uptimeSecs).replace("up ", "") : "--", true]
			]
		: [];
	// The same computer always draws the same trace behind the panels.
	const trace = useMemo(() => scopeTrace(`${profile?.user ?? ""}@${profile?.host ?? ""}`), [profile?.user, profile?.host]);
	return (
		<div className="dash-card dash-profile-tab dash-pf">
			<ScopeBackdrop trace={trace} />
			<div className="dash-pf-main">
				<div className="dash-pf-panel dash-pf-id">
					<div className="dash-pf-axes">
						<Avatar
							src={avatar}
							name={profile?.user ?? ""}
							size={92}
							onPick={onPickAvatar}
							onReset={onResetAvatar}
						/>
					</div>
					<span className="dash-id-name" title={profile?.user}>
						{profile?.user || "--"}
					</span>
					<GreetingTag />
					<span className="dash-id-handle" title={profile ? `${profile.user}@${profile.host}` : undefined}>
						@{profile?.host ?? "--"}
					</span>
				</div>
				<i className="dash-pf-link" aria-hidden />
				<div className="dash-pf-panel dash-pf-info">
					<div className="dash-pf-head">
						<span>Collector readout</span>
						<i className="dash-pf-pulse" aria-hidden />
					</div>
					{rows.map(([label, value, hot], i) => (
						<div key={label} className={`dash-pf-row${hot ? " hot" : ""}`}>
							<span className="dash-pf-k">
								<em>{String(i + 1).padStart(2, "0")}</em>
								{label}
							</span>
							<span className="dash-pf-dots" aria-hidden />
							<b className="dash-pf-v" title={value}>
								{value}
							</b>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

// Picks an icon for a window from its app name, used when the app has no icon of its own.
const WINDOW_CATEGORIES: { test: RegExp; Icon: LucideIcon; label: string }[] = [
	{
		test: /chrome|firefox|zen|edge|brave|opera|vivaldi|librewolf|waterfox|browser|^arc$|tor$/,
		Icon: Globe,
		label: "Browser"
	},
	{
		test: /terminal|powershell|pwsh|^cmd|conhost|wezterm|alacritty|kitty|mintty|tabby|warp|ghostty|bash|^wsl/,
		Icon: Terminal,
		label: "Terminal"
	},
	{
		test: /discord|slack|telegram|whatsapp|teams|signal|element|skype|zoom|messenger|viber|wechat|^line$/,
		Icon: MessageCircle,
		label: "Chat"
	},
	{ test: /explorer|files|totalcmd|doublecmd|xyplorer|q-dir/, Icon: Folder, label: "Files" },
	{
		test: /spotify|music|itunes|foobar|musicbee|deezer|tidal|winamp|aimp/,
		Icon: Headphones,
		label: "Music"
	},
	{
		test: /vlc|mpv|potplayer|netflix|plex|kodi|movies|obs|streamlabs|twitch|video/,
		Icon: Film,
		label: "Video"
	},
	{
		test: /(^|[^a-z])code([^a-z]|$)|vscode|cursor|^zed|idea|pycharm|webstorm|rider|clion|devenv|sublime|notepad\+\+|atom|vim|emacs|studio/,
		Icon: Code,
		label: "Code"
	},
	{
		test: /steam|epic|riot|valorant|minecraft|battle\.net|origin|ubisoft|gog|roblox|game/,
		Icon: Gamepad2,
		label: "Game"
	},
	{
		test: /winword|word|excel|powerpnt|onenote|notepad|acrobat|sumatra|obsidian|notion|soffice|libreoffice|foxit/,
		Icon: FileText,
		label: "Document"
	},
	{ test: /outlook|thunderbird|^mail/, Icon: Mail, label: "Mail" },
	{
		test: /settings|control|taskmgr|regedit|mmc|msconfig/,
		Icon: Settings,
		label: "System"
	}
];

const windowCategory = (app: string) => {
	const name = app.toLowerCase();
	return WINDOW_CATEGORIES.find((c) => c.test.test(name)) ?? { Icon: AppWindow, label: "Window" };
};

// The weather card: a small caps condition label, the temperature with its unit in a little
// circle, the place in a pill, and the weather icon in a round badge.
export function DashWeather({
	Icon,
	temperature,
	high,
	low,
	unit,
	condition,
	city
}: {
	Icon: ComponentType<import("lucide-react").LucideProps>;
	temperature: number;
	high?: number | null;
	low?: number | null;
	unit: "C" | "F";
	condition: string;
	city: string | null | undefined;
}) {
	// The weather icon is the switch between the glass look and the classic one.
	const glass = useDashGlass();
	return (
		<div className="dash-card dash-weather" title={city ? `${condition} \u2014 ${city}` : condition}>
			<div className="dash-weather-text">
				<span className="dash-weather-label">{condition}</span>
				<span className="dash-weather-temp">
					{temperature}
					<span className="dash-weather-unit">{"\u00b0"}{unit}</span>
					{(high != null || low != null) && (
						<span className="dash-weather-range" title="Today's high and low">
							{high != null && (
								<span>
									<ArrowUp size={8} strokeWidth={3} />
									{high}{"\u00b0"}
								</span>
							)}
							{low != null && (
								<span>
									<ArrowDown size={8} strokeWidth={3} />
									{low}{"\u00b0"}
								</span>
							)}
						</span>
					)}
				</span>
				{city && (
					<span className="dash-weather-place">
						<MapPin size={9} strokeWidth={2.4} />
						<span>{city}</span>
					</span>
				)}
			</div>
			<span
				className="dash-weather-badge"
				role="button"
				tabIndex={0}
				aria-pressed={glass}
				title={glass ? "Switch to the classic look" : "Switch to the glass look"}
				onClick={() => toggleDashGlass()}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						toggleDashGlass();
					}
				}}
			>
				<Icon size={26} strokeWidth={1.6} />
			</span>
		</div>
	);
}

export function WindowsTab({
	windows,
	onFocus,
	onClose
}: {
	windows: WindowEntry[];
	onFocus: (hwnd: number) => void;
	onClose: (hwnd: number) => void;
}) {
	// The trace changes a little as windows come and go.
	const trace = useMemo(() => scopeTrace(`windows:${windows.length}`), [windows.length]);
	return (
		<div className="dash-card dash-windows dash-pf">
			<ScopeBackdrop trace={trace} />
			<div className="dash-pf-panel dash-pf-info dash-wn">
				<div className="dash-pf-head">
					<span>Open {windows.length === 1 ? "memory" : "memories"}</span>
					<span className="dash-wn-count">
						<b>{String(windows.length).padStart(2, "0")}</b>
						<i className="dash-pf-pulse" aria-hidden />
					</span>
				</div>
				<div className="dash-scroll">
					{windows.length === 0 ? (
						<div className="dash-empty">No open windows</div>
					) : (
						windows.map((w, i) => {
							const { Icon } = windowCategory(w.app);
							return (
								<div
									key={w.key}
									className="dash-win-row"
									role="button"
									tabIndex={0}
									onClick={() => onFocus(w.hwnd)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											onFocus(w.hwnd);
										}
									}}
									title={w.title}
								>
									<em className="dash-win-n">{String(i + 1).padStart(2, "0")}</em>
									{w.icon ? (
										<img src={w.icon} alt="" draggable={false} />
									) : (
										<span className="dash-win-fallback">
											<Icon size={14} strokeWidth={2} />
										</span>
									)}
									<span className="dash-win-title">{w.title}</span>
									<span className="dash-pf-dots" aria-hidden />
									<span className="dash-win-app">{w.app}</span>
									<button
										className="dash-win-close"
										title="Close window"
										onClick={(e) => {
											e.stopPropagation();
											onClose(w.hwnd);
										}}
									>
										<X size={13} strokeWidth={2.4} />
									</button>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
