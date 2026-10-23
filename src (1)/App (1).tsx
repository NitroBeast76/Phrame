import { motion, AnimatePresence, useAnimation, useMotionValue } from "framer-motion";
import { useEffect, useState, useCallback, useRef, memo } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateCheckResult } from "./updater";
import "./App.css";
import "./ThemeToast.css";
import "./borderless.css";
import { initTheme } from "./theme";
import type { Announcement } from "./hooks/useAnnouncement";
import {
	getTimerChimeCtx,
	playTimerSound,
	preloadCustomTimerSound,
	clearCustomTimerSoundCache,
	hasCustomTimerSound,
	NO_CUSTOM_SOUND,
	DEFAULT_TIMER_VOLUME
} from "./timerSound";
import {
	playReminderSound,
	preloadCustomReminderSound,
	clearCustomReminderSoundCache,
	DEFAULT_REMINDER_VOLUME,
	type ReminderKind
} from "./reminderSound";
import TaskBoard, { type QuickTask, type TaskStatus } from "./TaskBoard";
import WallpaperPanel, { WALLPAPER_PANEL_HEIGHT, wallpaperPanelWidth } from "./WallpaperPanel";
import {
	DashBody,
	DashTabs,
	DashWeather,
	DashboardTab,
	ProfileTab,
	WindowsTab,
	type DashTab,
	type ProfileInfo,
	type WindowEntry,
	dashDirection
} from "./Dashboard";
import { calendarDateKey } from "./Calendar";
import { PerformanceTab, type NetworkUsage } from "./PerformanceTab";
import TimeGun, {
	POMO_DEFAULT_DURATIONS,
	POMO_ROUNDS,
	phaseMs,
	type PomodoroDurations,
	type PomodoroPhase
} from "./TimeGun";
import {
	PlayIcon,
	PauseIcon,
	SkipBackIcon,
	SkipForwardIcon,
	VolumeLowIcon,
	VolumeHighIcon,
	MusicNoteIcon,
	HeadphonesIcon
} from "./icons";
import { CompactMediaPlayer } from "./CompactMediaPlayer";
import { WifiPanel } from "./components/WifiPanel";
import { BluetoothPanel } from "./components/BluetoothPanel";
import { useWeather } from "./hooks/useWeather";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { useTrailingThrottle } from "./hooks/useTrailingThrottle";
import { useAnnouncement } from "./hooks/useAnnouncement";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";
import { applyTheme } from "./theme";
import "./TextColorPicker.css";
import "./SidebarNotch.css";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WidgetConfig } from "./components/StatusWidgetConfig";
import {
	Cpu,
	MemoryStick,
	HardDrive,
	ArrowUpDown,
	BellRing,
	Megaphone,
	X,
	Check,
	ChevronRight
} from "lucide-react";

// Keep wheel/scroll gestures inside the audio sheet from reaching the
// notch's scroll-to-switch-mode handling.
const stopWheelPropagation = (e: WheelEvent) => e.stopPropagation();

// The notch floats this many px below the top of the screen as a pill, rounded on all sides.
// The click-through region tolerates a gap of about this size (see the 5px + hysteresis
// padding below the notch in the Rust mouse hook); a much larger gap needs a Rust change.
const NOTCH_FLOAT_GAP = 11;

// Simple SVG icons
function WifiIcon({ enabled, connected }: { enabled: boolean; connected: boolean }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			opacity={!enabled ? 0.4 : connected ? 1 : 0.7}
		>
			<path d="M5 12.55a11 11 0 0 1 14.08 0" />
			<path d="M1.42 9a16 16 0 0 1 21.16 0" />
			<path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
			<line x1="12" y1="20" x2="12.01" y2="20" />
		</svg>
	);
}

// Theme cycle button
const THEME_MODES = ["custom", "dark", "light", "adaptive", "retro"]; // remove "light" here to skip it
const THEME_LABELS: Record<string, string> = {
	dark: "Dark",
	light: "Light",
	custom: "Custom",
	adaptive: "Adaptive",
	retro: "Retro"
};

function ThemeIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
		</svg>
	);
}

// Game controller icon (game overlay button)
function GameControllerIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<line x1="6" y1="12" x2="10" y2="12" />
			<line x1="8" y1="10" x2="8" y2="14" />
			<line x1="15" y1="13" x2="15.01" y2="13" />
			<line x1="18" y1="11" x2="18.01" y2="11" />
			<path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" />
		</svg>
	);
}

export function TrayIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="3" y="3" width="6" height="6" rx="1" />
			<rect x="15" y="3" width="6" height="6" rx="1" />
			<rect x="15" y="15" width="6" height="6" rx="1" />
			<rect x="3" y="15" width="6" height="6" rx="1" />
		</svg>
	);
}

function BatteryIcon({
	charging,
	level,
	threshold = 20
}: {
	charging: boolean;
	level: number;
	threshold?: number;
}) {
	const percentage = Math.min(Math.max(level, 0), 100);

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				position: "relative",
				height: "14px",
				justifyContent: "center"
			}}
		>
			<svg width="20" height="10" viewBox="0 0 20 10" fill="none">
				{/* Battery Shell - Centered at 9px within 20px width, ignoring the tip's offset */}
				<rect
					x="2"
					y="0.75"
					width="14"
					height="8.5"
					rx="2.4"
					stroke="currentColor"
					strokeOpacity={0.35}
					strokeWidth="1.1"
				/>
				{/* Battery Tip */}
				<path
					d="M17.5 3.5V6.5"
					stroke="currentColor"
					strokeOpacity={0.35}
					strokeWidth="1.2"
					strokeLinecap="round"
				/>
				{/* Fill */}
				<rect
					x="3.8"
					y="2.5"
					width={Math.max(0.5, (percentage / 100) * 10.4)}
					height="5"
					rx="1"
					fill={charging ? "#32D74B" : percentage <= threshold ? "#FF453A" : "white"}
				/>
			</svg>
			{/* Charging Bolt - Centered on the battery body */}
			{charging && (
				<div
					style={{
						position: "absolute",
						top: "50%",
						left: "9px",
						transform: "translate(-50%, -50%)",
						color: "white",
						filter: "drop-shadow(0px 0px 1.5px rgba(0,0,0,0.8))"
					}}
				>
					<svg width="7" height="10" viewBox="0 0 8 12" fill="currentColor">
						<path d="M4.5 0L0 7H3.5L2.5 12L8 5H4.5L5.5 0H4.5Z" />
					</svg>
				</div>
			)}
		</div>
	);
}

function GreenDownArrowIcon() {
	return (
		<div
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: "18px",
				height: "18px",
				borderRadius: "50%",
				background: "rgba(50, 215, 75, 0.15)",
				border: "1px solid rgba(50, 215, 75, 0.35)",
				boxShadow: "0 0 8px rgba(50, 215, 75, 0.25)",
				flexShrink: 0,
				verticalAlign: "middle"
			}}
		>
			<svg
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="#32D74B"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<line x1="12" y1="4" x2="12" y2="16"></line>
				<polyline points="18 10 12 16 6 10"></polyline>
				<line x1="6" y1="20" x2="18" y2="20"></line>
			</svg>
		</div>
	);
}

export const Visualizer = memo(function Visualizer({
	isPlaying,
	bars = 5,
	height = 20
}: {
	isPlaying: boolean;
	bars?: number;
	height?: number;
}) {
	const [audioData, setAudioData] = useState<number[]>(new Array(bars).fill(0.18));

	useEffect(() => {
		if (!isPlaying) {
			setAudioData(new Array(bars).fill(0.18));
			return;
		}

		const unlisten = listen<{ frequencies: number[] }>("audio-visualization", (event) => {
			// If we receive fewer frequencies than bars, repeat or interpolate
			// If more, slice
			let data = event.payload.frequencies;
			if (data.length > bars) data = data.slice(0, bars);
			while (data.length < bars) data.push(0.18);
			setAudioData(data);
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, [isPlaying, bars]);

	return (
		<div
			className="visualizer-horizontal"
			style={{ height: `${height}px`, width: `${bars * 6}px` }}
		>
			{audioData.map((value, i) => (
				<motion.div
					key={i}
					className="bar-horizontal"
					animate={{
						scaleY: isPlaying ? Math.max(0.2, value) : 0.1,
						opacity: isPlaying ? 0.95 : 0.5
					}}
					transition={{
						type: "spring",
						stiffness: 600,
						damping: 30,
						mass: 0.5
					}}
				/>
			))}
		</div>
	);
});

// ── Calendar day notes ──
// Notes are stored as { "YYYY-MM-DD": "text" }. A note counts as "done" once its
// reminder was dismissed; the done map remembers the acknowledged text, so editing
// a note re-arms its reminder automatically.
const CALENDAR_NOTES_KEY = "bloom-calendar-notes";
const CALENDAR_NOTES_DONE_KEY = "bloom-calendar-notes-done";
const parseNoteMap = (raw: unknown): Record<string, string> => {
	try {
		const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			if (typeof v === "string" && v) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
};

const persistNoteMap = (key: string, map: Record<string, string>) => {
	const value = JSON.stringify(map);
	localStorage.setItem(key, value);
	invoke("save_setting", { key, value }).catch(console.error);
};

// ── Tasks panel ──
// Stored as a JSON array of { id, text, done, status, priority, remindAt?, notified? }
// under one settings key. `done` always mirrors status === "done".
const TASKS_KEY = "bloom-tasks";
const PERF_DRIVE_KEY = "bloom-perf-drive";
const POMO_KEY = "bloom-pomodoro";

// Time gun (Pomodoro): lengths in minutes, which may carry whole seconds (1.5 is 1:30), kept between 0:01 and 99:59.
const POMO_MAX_MINUTES = 99 + 59 / 60;
const parsePomo = (raw: unknown): PomodoroDurations => {
	try {
		const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<PomodoroDurations> | null;
		const clamp = (v: unknown, fallback: number) =>
			typeof v === "number" && Number.isFinite(v)
				? Math.min(POMO_MAX_MINUTES, Math.max(1 / 60, Math.round(v * 60) / 60))
				: fallback;
		return {
			focus: clamp(value?.focus, POMO_DEFAULT_DURATIONS.focus),
			short: clamp(value?.short, POMO_DEFAULT_DURATIONS.short),
			long: clamp(value?.long, POMO_DEFAULT_DURATIONS.long)
		};
	} catch {
		return POMO_DEFAULT_DURATIONS;
	}
};

interface PomodoroState {
	phase: PomodoroPhase;
	running: boolean;
	/** When the running phase ends (epoch ms); only meaningful while running. */
	endAt: number;
	/** Time left; frozen while paused. */
	remainingMs: number;
	/** Focus rounds finished in the current cycle. */
	rounds: number;
}
const TASK_MAX_LENGTH = 120;
// Group name and note limits, kept here next to the text limit so the editor and
// the parser agree on the same caps.
const TASK_GROUP_MAX_LENGTH = 24;
const TASK_NOTES_MAX_LENGTH = 500;
const TASK_MAX_COUNT = 100;
const TASK_STATUSES: TaskStatus[] = ["open", "progress", "done"];

const parseTasks = (raw: unknown): QuickTask[] => {
	try {
		const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!Array.isArray(arr)) return [];
		const out: QuickTask[] = [];
		for (const t of arr) {
			if (t && typeof t.id === "string" && typeof t.text === "string" && t.text) {
				// Older saves only have `done`.
				const status: TaskStatus = TASK_STATUSES.includes(t.status)
					? t.status
					: t.done === true
						? "done"
						: "open";
				const task: QuickTask = {
					id: t.id,
					text: t.text.slice(0, TASK_MAX_LENGTH),
					done: status === "done",
					status,
					priority: t.priority === 1 || t.priority === 2 || t.priority === 3 ? t.priority : 2
				};
				if (typeof t.remindAt === "number" && Number.isFinite(t.remindAt)) {
					task.remindAt = t.remindAt;
					if (t.notified === true) task.notified = true;
				}
				// Added later: group, pin and a longer note. Absent on older saves,
				// so they are only set when actually present -- an untouched task
				// keeps its old shape instead of gaining empty fields.
				if (typeof t.group === "string" && t.group.trim()) {
					task.group = t.group.trim().slice(0, TASK_GROUP_MAX_LENGTH);
				}
				if (t.pinned === true) task.pinned = true;
				if (typeof t.notes === "string" && t.notes.trim()) {
					task.notes = t.notes.trim().slice(0, TASK_NOTES_MAX_LENGTH);
				}
				out.push(task);
			}
		}
		return out.slice(0, TASK_MAX_COUNT);
	} catch {
		return [];
	}
};

interface MediaInfo {
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

interface WifiStatus {
	enabled: boolean;
	connected: boolean;
	ssid: string | null;
}

const MARQUEE_SPEED = 30; // px/s — constant for all titles
const MARQUEE_MIN_DURATION = 5; // floor so short titles don't flicker

const TitleMarquee = ({ title }: { title: string }) => {
	const textRef = useRef<HTMLSpanElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);
	const [scrollDistance, setScrollDistance] = useState(0);
	const [scrollDuration, setScrollDuration] = useState(8);

	useEffect(() => {
		const check = () => {
			if (textRef.current && containerRef.current) {
				const textWidth = textRef.current.scrollWidth;
				const containerWidth = containerRef.current.clientWidth;
				const overflow = textWidth > containerWidth;
				setIsOverflowing(overflow);
				if (overflow) {
					const distance = textWidth - containerWidth;
					setScrollDistance(distance);
					setScrollDuration(Math.max(distance / MARQUEE_SPEED, MARQUEE_MIN_DURATION));
				}
			}
		};
		check();
		const observer = new ResizeObserver(check);
		if (containerRef.current) observer.observe(containerRef.current);
		return () => observer.disconnect();
	}, [title]);

	return (
		<div
			ref={containerRef}
			className="premium-title-wrap"
			style={{ width: "100%", overflow: "hidden" }}
		>
			<span
				ref={textRef}
				className={`premium-title ${isOverflowing ? "marquee" : ""}`}
				style={
					{
						"--scroll-distance": isOverflowing ? `-${scrollDistance}px` : undefined,
						"--scroll-duration": `${scrollDuration}s`
					} as React.CSSProperties
				}
			>
				{title}
			</span>
		</div>
	);
};

function App() {
	useEffect(() => {
		return initTheme();
	}, []);

	const [time, setTime] = useState("");
	const [isHovered, setIsHovered] = useState(false);
	const [isReady, setIsReady] = useState(false);
	const [scale, setScale] = useState(() =>
		parseFloat(localStorage.getItem("bloom-scale") || "1.0")
	);
	const [timeFormat24h, setTimeFormat24h] = useState(
		() => localStorage.getItem("bloom-time-format-24h") === "true"
	);

	const [batteryLevel, setBatteryLevel] = useState(100);
	const [isCharging, setIsCharging] = useState(false);
	const [showPowerPulse, setShowPowerPulse] = useState(false);
	const [showLowBatteryPulse, setShowLowBatteryPulse] = useState(false);
	const [lowBatteryThreshold, setLowBatteryThreshold] = useState(() =>
		parseInt(localStorage.getItem("bloom-low-battery-threshold") || "20")
	);
	const prevChargingRef = useRef<boolean | null>(null);
	const powerPulseTimeoutRef = useRef<any>(null);
	const lowBatteryPulseShownRef = useRef<boolean>(false);

	const [eventPeek, setEventPeek] = useState(false);
	const eventPeekTimeoutRef = useRef<any>(null);
	const updatePulseTimerRef = useRef<any>(null);
	const triggerEventPeek = useCallback((duration = 3000) => {
		setEventPeek(true);
		if (eventPeekTimeoutRef.current) clearTimeout(eventPeekTimeoutRef.current);
		eventPeekTimeoutRef.current = setTimeout(() => setEventPeek(false), duration);
	}, []);

	const [notchMode, setNotchMode] = useState(() => {
		const raw = localStorage.getItem("bloom-notch-mode") || "fixed";
		if (raw === "auto-hide") return "smart";
		return raw;
	});

	useEffect(() => {
		if (isReady && prevChargingRef.current !== null && prevChargingRef.current !== isCharging) {
			setShowPowerPulse(true);
			if (notchMode === "peek") triggerEventPeek(4000);
			if (powerPulseTimeoutRef.current) clearTimeout(powerPulseTimeoutRef.current);
			powerPulseTimeoutRef.current = setTimeout(() => {
				setShowPowerPulse(false);
			}, 4000);
		}
		prevChargingRef.current = isCharging;
	}, [isCharging, isReady, notchMode, triggerEventPeek]);

	useEffect(() => {
		// Trigger pulse when dropping below threshold while discharging
		if (
			isReady &&
			batteryLevel <= lowBatteryThreshold &&
			!isCharging &&
			!lowBatteryPulseShownRef.current
		) {
			setShowLowBatteryPulse(true);
			if (notchMode === "peek") triggerEventPeek(5000);
			lowBatteryPulseShownRef.current = true;
			setTimeout(() => setShowLowBatteryPulse(false), 5000);
		}

		// Reset the "shown" state if battery is charged or threshold is lowered
		if (isCharging || batteryLevel > lowBatteryThreshold) {
			lowBatteryPulseShownRef.current = false;
		}
	}, [batteryLevel, isCharging, lowBatteryThreshold, isReady, notchMode, triggerEventPeek]);

	// Weather state (managed by useWeather hook)

	// Media state
	const [isPlaying, setIsPlaying] = useState(false);
	const [mediaInfo, setMediaInfo] = useState<MediaInfo>({
		title: "",
		artist: "",
		is_playing: false,
		has_media: false
	});
	const [albumArtUrl, setAlbumArtUrl] = useState<string | null>(null);
	const [albumArtKey, setAlbumArtKey] = useState(0);
	const [volume, setVolume] = useState(0.5);
	const [isMuted, setIsMuted] = useState(false);
	// Sliders show 0 while muted, matching the overlay HUD.
	const displayVolume = isMuted ? 0 : volume;
	// Null until the first successful fetch so the pill can't flash a wrong
	// default on startup.
	const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null);
	const wifiEnabled = wifiStatus?.enabled ?? false;
	const wifiConnected = wifiStatus?.connected ?? false;
	const [bluetoothEnabled, setBluetoothEnabled] = useState(true);
	// Names of connected Bluetooth devices, for the controls tile.
	const [btConnectedNames, setBtConnectedNames] = useState<string[]>([]);
	const [currentBrightness, setCurrentBrightness] = useState(50);

	// System metrics for status widgets
	const [cpuUsage, setCpuUsage] = useState(0);
	const [ramUsage, setRamUsage] = useState(0);
	const [diskSpace, setDiskSpace] = useState(0);
	const [perf, setPerf] = useState<PerfExtras | null>(null);
	// Drive shown in the performance panel's storage stat (right-click cycles it).
	const [perfDrive, setPerfDrive] = useState(() => localStorage.getItem(PERF_DRIVE_KEY) || "C");
	const perfDriveRef = useRef(perfDrive);
	const pollPerfRef = useRef<(() => void) | null>(null);
	// Dashboard panel: current tab, profile details and picture, and the window list.
	const [dashTab, setDashTab] = useState<DashTab>("dashboard");
	const dashTabRef = useRef<DashTab>("dashboard");
	dashTabRef.current = dashTab;
	const [dashDir, setDashDir] = useState<1 | -1>(1);
	// Node of the dashboard panel; DashTabs listens for wheel on it so scrolling anywhere
	// over the open panel switches tabs.
	const [dashPanelEl, setDashPanelEl] = useState<HTMLDivElement | null>(null);
	const changeDashTab = useCallback((next: DashTab) => {
		setDashDir(dashDirection(dashTabRef.current, next));
		setDashTab(next);
	}, []);
	const [profile, setProfile] = useState<{ info: ProfileInfo; at: number } | null>(null);
	const [avatar, setAvatar] = useState<string | null>(null);
	const [windowList, setWindowList] = useState<WindowEntry[]>([]);
	// Network speed and totals for the Performance tab, with a short history for its graph.
	const [net, setNet] = useState<NetworkUsage | null>(null);
	// Seeded with a flat line so the graph is never blank while the first real samples arrive.
	const [netHistory, setNetHistory] = useState<{ down: number[]; up: number[] }>({
		down: [0, 0],
		up: [0, 0]
	});
	const netLastSampleAtRef = useRef(0);
	const [netUpSpeed, setNetUpSpeed] = useState(0);
	const [netDownSpeed, setNetDownSpeed] = useState(0);
	const [statusWidgets, setStatusWidgets] = useState<WidgetConfig>({
		left: ["weather"],
		right: ["battery"]
	});

	const [windowLabel, setWindowLabel] = useState<string>("");
	useEffect(() => {
		setWindowLabel(getCurrentWebviewWindow().label);
	}, []);

	// Update state
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const [showUpdateIndicator, setShowUpdateIndicator] = useState(
		() => localStorage.getItem("bloom-show-update-indicator") !== "false"
	);
	const [showUpdatePulse, setShowUpdatePulse] = useState(false);

	useEffect(() => {
		if (windowLabel !== "main") return;

		let unlisten: (() => void) | undefined;
		let disposed = false;

		listen<UpdateCheckResult>("update-available", (event) => {
			setUpdateAvailable(event.payload.available);
			if (!event.payload.available) {
				setShowUpdatePulse(false);
				if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
				return;
			}
			setShowUpdatePulse(true);
			if (notchMode === "peek") triggerEventPeek(6000);
			if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
			updatePulseTimerRef.current = setTimeout(() => {
				setShowUpdatePulse(false);
			}, 6000);
		}).then((fn) => {
			if (disposed) fn();
			else unlisten = fn;
		});

		invoke<UpdateCheckResult>("get_update_state")
			.then((state) => {
				// Only restore a badge; clearing is left to check results so a
				// late mount read cannot race an "update-available" event.
				if (state.available) setUpdateAvailable(true);
			})
			.catch((e) => console.error("Failed to read update state:", e));

		return () => {
			disposed = true;
			unlisten?.();
			if (updatePulseTimerRef.current) clearTimeout(updatePulseTimerRef.current);
		};
	}, [windowLabel, notchMode, triggerEventPeek]);

	// Remote announcement shown as a persistent notch card until dismissed.
	const {
		announcement: remoteAnnouncement,
		dismissed: remoteAnnouncementDismissed,
		dismiss: dismissRemoteAnnouncement
	} = useAnnouncement();

	// Calendar day notes + today's reminder. The reminder reuses the announcement
	// card, so it opens the notch and stays until dismissed.
	const [calendarNotes, setCalendarNotes] = useState(() =>
		parseNoteMap(localStorage.getItem(CALENDAR_NOTES_KEY))
	);
	const [calendarNotesDone, setCalendarNotesDone] = useState(() =>
		parseNoteMap(localStorage.getItem(CALENDAR_NOTES_DONE_KEY))
	);
	const [todayKey, setTodayKey] = useState(() => calendarDateKey(new Date()));
	const [reminder, setReminder] = useState<Announcement | null>(null);
	const reminderKeyRef = useRef<string | null>(null);
	const calendarNotesRef = useRef(calendarNotes);
	calendarNotesRef.current = calendarNotes;
	const calendarNotesDoneRef = useRef(calendarNotesDone);
	calendarNotesDoneRef.current = calendarNotesDone;

	const saveCalendarNote = useCallback((key: string, text: string) => {
		const next = { ...calendarNotesRef.current };
		if (text) next[key] = text;
		else delete next[key];
		calendarNotesRef.current = next;
		setCalendarNotes(next);
		persistNoteMap(CALENDAR_NOTES_KEY, next);
	}, []);

	// Tasks panel state. Every change is saved straight away; the draft lives here
	// (not in the panel) so a half-typed task survives the notch collapsing.
	const [tasks, setTasks] = useState(() => parseTasks(localStorage.getItem(TASKS_KEY)));
	const [taskDraft, setTaskDraft] = useState("");
	const [taskTime, setTaskTime] = useState("");
	// Which column's add row is open (kept here so it survives the notch collapsing).
	const [taskComposer, setTaskComposer] = useState<TaskStatus | null>(null);
	// Width of this window in CSS px. The tasks board sizes itself to it, so it
	// also fits when Bloom is moved to a smaller or differently scaled monitor.
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
	useEffect(() => {
		const onResize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	const [taskReminder, setTaskReminder] = useState<Announcement | null>(null);
	const taskReminderRef = useRef<Announcement | null>(null);
	taskReminderRef.current = taskReminder;
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;
	const tasksSavedAtRef = useRef(0);

	const updateTasks = useCallback((change: (prev: QuickTask[]) => QuickTask[]) => {
		const next = change(tasksRef.current);
		tasksRef.current = next;
		setTasks(next);
		tasksSavedAtRef.current = Date.now();
		const value = JSON.stringify(next);
		localStorage.setItem(TASKS_KEY, value);
		invoke("save_setting", { key: TASKS_KEY, value }).catch(console.error);
	}, []);

	const addTask = useCallback((status: TaskStatus) => {
		const text = taskDraft.trim();
		if (!text || tasksRef.current.length >= TASK_MAX_COUNT) return;
		const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const task: QuickTask = { id, text, done: status === "done", status, priority: 2 };
		const match = /^(\d{1,2}):(\d{2})/.exec(taskTime);
		if (match && status !== "done") {
			// Next occurrence of that clock time: today, or tomorrow if it has passed.
			const when = new Date();
			when.setHours(Number(match[1]), Number(match[2]), 0, 0);
			if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
			task.remindAt = when.getTime();
		}
		updateTasks((prev) => [...prev, task]);
		setTaskDraft("");
		setTaskTime("");
	}, [taskDraft, taskTime, updateTasks]);

	const dismissTaskReminder = useCallback(() => setTaskReminder(null), []);

	// Raise a reminder for the first task whose time has come. A task is marked as
	// notified when its card appears, so it fires once, and one missed while Bloom
	// was closed fires on the next launch.
	useEffect(() => {
		const check = () => {
			if (taskReminderRef.current) return;
			const now = Date.now();
			const due = tasksRef.current.find(
				(t) => !t.done && !t.notified && t.remindAt !== undefined && t.remindAt <= now
			);
			if (!due) return;
			updateTasks((prev) => prev.map((t) => (t.id === due.id ? { ...t, notified: true } : t)));
			setTaskReminder({
				id: `task-${due.id}-${now}`,
				severity: "info",
				title: "Task reminder",
				body: due.text
			});
		};
		check();
		const id = setInterval(check, 5000);
		return () => clearInterval(id);
	}, [updateTasks]);

	const dismissReminder = useCallback(() => {
		const text = calendarNotesRef.current[todayKey];
		if (text) {
			const next = { ...calendarNotesDoneRef.current, [todayKey]: text };
			calendarNotesDoneRef.current = next;
			setCalendarNotesDone(next);
			persistNoteMap(CALENDAR_NOTES_DONE_KEY, next);
		}
		setReminder(null);
	}, [todayKey]);

	// Roll over to the new day while the app keeps running.
	useEffect(() => {
		const id = setInterval(() => {
			const k = calendarDateKey(new Date());
			setTodayKey((prev) => (prev === k ? prev : k));
		}, 30000);
		return () => clearInterval(id);
	}, []);

	// Raise a reminder whenever today's note exists and has not been acknowledged.
	useEffect(() => {
		const text = calendarNotes[todayKey];
		const pendingKey = text && calendarNotesDone[todayKey] !== text ? `${todayKey}|${text}` : null;
		if (!pendingKey) {
			reminderKeyRef.current = null;
			setReminder(null);
			return;
		}
		if (reminderKeyRef.current === pendingKey) return;
		reminderKeyRef.current = pendingKey;
		const label = new Date().toLocaleDateString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric"
		});
		setReminder({
			id: `calendar-note-${pendingKey}-${Date.now()}`,
			severity: "info",
			title: `Reminder · ${label}`,
			body: text
		});
	}, [calendarNotes, calendarNotesDone, todayKey]);

	const localReminder = reminder ?? taskReminder;
	const announcement = localReminder ?? remoteAnnouncement;
	const announcementDismissed = localReminder ? false : remoteAnnouncementDismissed;
	// Task and calendar reminders (not remote announcements) throb red until dismissed.
	const isReminderAnnouncement =
		!!announcement &&
		(announcement.id.startsWith("task-") || announcement.id.startsWith("calendar-note-"));
	// The Pomodoro "time is up" card gets its own floppy-disk look (see .pomo-alert in App.css).
	const isPomoAlert = !!announcement && announcement.id.startsWith("task-pomodoro-");
	const dismissAnnouncement = reminder
		? dismissReminder
		: taskReminder
			? dismissTaskReminder
			: dismissRemoteAnnouncement;
	const announcementShownRef = useRef<string | null>(null);
	const announcementOpen = !!announcement && !announcementDismissed;
	const announcementOpenRef = useRef(false);
	announcementOpenRef.current = announcementOpen;

	const [isVisible, setIsVisible] = useState(true);
	const [isImpacted, setIsImpacted] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [startupAnimating, setStartupAnimating] = useState(false);

	const [dockMode, setDockMode] = useState(() => {
		const raw = localStorage.getItem("bloom-dock-mode") || "smart";
		if (raw === "auto-hide") return "smart";
		return raw;
	});
	const [dndActive, setDndActive] = useState(false);
	const [dockEnabled, setDockEnabled] = useState(
		() => localStorage.getItem("bloom-dock-enabled") !== "false"
	);
	const [isNotchHovered, setIsNotchHovered] = useState(false);

	const [isEdgeHovered, setIsEdgeHovered] = useState(false);
	const [isOverlapped, setIsOverlapped] = useState(false);
	const [interactionState, setInteractionState] = useState<"active" | "grace" | "none">("none");
	const bloomRef = useRef<HTMLDivElement>(null);
	const dockEnabledInitial = useRef(true);
	const dockModeInitial = useRef(true);
	const sidebarInitial = useRef({ enabled: true, mode: true, side: true });
	const [sidebarEnabled, setSidebarEnabled] = useState(
		() => localStorage.getItem("bloom-sidebar-enabled") === "true"
	);
	const [sidebarMode, setSidebarMode] = useState(
		() => localStorage.getItem("bloom-sidebar-mode") || "smart"
	);
	const [sidebarSide, setSidebarSide] = useState(
		() => localStorage.getItem("bloom-sidebar-side") || "left"
	);
	const notchModeInitial = useRef(true);

	// Side bar on: the notch has no pill. At rest it is out of sight above the screen; reaching the
	// top edge drops it in and it grows open as usual, leaving closes it again. The backend is told
	// "peek" meanwhile so the notch reserves no band at the top. Settings keep the saved notch mode.
	const sbStrip = sidebarEnabled;
	// Closing slide: the notch keeps its open size while it slides back up, then collapses unseen.
	const [sbLeaving, setSbLeaving] = useState(false);
	const sbClosingRef = useRef<number | null>(null);
	const sbCancelRef = useRef<() => void>(() => {});
	const notchModeEff = sbStrip ? "peek" : notchMode;

	const isAnyInteraction = isHovered || isNotchHovered || isEdgeHovered;
	// The wallpaper panel (Alt+A) stays on screen in smart/peek mode too. Mirrors bloomMode, which is
	// declared further down, so it can be used here.
	const [wallpaperOpen, setWallpaperOpen] = useState(false);
	// Same idea for the announcement card: with the side bar on it is the one thing that may show
	// without a hover (a reminder must not be missed).
	const [announceOpen, setAnnounceOpen] = useState(false);
	// Side bar on: out of sight unless the notch is open (hovered), peeking for an event or the wallpaper panel.
	// The notch stays drawn while it shrinks back into the strip, then disappears. This covers every way
	// it can close (pointer leaving, Alt+A, an announcement ending), not just a hover release.
	const sbShown = sbStrip && ((isHovered && !sbLeaving) || wallpaperOpen || announceOpen);
	const [sbGone, setSbGone] = useState(true);
	// While it shrinks, the content is clipped to the notch; once it is mostly closed it is hidden, so no
	// piece of it (tab row, panel) is left drawn outside the small notch.
	const [sbContentHidden, setSbContentHidden] = useState(false);
	// The concave corner pads (.bloom::before / ::after) only exist once the notch has landed under
	// the strip, then grow out of the strip's underside. Gone at once when it starts to close.
	const [sbLanded, setSbLanded] = useState(false);
	// Experimental: keep the dashboard mounted. With the side bar on, the dashboard is built once, right after
	// startup, and then stays mounted, hidden with the rest of the notch while it is closed, so opening never
	// has to build it. Off (the default), it is built when the notch opens and dropped when it closes.
	// Costs some memory for its DOM and a few small timers (the clock), and its stats are only refreshed while
	// the notch is open (the polling is still tied to perfVisible), so they can be a moment old on open.
	const [settingsDashKeepAlive, setSettingsDashKeepAlive] = useState(
		() => localStorage.getItem("bloom-experimental-dash-keepalive") === "true"
	);
	// The slide itself starts a couple of frames after the notch is made visible. Making it visible is the
	// expensive part (the browser has to build and draw the notch's layer for the first time, which is slow
	// after an idle), so it is done while the notch is still out of sight, and the slide then starts on a
	// frame that is already cheap. Without this the first frames of the slide drop, or it jumps to the end.
	const [sbGo, setSbGo] = useState(false);
	useEffect(() => {
		if (!sbStrip) return;
		if (sbShown) {
			setSbGone(false);
			setSbContentHidden(false);
			let tl = 0;
			const r1 = requestAnimationFrame(() => {
				r2 = requestAnimationFrame(() => {
					setSbGo(true);
					tl = window.setTimeout(() => setSbLanded(true), SB_PAD_DELAY_MS);
				});
			});
			let r2 = 0;
			return () => {
				cancelAnimationFrame(r1);
				cancelAnimationFrame(r2);
				window.clearTimeout(tl);
			};
		}
		setSbLanded(false);
		setSbGo(false);
		const t = window.setTimeout(() => setSbGone(true), SB_CLOSE_MS);
		const t2 = window.setTimeout(() => {
			setSbContentHidden(true);
		}, SB_CLOSE_MS);
		return () => {
			window.clearTimeout(t);
			window.clearTimeout(t2);
		};
	}, [sbStrip, sbShown]);
	// Where the notch rests when shown: just under the thin strip (8px, drawn by the frame window), so
	// the two never overlap. No strip in the side bar's Peek mode.
	// Last open size. Kept while the notch is out above the screen so opening and closing only move it
	// (no width/height spring, so the panels are not laid out again on every frame of the slide).
	const sbSize = useRef({ w: 300, h: 120 });
	// Tune the slide here. Open: spring (lower damping = more bounce, lower stiffness = slower).
	// Close: seconds. SB_CLOSE_MS must be longer than SB_CLOSE_S, with room to spare: the content is hidden
	// and reset when it runs out, which must never happen while the slide is still on screen.
	const SB_OPEN_SPRING = { type: "spring", stiffness: 340, damping: 28, mass: 1 } as const;
	const SB_CLOSE_S = 0.18;
	const SB_CLOSE_MS = 240;
	// How long after the open starts the pads appear (about when the notch first reaches its rest
	// position). The pad grow time itself is --sb-pad-grow in SidebarNotch.css.
	const SB_PAD_DELAY_MS = 170;
	// What the notch loses in side bar mode: the 36px status row, less the 8px of room left above each
	// panel (SidebarNotch.css puts the panels at top: 8px instead of 36px).
	const SB_BAR_H = 28;
	const sbTop = sidebarMode === "peek" ? 0 : 11 / scale;
	// The pads ride on the notch, so they would bounce with it and open a gap under the strip. Mirror the
	// notch's y into --sb-dy (rest position minus current y) and let the pads cancel it out.
	const sbY = useMotionValue(250);
	const sbTopRef = useRef(sbTop);
	sbTopRef.current = sbTop;
	const sbBridgeRef = useRef<HTMLDivElement>(null);
	// What was last written to the notch, so a frame that changes nothing writes nothing.
	const sbLast = useRef({ dy: NaN, up: NaN, g: NaN });
	useEffect(() => {
		const apply = (v: number) => {
			const el = bloomRef.current;
			if (!el) return;
			// Far above the rest spot (most of the slide) nothing is joined to the strip yet, so the notch is
			// not restyled at all; the values are written once it is within 60px of where it lands.
			if (v < sbTopRef.current - 60) return;
			const dy = Math.round((sbTopRef.current - v) * 10) / 10;
			const up = Math.round(Math.max(0, v - sbTopRef.current) * 10) / 10;
			if (dy !== sbLast.current.dy) {
				sbLast.current.dy = dy;
				el.style.setProperty("--sb-dy", `${dy}px`);
			}
			// Overshoot: how far the notch has sunk below its rest spot. CSS stretches its top up by this much.
			if (up !== sbLast.current.up) {
				sbLast.current.up = up;
				el.style.setProperty("--sb-up", `${up}px`);
			}
			// Bridge: a band of the notch colour that reaches from the notch's top edge up to the strip's underside,
			// so the overshoot of the spring can never show a gap. Its height is the current overshoot plus 1px
			// tucked under the strip (no hairline). Sized here, per frame, from the same value as the notch.
			const bridge = sbBridgeRef.current;
			if (bridge) {
				const g = Math.min(40, up) + 1;
				if (g !== sbLast.current.g) {
					sbLast.current.g = g;
					bridge.style.height = `${g}px`;
					bridge.style.top = `${-g}px`;
				}
			}
		};
		apply(sbY.get());
		return sbY.on("change", apply);
	}, [sbY]);
	// Tell the frame window where the notch is. The frame is drawn over the notch window, so its top line would run
	// across the notch (and cut through it while it slides down). The frame leaves a gap in that line over this span,
	// in screen px (this window's position plus the notch's rectangle). p is how far the concave pads reach out on
	// each side, once they have grown: 13px of the zoomed notch, so 13 * scale on the screen. Sent while the notch is out, and when it changes; null once it is gone.
	useEffect(() => {
		if (windowLabel !== "main") return;
		const win = getCurrentWebviewWindow();
		const out = sbStrip && (sbShown || !sbGone);
		let alive = true;
		// Unknown at first, so the first send always goes out: that is what clears the gap again once the notch is gone
		// (or the side bar is turned off). Starting from "" skipped that send and left the gap in the strip.
		let last = "?";
		const send = async () => {
			try {
				let span: { l: number; r: number; p: number } | null = null;
				if (out) {
					const r = bloomRef.current?.getBoundingClientRect();
					if (r && r.width > 0) {
						const [o, sf] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
						span = {
							l: Math.round(o.x / sf + r.left),
							r: Math.round(o.x / sf + r.right),
							p: sbLanded && sbShown ? Math.round(13 * scale) : 0
						};
					}
				}
				const key = span ? `${span.l}:${span.r}:${span.p}` : "";
				if (!alive || key === last) return;
				last = key;
				emit("sidebar-notch-span", span).catch(() => {});
			} catch {
				// no window position: the frame keeps its full line
			}
		};
		send();
		if (!out) return () => { alive = false; };
		const id = window.setInterval(send, 80);
		return () => {
			alive = false;
			window.clearInterval(id);
		};
	}, [windowLabel, sbStrip, sbShown, sbGone, sbLanded, scale]);
	const isHidden = sbStrip
		? !wallpaperOpen && !announceOpen && !isHovered
		: !startupAnimating &&
			!wallpaperOpen &&
			((notchMode === "smart" && isOverlapped && interactionState === "none") ||
				(notchMode === "peek" && interactionState === "none" && !eventPeek));

	useEffect(() => {
		if (isAnyInteraction) {
			setInteractionState("active");
		} else if (interactionState !== "none") {
			setInteractionState("grace");
			const timer = setTimeout(() => setInteractionState("none"), 800);
			return () => clearTimeout(timer);
		}
	}, [isAnyInteraction]);

	useEffect(() => {
		if (windowLabel === "main") {
			invoke("set_notch_hovered", { hovered: isNotchHovered }).catch(() => {});
		}
	}, [isNotchHovered, windowLabel]);

	// Tell the backend whether the notch is actually on screen so a hidden
	// notch (smart/peek mode) stays click-through instead of swallowing clicks
	// in its footprint.
	useEffect(() => {
		if (windowLabel === "main") {
			invoke("set_notch_visible", { visible: isVisible && !isHidden }).catch(() => {});
		}
	}, [isVisible, isHidden, windowLabel]);

	useEffect(() => {
		const updateRect = () => {
			if (bloomRef.current && windowLabel === "main") {
				const rect = bloomRef.current.getBoundingClientRect();
				invoke("update_notch_rect", {
					rect: {
						x: Math.round(rect.x),
						y: Math.round(rect.y),
						width: Math.round(rect.width),
						height: Math.round(rect.height)
					}
				}).catch(() => {});
			}
		};

		updateRect();
		window.addEventListener("resize", updateRect);
		const observer = new ResizeObserver(updateRect);
		if (bloomRef.current) observer.observe(bloomRef.current);

		return () => {
			window.removeEventListener("resize", updateRect);
			observer.disconnect();
		};
	}, [isExpanded, isHidden, windowLabel, scale]);

	useEffect(() => {
		if (!windowLabel) return;

		// Only animate the main top-bar
		if (windowLabel !== "main") {
			setIsReady(true);
			setIsImpacted(true);
			setIsExpanded(true);
			return;
		}

		const proceedWithStartup = () => {
			const checkVisibility = async () => {
				try {
					const win = getCurrentWebviewWindow();
					const visible = await win.isVisible();
					if (visible) {
						setStartupAnimating(true);
						setIsReady(true);
						setTimeout(() => {
							setIsImpacted(true);
							setIsExpanded(true);
						}, 240);
						setTimeout(() => setStartupAnimating(false), 1500);
						return true;
					}
				} catch (e) {}
				return false;
			};

			const interval = setInterval(async () => {
				if (await checkVisibility()) clearInterval(interval);
			}, 100);

			checkVisibility();
			return interval;
		};

		// Mirror Overlay.tsx's splash decision so we only wait when a splash will actually fire.
		// Overlay always emits splash-done, but on a normal relaunch it emits it near-instantly
		// (after one async getVersion() call) — before this listener would be registered.
		// By making the same decision here we avoid a race and avoid any unnecessary delay.
		const firstRun = localStorage.getItem("bloom-first-run") === null;
		const storedVersion = localStorage.getItem("bloom-app-version");

		const waitForSplash = () => {
			// Splash is definitely coming — register listener now (2800ms animation gives us plenty of time)
			let started = false;
			let interval: any;
			const unlistenSplash = listen("splash-done", () => {
				if (started) return;
				started = true;
				interval = proceedWithStartup();
				unlistenSplash.then((fn) => fn());
			});
			const safetyTimer = setTimeout(() => {
				if (started) return;
				started = true;
				interval = proceedWithStartup();
				unlistenSplash.then((fn) => fn());
			}, 6000);
			return () => {
				clearTimeout(safetyTimer);
				if (interval) clearInterval(interval);
				unlistenSplash.then((fn) => fn());
			};
		};

		if (firstRun || storedVersion === null) {
			// Splash is definitely showing — wait for it
			return waitForSplash();
		}

		// Has a version key — need async check to know if version changed
		let interval: any;
		getVersion()
			.then((currentVersion) => {
				if (storedVersion !== currentVersion) {
					// Version changed — splash is coming, wait for it
					// (splash takes 2800ms so there's plenty of time to register the listener)
					waitForSplash();
				} else {
					// Same version — no splash, start immediately
					interval = proceedWithStartup();
				}
			})
			.catch(() => {
				interval = proceedWithStartup();
			});
		return () => {
			if (interval) clearInterval(interval);
		};
	}, [windowLabel]);

	// Settings state
	const [settingsWeatherEnabled, setSettingsWeatherEnabled] = useState(
		() => localStorage.getItem("bloom-weather-enabled") !== "false"
	);
	const [settingsTimerSoundEnabled, setSettingsTimerSoundEnabled] = useState(
		() => localStorage.getItem("bloom-timer-sound-enabled") !== "false"
	);
	const [settingsTimerVolume, setSettingsTimerVolume] = useState(() => {
		const v = parseInt(localStorage.getItem("bloom-timer-volume") ?? "", 10);
		return Number.isFinite(v) ? v : DEFAULT_TIMER_VOLUME;
	});
	const [settingsTimerSoundFile, setSettingsTimerSoundFile] = useState(
		() => localStorage.getItem("bloom-timer-sound-file") || NO_CUSTOM_SOUND
	);
	const [settingsReminderSoundEnabled, setSettingsReminderSoundEnabled] = useState(
		() => localStorage.getItem("bloom-reminder-sound-enabled") !== "false"
	);
	const [settingsReminderVolume, setSettingsReminderVolume] = useState(() => {
		const v = parseInt(localStorage.getItem("bloom-reminder-volume") ?? "", 10);
		return Number.isFinite(v) ? v : DEFAULT_REMINDER_VOLUME;
	});
	const [settingsTaskSoundFile, setSettingsTaskSoundFile] = useState(
		() => localStorage.getItem("bloom-task-sound-file") || NO_CUSTOM_SOUND
	);
	const [settingsCalendarSoundFile, setSettingsCalendarSoundFile] = useState(
		() => localStorage.getItem("bloom-calendar-sound-file") || NO_CUSTOM_SOUND
	);
	const [settingsCompleteSoundFile, setSettingsCompleteSoundFile] = useState(
		() => localStorage.getItem("bloom-complete-sound-file") || NO_CUSTOM_SOUND
	);
	const [settingsSnapSoundFile, setSettingsSnapSoundFile] = useState(
		() => localStorage.getItem("bloom-snap-sound-file") || NO_CUSTOM_SOUND
	);
	const [settingsMusicModeEnabled, setSettingsMusicModeEnabled] = useState(
		() => localStorage.getItem("bloom-music-mode-enabled") !== "false"
	);
	const [settingsMusicCompactNotch, setSettingsMusicCompactNotch] = useState(
		() => localStorage.getItem("bloom-music-compact-notch") !== "false"
	);
	const [settingsVisualizerEnabled, setSettingsVisualizerEnabled] = useState(
		() => localStorage.getItem("bloom-visualizer-enabled") !== "false"
	);
	const [settingsAlbumArtEnabled, setSettingsAlbumArtEnabled] = useState(
		() => localStorage.getItem("bloom-media-album-art-enabled") !== "false"
	);
	const [settingsAmbienceEnabled, setSettingsAmbienceEnabled] = useState(
		() => localStorage.getItem("bloom-media-ambience-enabled") !== "false"
	);
	const [settingsCompactGlowEnabled, setSettingsCompactGlowEnabled] = useState(
		() => localStorage.getItem("bloom-media-compact-glow-enabled") !== "false"
	);
	// Smooth open: while this is on, MediaTab.tsx mounts the backdrop and waveform a moment after
	// the Media tab opens so the open animation does not stutter. Off draws them straight away.
	const [settingsSmoothOpen, setSettingsSmoothOpen] = useState(
		() => localStorage.getItem("bloom-media-smooth-open") !== "false"
	);
	useEffect(() => {
		document.documentElement.dataset.mtDeferDecor = settingsSmoothOpen ? "on" : "off";
	}, [settingsSmoothOpen]);
	// Which floppy disk is drawn: "1" is the clear black one, "2" the yellow one. Mirrored onto the root
	// element, like smooth open, for useDiskVariant.ts (the Now Playing card and the Media tab each
	// have their own). The defaults are what they looked like before: black on the card, yellow on the tab.
	const [settingsDashDisk, setSettingsDashDisk] = useState(() =>
		localStorage.getItem("bloom-dash-disk-variant") === "2" ? "2" : "1"
	);
	const [settingsMediaDisk, setSettingsMediaDisk] = useState(() =>
		localStorage.getItem("bloom-media-disk-variant") === "1" ? "1" : "2"
	);
	useEffect(() => {
		document.documentElement.dataset.dashDisk = settingsDashDisk;
	}, [settingsDashDisk]);
	useEffect(() => {
		document.documentElement.dataset.mtDisk = settingsMediaDisk;
	}, [settingsMediaDisk]);
	const [settingsCornersEnabled, setSettingsCornersEnabled] = useState(
		() => localStorage.getItem("bloom-corners-enabled") === "true"
	);
	const [mediaLayout, setMediaLayout] = useState<"classic" | "compact">(
		() => (localStorage.getItem("bloom-media-layout") as "classic" | "compact") || "classic"
	);
	const [compactVolumeExpanded, setCompactVolumeExpanded] = useState(false);

	// Weather hook
	const {
		temperature,
		tempHigh,
		tempLow,
		weatherCondition,
		weatherIcon: WeatherIcon,
		cityName,
		tempUnit
	} = useWeather(settingsWeatherEnabled);

	useEffect(() => {
		if (!windowLabel) return;

		invoke("load_settings")
			.then(async (settings: any) => {
				if (await reloadIfMirrorWasStale(settings)) return;
				const getVal = (key: string, fallback: string | null = null) => {
					const val = settings[key];
					if (val !== undefined && val !== null) return String(val);
					const local = localStorage.getItem(key);
					if (local !== null) return local;
					return fallback;
				};

				setSettingsWeatherEnabled(getVal("bloom-weather-enabled", "true") !== "false");
				setCalendarNotes(parseNoteMap(getVal(CALENDAR_NOTES_KEY, "")));
				setCalendarNotesDone(parseNoteMap(getVal(CALENDAR_NOTES_DONE_KEY, "")));
				setTasks(parseTasks(getVal(TASKS_KEY, "")));
				const loadedDrive = String(getVal(PERF_DRIVE_KEY, "") || "C");
				perfDriveRef.current = loadedDrive;
				setPerfDrive(loadedDrive);
				const loadedPomo = parsePomo(getVal(POMO_KEY, ""));
				setPomoDurations(loadedPomo);
				setPomo((s) =>
					!s.running && s.phase === "focus" && s.rounds === 0
						? { ...s, remainingMs: loadedPomo.focus * 60_000 }
						: s
				);
				setSettingsTimerSoundEnabled(getVal("bloom-timer-sound-enabled", "true") !== "false");
				const loadedVolume = parseInt(String(getVal("bloom-timer-volume", "")), 10);
				setSettingsTimerVolume(Number.isFinite(loadedVolume) ? loadedVolume : DEFAULT_TIMER_VOLUME);
				setSettingsTimerSoundFile(String(getVal("bloom-timer-sound-file", "") || NO_CUSTOM_SOUND));
				setSettingsReminderSoundEnabled(getVal("bloom-reminder-sound-enabled", "true") !== "false");
				const loadedReminderVolume = parseInt(String(getVal("bloom-reminder-volume", "")), 10);
				setSettingsReminderVolume(
					Number.isFinite(loadedReminderVolume) ? loadedReminderVolume : DEFAULT_REMINDER_VOLUME
				);
				setSettingsTaskSoundFile(String(getVal("bloom-task-sound-file", "") || NO_CUSTOM_SOUND));
				setSettingsCalendarSoundFile(
					String(getVal("bloom-calendar-sound-file", "") || NO_CUSTOM_SOUND)
				);
				setSettingsCompleteSoundFile(
					String(getVal("bloom-complete-sound-file", "") || NO_CUSTOM_SOUND)
				);
				setSettingsSnapSoundFile(String(getVal("bloom-snap-sound-file", "") || NO_CUSTOM_SOUND));
				setSettingsMusicModeEnabled(getVal("bloom-music-mode-enabled", "true") !== "false");
				setSettingsMusicCompactNotch(getVal("bloom-music-compact-notch", "true") !== "false");
				const viz =
					getVal("bloom-media-visualizer-enabled") ?? getVal("bloom-visualizer-enabled", "true");
				setSettingsVisualizerEnabled(viz !== "false");
				setSettingsAlbumArtEnabled(getVal("bloom-media-album-art-enabled", "true") !== "false");
				setSettingsAmbienceEnabled(getVal("bloom-media-ambience-enabled", "true") !== "false");
				setSettingsSmoothOpen(getVal("bloom-media-smooth-open", "true") !== "false");
				setSettingsDashDisk(String(getVal("bloom-dash-disk-variant", "1")) === "2" ? "2" : "1");
				setSettingsMediaDisk(String(getVal("bloom-media-disk-variant", "2")) === "1" ? "1" : "2");
				setSettingsCompactGlowEnabled(
					getVal("bloom-media-compact-glow-enabled", "true") !== "false"
				);
				setSettingsCornersEnabled(getVal("bloom-corners-enabled", "false") === "true");
				setSettingsDashKeepAlive(getVal("bloom-experimental-dash-keepalive", "false") === "true");
				setTimeFormat24h(getVal("bloom-time-format-24h") === "true");

				const thresholdStr = getVal("bloom-low-battery-threshold", "20");
				if (thresholdStr) setLowBatteryThreshold(parseInt(thresholdStr as string));

				const nMode = getVal("bloom-notch-mode", "fixed");
				if (nMode) {
					const mapped = nMode === "auto-hide" ? "smart" : nMode;
					setNotchMode(mapped);
				}

				if (windowLabel === "main") {
					const firstRun = localStorage.getItem("bloom-first-run") === null;
					if (firstRun) {
						import("@tauri-apps/plugin-autostart").then(({ enable, isEnabled }) => {
							isEnabled().then((enabled) => {
								if (!enabled) enable().catch(() => {});
							});
						});
						localStorage.setItem("bloom-first-run", "done");
					}
					const rawDockMode = getVal("bloom-dock-mode", "smart") as string;
					const dockMode = rawDockMode === "auto-hide" ? "smart" : rawDockMode;
					const syncWindows = async () => {
						const dockEnabled = getVal("bloom-dock-enabled", "true") === "true";
						if (dockEnabled) {
							await invoke("init_dock", { mode: dockMode });
						}
						if (getVal("bloom-sidebar-enabled", "false") === "true") {
							await invoke("init_sidebar", {
								mode: getVal("bloom-sidebar-mode", "smart") as string
							});
						}
						const sbOn = getVal("bloom-sidebar-enabled", "false") === "true";
						await invoke("change_notch_mode", { mode: sbOn ? "peek" : nMode });
						await invoke("sync_appbar");
					};

					const dockEnabled = getVal("bloom-dock-enabled", "true") === "true";
					const runDockInit = () => {
						// 1. Snappy initial sync
						setTimeout(syncWindows, 400);
						// 2. Safety-net dock retry
						if (dockEnabled) {
							setTimeout(() => invoke("init_dock", { mode: dockMode }).catch(() => {}), 1500);
						}
						// 3. Layout corrections
						setTimeout(() => invoke("sync_appbar"), 1000);
						setTimeout(() => invoke("sync_appbar"), 2500);
						setTimeout(() => invoke("sync_appbar"), 5000);
					};

					// Mirror Overlay.tsx's splash decision for dock init too — only wait when
					// a splash is actually coming, otherwise init immediately.
					const runDockInitAfterSplash = () => {
						let dockStarted = false;
						const unlistenDock = listen("splash-done", () => {
							if (dockStarted) return;
							dockStarted = true;
							runDockInit();
							unlistenDock.then((fn) => fn());
						});
						setTimeout(() => {
							if (dockStarted) return;
							dockStarted = true;
							runDockInit();
							unlistenDock.then((fn) => fn());
						}, 6000);
					};

					const storedVersion = localStorage.getItem("bloom-app-version");
					if (firstRun || storedVersion === null) {
						runDockInitAfterSplash();
					} else {
						getVersion()
							.then((currentVersion) => {
								if (storedVersion !== currentVersion) {
									runDockInitAfterSplash();
								} else {
									runDockInit();
								}
							})
							.catch(() => runDockInit());
					}
				}

				const scaleVal = getVal("bloom-scale");
				if (scaleVal !== null) setScale(parseFloat(scaleVal));

				const widgetsVal = getVal("bloom-status-widgets");
				if (widgetsVal) {
					try {
						const parsed = JSON.parse(widgetsVal);
						if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
							setStatusWidgets(parsed);
						}
					} catch {}
				}
			})
			.catch(console.error);
	}, [windowLabel]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		// Disable context menu globally
		const preventContext = (e: MouseEvent) => e.preventDefault();
		document.addEventListener("contextmenu", preventContext);

		const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
			setIsVisible(event.payload);
		});

		const unlistenNotchOverlap = listen<boolean>("notch-overlap", (event) => {
			setIsOverlapped(event.payload);
		});

		const unlistenNotchEdgeHover = listen<boolean>("notch-edge-hover", (event) => {
			setIsEdgeHovered(event.payload);
		});

		return () => {
			unlistenVisibility.then((f) => f());
			unlistenNotchOverlap.then((f) => f());
			unlistenNotchEdgeHover.then((f) => f());
			document.removeEventListener("contextmenu", preventContext);
		};
	}, [windowLabel]);

	// Settings sync — consolidated dispatch for all settings events
	useSettingsSync(
		{
			"bloom-weather-enabled": setSettingsWeatherEnabled,
			[CALENDAR_NOTES_KEY]: (value) => setCalendarNotes(parseNoteMap(value)),
			[CALENDAR_NOTES_DONE_KEY]: (value) => setCalendarNotesDone(parseNoteMap(value)),
			[TASKS_KEY]: (value) => {
				// Ignore echoes of our own saves.
				if (Date.now() - tasksSavedAtRef.current < 1500) return;
				setTasks(parseTasks(value));
			},
			[PERF_DRIVE_KEY]: (value) => {
				const drive = String(value || "C");
				perfDriveRef.current = drive;
				setPerfDrive(drive);
			},
			"bloom-timer-sound-enabled": setSettingsTimerSoundEnabled,
			"bloom-timer-volume": (value) => {
				const n = Number(value);
				if (Number.isFinite(n)) setSettingsTimerVolume(n);
			},
			"bloom-timer-sound-file": (value) => {
				clearCustomTimerSoundCache();
				setSettingsTimerSoundFile(typeof value === "string" ? value : NO_CUSTOM_SOUND);
			},
			"bloom-reminder-sound-enabled": setSettingsReminderSoundEnabled,
			"bloom-reminder-volume": (value) => {
				const n = Number(value);
				if (Number.isFinite(n)) setSettingsReminderVolume(n);
			},
			"bloom-task-sound-file": (value) => {
				clearCustomReminderSoundCache("task");
				setSettingsTaskSoundFile(typeof value === "string" ? value : NO_CUSTOM_SOUND);
			},
			"bloom-calendar-sound-file": (value) => {
				clearCustomReminderSoundCache("calendar");
				setSettingsCalendarSoundFile(typeof value === "string" ? value : NO_CUSTOM_SOUND);
			},
			"bloom-complete-sound-file": (value) => {
				clearCustomReminderSoundCache("complete");
				setSettingsCompleteSoundFile(typeof value === "string" ? value : NO_CUSTOM_SOUND);
			},
			"bloom-snap-sound-file": (value) => {
				clearCustomReminderSoundCache("snap");
				setSettingsSnapSoundFile(typeof value === "string" ? value : NO_CUSTOM_SOUND);
			},
			"bloom-music-mode-enabled": setSettingsMusicModeEnabled,
			"bloom-music-compact-notch": setSettingsMusicCompactNotch,
			"bloom-media-visualizer-enabled": setSettingsVisualizerEnabled,
			"bloom-visualizer-enabled": setSettingsVisualizerEnabled,
			"bloom-media-album-art-enabled": setSettingsAlbumArtEnabled,
			"bloom-media-ambience-enabled": setSettingsAmbienceEnabled,
			"bloom-media-smooth-open": setSettingsSmoothOpen,
			"bloom-dash-disk-variant": (value) => setSettingsDashDisk(String(value) === "2" ? "2" : "1"),
			"bloom-media-disk-variant": (value) => setSettingsMediaDisk(String(value) === "1" ? "1" : "2"),
			"bloom-media-compact-glow-enabled": setSettingsCompactGlowEnabled,
			"bloom-media-layout": setMediaLayout,
			"bloom-corners-enabled": setSettingsCornersEnabled,
			"bloom-experimental-dash-keepalive": (v) => setSettingsDashKeepAlive(String(v) === "true"),
			"bloom-scale": setScale,
			"bloom-low-battery-threshold": setLowBatteryThreshold,
			"bloom-dock-enabled": setDockEnabled,
			"bloom-dock-mode": setDockMode,
			"bloom-sidebar-enabled": (v) => setSidebarEnabled(String(v) === "true"),
			"bloom-sidebar-mode": setSidebarMode,
			"bloom-sidebar-side": setSidebarSide,
			"bloom-notch-mode": setNotchMode,
			"bloom-status-widgets": (value) => {
				try {
					const parsed = JSON.parse(value);
					if (parsed && Array.isArray(parsed.left) && Array.isArray(parsed.right)) {
						setStatusWidgets(parsed);
					}
				} catch {}
			},
			"bloom-show-update-indicator": (value) => setShowUpdateIndicator(String(value) === "true"),
			"bloom-time-format-24h": setTimeFormat24h
		},
		[windowLabel]
	);

	// Side effects: dock-enabled (skip first render — startup code handles initial state)
	useEffect(() => {
		if (windowLabel !== "main") return;
		if (dockEnabledInitial.current) {
			dockEnabledInitial.current = false;
			return;
		}
		if (dockEnabled) {
			invoke("init_dock", { mode: localStorage.getItem("bloom-dock-mode") || "smart" });
		} else {
			invoke("toggle_dock", { enable: false });
		}
		setTimeout(() => invoke("sync_appbar"), 200);
	}, [dockEnabled, windowLabel]);

	// Side effects: sidebar enabled / mode / side (skip first render each)
	useEffect(() => {
		if (windowLabel !== "main") return;
		if (sidebarInitial.current.enabled) {
			sidebarInitial.current.enabled = false;
			return;
		}
		invoke("toggle_sidebar", { enable: sidebarEnabled });
		setTimeout(() => invoke("sync_appbar"), 200);
	}, [sidebarEnabled, windowLabel]);

	useEffect(() => {
		if (windowLabel !== "main") return;
		if (sidebarInitial.current.mode) {
			sidebarInitial.current.mode = false;
			return;
		}
		invoke("change_sidebar_mode", { mode: sidebarMode });
		setTimeout(() => invoke("sync_appbar"), 200);
	}, [sidebarMode, windowLabel]);

	useEffect(() => {
		if (windowLabel !== "main") return;
		if (sidebarInitial.current.side) {
			sidebarInitial.current.side = false;
			return;
		}
		invoke("sidebar_set_side");
	}, [sidebarSide, windowLabel]);

	// Side effects: dock-mode (skip first render)
	useEffect(() => {
		if (windowLabel !== "main") return;
		if (dockModeInitial.current) {
			dockModeInitial.current = false;
			return;
		}
		invoke("change_dock_mode", { mode: dockMode });
		setTimeout(() => invoke("sync_appbar"), 200);
	}, [dockMode, windowLabel]);

	// Side effects: notch-mode (skip first render)
	useEffect(() => {
		if (windowLabel !== "main") return;
		if (notchModeInitial.current) {
			notchModeInitial.current = false;
			return;
		}
		invoke("change_notch_mode", { mode: notchModeEff });
		setTimeout(() => invoke("sync_appbar"), 200);
	}, [notchModeEff, windowLabel]);

	// Bloom mode state: 'music', 'tasks', 'command-center', 'announcement', or 'status'
	const [bloomMode, setBloomMode] = useState<
		| "music"
		| "tasks"
		| "pomodoro"
		| "command-center"
		| "announcement"
		| "status"
		| "wifi"
		| "bluetooth"
		| "wallpaper"
	>("status");

	useEffect(() => {
		setAnnounceOpen(bloomMode === "announcement");
	}, [bloomMode]);

	// Wallpaper panel: its own notch panel (not a tab, not in the scroll cycle). The global hotkey
	// (Alt+A by default, see wallpaper.rs) toggles it from anywhere.
	useEffect(() => {
		setWallpaperOpen(bloomMode === "wallpaper");
		if (bloomMode !== "wallpaper" || windowLabel !== "main") return;
		// Needed for the arrow keys / Enter / Esc to reach the panel. Windows can refuse a focus request made while
		// another app is in front (the hotkey is pressed from anywhere), and one refused request used to be the only
		// try, so the keys did nothing until the panel was clicked. Ask again, a few times over the first second,
		// until the page really has focus.
		const win = getCurrentWebviewWindow();
		const delays = [0, 40, 100, 200, 350, 550, 800, 1200]; // ms after opening
		let timer: number | undefined;
		let cancelled = false;
		const attempt = (i: number) => {
			if (cancelled) return;
			if (i > 0 && document.hasFocus()) return; // got it
			win.setFocus().catch(() => {});
			if (i + 1 < delays.length) timer = window.setTimeout(() => attempt(i + 1), delays[i + 1] - delays[i]);
		};
		attempt(0);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [bloomMode, windowLabel]);
	const closeWallpaper = useCallback(() => {
		setBloomMode((m) => (m === "wallpaper" ? "status" : m));
	}, []);
	// The wallpaper hotkey (Alt+A) is global, so Windows keeps the A for itself and the window in front only sees a lone
	// tap of Alt (down, up). When that window is Bloom, which it is after the panel was used once, Windows switches it
	// into menu mode: arrow keys and Esc then go to the window menu instead of the page until something is clicked.
	// Marking the bare Alt key as handled stops that. Other Alt combinations are untouched.
	useEffect(() => {
		const swallowBareAlt = (e: KeyboardEvent) => {
			if (e.key === "Alt") e.preventDefault();
		};
		window.addEventListener("keydown", swallowBareAlt, true);
		window.addEventListener("keyup", swallowBareAlt, true);
		return () => {
			window.removeEventListener("keydown", swallowBareAlt, true);
			window.removeEventListener("keyup", swallowBareAlt, true);
		};
	}, []);
	useEffect(() => {
		if (windowLabel !== "main") return;
		let unlisten: (() => void) | undefined;
		let unlistenErr: (() => void) | undefined;
		let disposed = false;
		listen("wallpaper-hotkey", () => {
			manualMusicRef.current = false;
			setBloomMode((m) => (m === "wallpaper" ? "status" : "wallpaper"));
		}).then((fn) => {
			if (disposed) fn();
			else unlisten = fn;
		});
		listen<string>("wallpaper-hotkey-error", (e) => console.warn("Wallpaper hotkey:", e.payload)).then(
			(fn) => {
				if (disposed) fn();
				else unlistenErr = fn;
			}
		);
		// Apply a hotkey saved in settings (the backend starts with Alt+A).
		const saved = localStorage.getItem("bloom-wallpaper-hotkey");
		if (saved && saved.toLowerCase() !== "alt+a") {
			invoke("wallpaper_set_hotkey", { hotkey: saved }).catch((err) =>
				console.warn("Wallpaper hotkey:", err)
			);
		}
		return () => {
			disposed = true;
			unlisten?.();
			unlistenErr?.();
		};
	}, [windowLabel]);
	// Open the notch on an unseen announcement; stays open until dismissed.
	useEffect(() => {
		if (!announcement || announcementDismissed) return;
		if (announcementShownRef.current === announcement.id) return;
		announcementShownRef.current = announcement.id;
		setBloomMode("announcement");
		if (notchMode === "peek") triggerEventPeek(6000);
	}, [announcement, announcementDismissed, notchMode, triggerEventPeek]);

	// Leave the announcement view once it is dismissed (or gone).
	useEffect(() => {
		if (bloomMode === "announcement" && (!announcement || announcementDismissed)) {
			// Hovering always shows the dashboard; only the collapsed compact notch shows music.
			setBloomMode(
				!isHovered && settingsMusicCompactNotch && mediaInfo.has_media && isPlaying
					? "music"
					: "status"
			);
		}
	}, [
		bloomMode,
		announcement,
		announcementDismissed,
		mediaInfo.has_media,
		isPlaying,
		isHovered,
		settingsMusicCompactNotch
	]);

	// Window height is now kept constant to prevent rendering layout lag and sharp corners

	const lastScrollTime = useRef(0);
	const handleWheel = (e: React.WheelEvent) => {
		const target = e.target as HTMLElement;
		if (
			target.closest(".tasks-list") ||
			target.closest(".tb-board") ||
			target.closest(".dash-scroll") ||
			// The dashboard panel handles wheel itself (tab switching).
			target.closest(".dash-panel") ||
			// The wallpaper panel scrolls through wallpapers.
			target.closest(".wp-panel")
		) {
			return;
		}

		if (!isHovered) return;

		const now = Date.now();
		if (now - lastScrollTime.current < 250) return;

		// Use absolute values to detect horizontal swipe gestures on trackpad
		const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
		if (Math.abs(delta) < 5) return; // Ignore tiny movements

		// Media lives in its own tab of the dashboard now, so scrolling cycles through
		// command-center → status (dashboard) → tasks → time gun.
		const modes: ("command-center" | "status" | "tasks" | "pomodoro")[] = [
			"command-center",
			"status",
			"tasks",
			"pomodoro"
		];
		// Side bar on: the Controls and Time gun panels are the side bar's popups (the clock), not notch panels.
		const availableModes = sbStrip ? modes.filter((m) => m !== "command-center" && m !== "pomodoro") : modes;

		// The announcement card is closed explicitly, not cycled away.
		if (bloomMode === "announcement") return;

		const currentIndex = availableModes.indexOf(
			bloomMode === "music" ? "status" : (bloomMode as (typeof modes)[number])
		);
		if (currentIndex === -1) return;

		if (delta > 0) {
			const nextIndex = (currentIndex + 1) % availableModes.length;
			const nextMode = availableModes[nextIndex];
			manualMusicRef.current = false;
			setBloomMode(nextMode);
			lastScrollTime.current = now;
		} else if (delta < 0) {
			const prevIndex = (currentIndex - 1 + availableModes.length) % availableModes.length;
			const prevMode = availableModes[prevIndex];
			manualMusicRef.current = false;
			setBloomMode(prevMode);
			lastScrollTime.current = now;
		}
	};

	const formatTimerTime = (totalSeconds: number) => {
		const mins = Math.floor(Math.abs(totalSeconds) / 60);
		const secs = Math.abs(totalSeconds) % 60;
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	// Decode a custom timer sound ahead of time so it plays instantly.
	useEffect(() => {
		if (settingsTimerSoundEnabled && hasCustomTimerSound(settingsTimerSoundFile)) {
			preloadCustomTimerSound();
		}
	}, [settingsTimerSoundEnabled, settingsTimerSoundFile]);

	// ---- Time gun (Pomodoro) ----
	// The countdown lives here, not in the panel, so it keeps running (and chimes) after the
	// notch collapses. Focus -> short break, and a long break after every POMO_ROUNDS rounds.
	const [pomoDurations, setPomoDurations] = useState<PomodoroDurations>(() =>
		parsePomo(localStorage.getItem(POMO_KEY))
	);
	const [pomo, setPomo] = useState<PomodoroState>(() => ({
		phase: "focus",
		running: false,
		endAt: 0,
		remainingMs: phaseMs("focus", parsePomo(localStorage.getItem(POMO_KEY))),
		rounds: 0
	}));
	const [pomoQuote, setPomoQuote] = useState(0);
	const [, setPomoTick] = useState(0);
	const pomoRef = useRef(pomo);
	pomoRef.current = pomo;
	const pomoDurationsRef = useRef(pomoDurations);
	pomoDurationsRef.current = pomoDurations;
	// Last whole second drawn, so the collapsed notch redraws once per second, not per poll.
	const pomoShownSecRef = useRef(-1);
	// While the gun runs, or is paused part way, the notch shows its countdown in the clock slot,
	// the same way it shows the old timer (which wins if both are active).
	const pomoInNotch =
		pomo.running || pomo.remainingMs < phaseMs(pomo.phase, pomoDurations) - 50;
	const pomoNotchSeconds = Math.max(
		0,
		Math.ceil((pomo.running ? pomo.endAt - Date.now() : pomo.remainingMs) / 1000)
	);

	// A phase ran out: chime, show a reminder card, and get the next phase ready to start.
	const completePomodoro = useCallback(() => {
		const s = pomoRef.current;
		const d = pomoDurationsRef.current;
		let next: PomodoroPhase = "focus";
		let rounds = s.rounds;
		let title: string;
		let body: string;
		if (s.phase === "focus") {
			rounds = s.rounds + 1;
			next = rounds >= POMO_ROUNDS ? "long" : "short";
			title = "No regrets";
			body =
				next === "long"
					? `${rounds} rounds done. Take a ${d.long} minute break.`
					: `Take a ${d.short} minute break.`;
		} else if (s.phase === "short") {
			title = "Break over";
			body = "Ready for the next round?";
		} else {
			rounds = 0;
			title = "Long break over";
			body = "A fresh cycle starts when you are ready.";
		}
		setPomo({ phase: next, running: false, endAt: 0, remainingMs: phaseMs(next, d), rounds });
		setTaskReminder({ id: `task-pomodoro-${Date.now()}`, severity: "info", title, body });
		if (settingsTimerSoundEnabled)
			playTimerSound(settingsTimerVolume, hasCustomTimerSound(settingsTimerSoundFile));
		// Reveal the collapsed notch for a moment, like the old timer does when it finishes.
		if (notchMode === "peek") triggerEventPeek(6000);
	}, [
		settingsTimerSoundEnabled,
		settingsTimerVolume,
		settingsTimerSoundFile,
		notchMode,
		triggerEventPeek
	]);

	useEffect(() => {
		if (windowLabel !== "main" || !pomo.running) return;
		const id = setInterval(() => {
			const left = pomoRef.current.endAt - Date.now();
			if (left <= 0) completePomodoro();
			else {
				// Redraw when the displayed second changes, so the notch countdown stays live.
				const sec = Math.ceil(left / 1000);
				if (sec !== pomoShownSecRef.current) {
					pomoShownSecRef.current = sec;
					setPomoTick((t) => t + 1);
				}
			}
		}, 250);
		return () => clearInterval(id);
	}, [windowLabel, pomo.running, completePomodoro]);

	// The side bar is its own window and shows the countdown in its clock, so it is sent the timer state whenever
	// that changes (and again when it asks, e.g. when it opens after the timer was started).
	useEffect(() => {
		if (windowLabel !== "main") return;
		const send = () => {
			const s = pomoRef.current;
			const d = pomoDurationsRef.current;
			emit("pomo-state", {
				active: s.running || s.remainingMs < phaseMs(s.phase, d) - 50,
				running: s.running,
				endAt: s.endAt,
				remainingMs: s.remainingMs,
				phase: s.phase,
				rounds: s.rounds,
				durations: d
			}).catch(() => {});
		};
		send();
		const un = listen("pomo-request", send);
		return () => {
			un.then((f) => f());
		};
	}, [windowLabel, pomo.running, pomo.phase, pomo.endAt, pomo.remainingMs, pomo.rounds, pomoDurations]);

	const togglePomodoro = useCallback(() => {
		getTimerChimeCtx(); // created on a click so the end chime is allowed to play later
		const s = pomoRef.current;
		if (s.running) {
			setPomo({ ...s, running: false, endAt: 0, remainingMs: Math.max(0, s.endAt - Date.now()) });
			return;
		}
		// A fresh focus session (not a resume) shows the quote.
		if (s.phase === "focus" && s.remainingMs >= phaseMs("focus", pomoDurationsRef.current) - 50)
			setPomoQuote((q) => q + 1);
		setPomo({ ...s, running: true, endAt: Date.now() + s.remainingMs });
	}, []);

	// Skip moves on without counting the round: focus -> short break, any break -> focus.
	const skipPomodoro = useCallback(() => {
		const s = pomoRef.current;
		const next: PomodoroPhase = s.phase === "focus" ? "short" : "focus";
		setPomo({
			phase: next,
			running: false,
			endAt: 0,
			remainingMs: phaseMs(next, pomoDurationsRef.current),
			rounds: s.phase === "long" ? 0 : s.rounds
		});
	}, []);

	const resetPomodoro = useCallback(() => {
		setPomo({
			phase: "focus",
			running: false,
			endAt: 0,
			remainingMs: phaseMs("focus", pomoDurationsRef.current),
			rounds: 0
		});
	}, []);

	const changePomoDuration = useCallback((phase: PomodoroPhase, delta: number) => {
		const current = pomoDurationsRef.current;
		const wanted = Math.round((current[phase] + delta) * 60) / 60;
		const next = { ...current, [phase]: Math.min(POMO_MAX_MINUTES, Math.max(1 / 60, wanted)) };
		pomoDurationsRef.current = next;
		setPomoDurations(next);
		const value = JSON.stringify(next);
		localStorage.setItem(POMO_KEY, value);
		invoke("save_setting", { key: POMO_KEY, value }).catch(console.error);
		// An untouched phase follows the new length straight away.
		const s = pomoRef.current;
		if (!s.running && s.phase === phase && s.remainingMs === phaseMs(phase, current))
			setPomo({ ...s, remainingMs: phaseMs(phase, next) });
	}, []);

	// The side bar's Time gun popup (a separate window) sends its buttons here; the timer itself stays in this window.
	useEffect(() => {
		if (windowLabel !== "main") return;
		const un = listen<{ cmd: string; phase?: PomodoroPhase; delta?: number }>("pomo-cmd", (e) => {
			const m = e.payload;
			if (m.cmd === "toggle") togglePomodoro();
			else if (m.cmd === "skip") skipPomodoro();
			else if (m.cmd === "reset") resetPomodoro();
			else if (m.cmd === "duration" && m.phase && typeof m.delta === "number") changePomoDuration(m.phase, m.delta);
		});
		return () => {
			un.then((f) => f());
		};
	}, [windowLabel, togglePomodoro, skipPomodoro, resetPomodoro, changePomoDuration]);

	// The side bar's media widget and popup (a separate window) get the now-playing state from here: whenever it
	// changes, and again when the bar asks (it may open later). The play / skip buttons call the media commands themselves.
	const mediaInfoRef = useRef(mediaInfo);
	mediaInfoRef.current = mediaInfo;
	useEffect(() => {
		if (windowLabel !== "main") return;
		emit("sb-media-state", mediaInfo).catch(() => {});
	}, [windowLabel, mediaInfo]);
	useEffect(() => {
		if (windowLabel !== "main") return;
		const un = listen("sb-media-request", () => {
			emit("sb-media-state", mediaInfoRef.current).catch(() => {});
		});
		return () => {
			un.then((f) => f());
		};
	}, [windowLabel]);

	// Reminder sounds: play once when a task or calendar reminder card appears.
	// Only the main window plays it, so secondary notch windows don't double up.
	const reminderSoundPlayedRef = useRef<string | null>(null);
	useEffect(() => {
		if (windowLabel !== "main" || !announcement || announcementDismissed) return;
		// The Pomodoro "time is up" card already played the timer chime (completePomodoro). Its id starts with "task-" too, so
		// without this it would add the task reminder sound on top, and the two together sound like a doubled chime.
		if (announcement.id.startsWith("task-pomodoro-")) return;
		const kind: ReminderKind | null = announcement.id.startsWith("task-")
			? "task"
			: announcement.id.startsWith("calendar-note-")
				? "calendar"
				: null;
		if (!kind || reminderSoundPlayedRef.current === announcement.id) return;
		reminderSoundPlayedRef.current = announcement.id;
		if (!settingsReminderSoundEnabled) return;
		const file = kind === "task" ? settingsTaskSoundFile : settingsCalendarSoundFile;
		playReminderSound(kind, settingsReminderVolume, hasCustomTimerSound(file));
	}, [
		windowLabel,
		announcement,
		announcementDismissed,
		settingsReminderSoundEnabled,
		settingsReminderVolume,
		settingsTaskSoundFile,
		settingsCalendarSoundFile
	]);

	// Decode custom reminder sounds ahead of time so they play instantly.
	useEffect(() => {
		if (!settingsReminderSoundEnabled) return;
		if (hasCustomTimerSound(settingsTaskSoundFile)) preloadCustomReminderSound("task");
		if (hasCustomTimerSound(settingsCalendarSoundFile)) preloadCustomReminderSound("calendar");
		if (hasCustomTimerSound(settingsCompleteSoundFile)) preloadCustomReminderSound("complete");
		if (hasCustomTimerSound(settingsSnapSoundFile)) preloadCustomReminderSound("snap");
	}, [
		settingsReminderSoundEnabled,
		settingsTaskSoundFile,
		settingsCalendarSoundFile,
		settingsCompleteSoundFile,
		settingsSnapSoundFile
	]);

	// Sound for checking a task off or dropping it into Done.
	const playTaskComplete = useCallback(() => {
		if (windowLabel !== "main" || !settingsReminderSoundEnabled) return;
		playReminderSound(
			"complete",
			settingsReminderVolume,
			hasCustomTimerSound(settingsCompleteSoundFile)
		);
	}, [windowLabel, settingsReminderSoundEnabled, settingsReminderVolume, settingsCompleteSoundFile]);

	// Sound for a card on the tasks board: plays as a dragged card moves over another
	// slot (soft = true plays it quieter).
	const playTaskSnap = useCallback(
		(soft: boolean) => {
			if (windowLabel !== "main" || !settingsReminderSoundEnabled) return;
			playReminderSound(
				"snap",
				settingsReminderVolume * (soft ? 0.45 : 1),
				hasCustomTimerSound(settingsSnapSoundFile)
			);
		},
		[windowLabel, settingsReminderSoundEnabled, settingsReminderVolume, settingsSnapSoundFile]
	);

	// The webview only lets audio start after a user gesture, so unlock the audio
	// context on the first click or keypress. Reminders can then play on their own.
	useEffect(() => {
		const unlock = () => {
			getTimerChimeCtx();
		};
		window.addEventListener("pointerdown", unlock, { once: true });
		window.addEventListener("keydown", unlock, { once: true });
		return () => {
			window.removeEventListener("pointerdown", unlock);
			window.removeEventListener("keydown", unlock);
		};
	}, []);

	const lastTrackRef = useRef<string | null>(null);
	const lastPlayingRef = useRef<boolean>(false);
	const manualMusicRef = useRef<boolean>(false);

	// Auto-switch to music mode only when a *new* track starts while playing,
	// or when playback transitions from paused to playing.
	useEffect(() => {
		const isNewTrackWhilePlaying = mediaInfo.title !== lastTrackRef.current && isPlaying;
		const justStartedPlaying = isPlaying && !lastPlayingRef.current;

		// Peek notch on media events (play start or track change)
		if (notchMode === "peek" && (isNewTrackWhilePlaying || justStartedPlaying)) {
			triggerEventPeek(3000);
		}

		// Only auto-switch if music mode is enabled and no announcement is open
		if (
			settingsMusicModeEnabled &&
			mediaInfo.has_media &&
			isPlaying &&
			bloomMode !== "tasks" &&
			bloomMode !== "pomodoro" &&
			bloomMode !== "wallpaper" &&
			!announcementOpenRef.current &&
			(isNewTrackWhilePlaying || justStartedPlaying)
		) {
			// Only the collapsed compact notch switches to music; hovering shows the dashboard.
			if (settingsMusicCompactNotch && !isHovered) {
				manualMusicRef.current = false;
				setBloomMode("music");
			}
		}

		lastTrackRef.current = mediaInfo.title;
		lastPlayingRef.current = isPlaying;
	}, [
		mediaInfo.has_media,
		isPlaying,
		mediaInfo.title,
		settingsMusicModeEnabled,
		settingsMusicCompactNotch,
		isHovered,
		bloomMode,
		notchMode,
		triggerEventPeek
	]);

	// Auto-switch back from music if music stops for 5 seconds
	// Skip if user manually scrolled to music mode
	useEffect(() => {
		let timer: any;
		if (!isPlaying && bloomMode === "music" && !manualMusicRef.current) {
			timer = setTimeout(() => {
				setBloomMode("status");
			}, 5000);
		}
		return () => clearTimeout(timer);
	}, [isPlaying, bloomMode]);

	// Reset bloom mode when music mode setting is disabled
	useEffect(() => {
		if (!settingsMusicModeEnabled && bloomMode === "music") {
			setBloomMode("status");
		}
	}, [settingsMusicModeEnabled, bloomMode]);

	// Reset bloom mode when compact notch display is disabled while collapsed
	useEffect(() => {
		if (!settingsMusicCompactNotch && bloomMode === "music" && !isHovered) {
			setBloomMode("status");
		}
	}, [settingsMusicCompactNotch, bloomMode, isHovered]);

	// Synchronize bloom mode immediately when music settings are toggled and music is playing
	useEffect(() => {
		if (
			settingsMusicModeEnabled &&
			settingsMusicCompactNotch &&
			mediaInfo.has_media &&
			isPlaying &&
			bloomMode === "status" &&
			!announcementOpenRef.current &&
			!isHovered
		) {
			setBloomMode("music");
		}
	}, [
		settingsMusicModeEnabled,
		settingsMusicCompactNotch,
		mediaInfo.has_media,
		isPlaying,
		bloomMode,
		isHovered
	]);

	// Update time
	useEffect(() => {
		const updateTime = () => {
			const now = new Date();
			setTime(
				now.toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					hour12: !timeFormat24h
				})
			);
		};

		updateTime();
		const interval = setInterval(updateTime, 1000);

		return () => {
			clearInterval(interval);
		};
	}, [timeFormat24h]);

	// Battery API
	useEffect(() => {
		let battery: any = null;

		const initBattery = async () => {
			try {
				battery = await (navigator as any).getBattery();

				const updateBattery = () => {
					setBatteryLevel(Math.round(battery.level * 100));
					setIsCharging(battery.charging);
				};

				updateBattery();

				battery.addEventListener("levelchange", updateBattery);
				battery.addEventListener("chargingchange", updateBattery);

				return () => {
					battery.removeEventListener("levelchange", updateBattery);
					battery.removeEventListener("chargingchange", updateBattery);
				};
			} catch (e) {
				// Battery API not supported
			}
		};

		initBattery();
	}, []);

	// Listen for Volume Changes
	useEffect(() => {
		const unlisten = listen<{ volume: number; is_muted: boolean }>("volume-change", (event) => {
			setVolume(event.payload.volume);
			setIsMuted(event.payload.is_muted);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Wi-Fi is a three-state control: Off, on-but-not-connected, Connected.
	// The radio state alone can't tell those apart, so get_wifi_status returns
	// both flags. Returns false so the startup loader knows to retry.
	const refreshWifiStatus = useCallback(async (): Promise<boolean> => {
		try {
			setWifiStatus(await invoke<WifiStatus>("get_wifi_status"));
			return true;
		} catch {
			return false;
		}
	}, []);

	// Seed the Wi-Fi pill at startup. The first call can fail while the WLAN
	// service is still coming up, so retry instead of leaving the pill stuck on
	// its default.
	useEffect(() => {
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const initializeWifiStatus = async (attempt: number) => {
			const loaded = await refreshWifiStatus();
			if (!loaded && !cancelled && attempt < 3) {
				retryTimer = setTimeout(
					() => void initializeWifiStatus(attempt + 1),
					(attempt + 1) * 1000
				);
			}
		};
		void initializeWifiStatus(0);
		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [refreshWifiStatus]);

	// Connected Bluetooth devices for the tile, refreshed whenever the backend
	// reports a device connecting, disconnecting, pairing or being removed.
	useEffect(() => {
		if (!bluetoothEnabled) {
			setBtConnectedNames([]);
			return;
		}
		const refresh = () =>
			invoke<{ name: string; connected: boolean }[]>("bluetooth_list_devices")
				.then((devices) =>
					setBtConnectedNames(devices.filter((d) => d.connected).map((d) => d.name))
				)
				.catch(() => {});
		let debounce: ReturnType<typeof setTimeout> | undefined;
		void refresh();
		const unlisten = listen("bluetooth-changed", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refresh(), 400);
		});
		return () => {
			clearTimeout(debounce);
			unlisten.then((f) => f());
		};
	}, [bluetoothEnabled]);

	// The backend reports connection changes and finished scans as they
	// happen, so the Wi-Fi tile follows without waiting for the next poll.
	useEffect(() => {
		let debounce: ReturnType<typeof setTimeout> | undefined;
		const unlisten = listen("wifi-changed", () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => void refreshWifiStatus(), 300);
		});
		return () => {
			clearTimeout(debounce);
			unlisten.then((f) => f());
		};
	}, [refreshWifiStatus]);

	// Load bluetooth/volume/brightness state on mount
	useEffect(() => {
		invoke<boolean>("get_bluetooth_state")
			.then(setBluetoothEnabled)
			.catch(() => {});
		invoke<{ volume: number; is_muted: boolean }>("get_volume_state")
			.then((state) => {
				setVolume(state.volume);
				setIsMuted(state.is_muted);
			})
			.catch(() => {});
		invoke<number>("get_brightness")
			.then(setCurrentBrightness)
			.catch(() => {});
	}, []);

	// Refresh Wi-Fi status while the command center is open so changes made
	// outside Bloom (keyboard toggle, Windows quick settings) show up.
	useEffect(() => {
		if (bloomMode !== "command-center") return;
		void refreshWifiStatus();
		const interval = setInterval(() => void refreshWifiStatus(), 5000);
		return () => clearInterval(interval);
	}, [bloomMode, refreshWifiStatus]);

	// Poll system metrics for status widgets
	useEffect(() => {
		const fetchMetrics = () => {
			invoke<number>("get_cpu_usage")
				.then(setCpuUsage)
				.catch((e) => console.warn("CPU:", e));
			invoke<number>("get_ram_usage")
				.then(setRamUsage)
				.catch((e) => console.warn("RAM:", e));
			invoke<number>("get_disk_space")
				.then(setDiskSpace)
				.catch((e) => console.warn("Disk:", e));
			invoke<[number, number]>("get_network_speed")
				.then(([up, down]) => {
					setNetUpSpeed(up);
					setNetDownSpeed(down);
				})
				.catch(() => {});
		};
		fetchMetrics();
		const interval = setInterval(fetchMetrics, 3000);
		return () => clearInterval(interval);
	}, []);

	// Performance panel stats (temperatures, GPU, memory and disk totals). Polled only while
	// the panel is showing, and only after it has stayed open for a moment, so a mouse
	// passing over the notch doesn't wake the GPU.
	const perfVisible = bloomMode === "status" && isHovered && isExpanded && isVisible && !isHidden;
	// Same as perfVisible but without the hover: the experimental keep-alive option leaves the dashboard
	// mounted while the side bar notch is closed.
	const dashKeepAlive =
		settingsDashKeepAlive && sbStrip && bloomMode === "status" && isExpanded && isVisible && !isHidden;
	useEffect(() => {
		if (!perfVisible) return;
		let cancelled = false;
		let interval: ReturnType<typeof setInterval> | undefined;
		const poll = () => {
			const full = dashTabRef.current === "performance";
			invoke<PerfExtras>("get_perf_extras", { drive: perfDriveRef.current, full })
				.then((stats) => {
					if (cancelled) return;
					// A light poll has no temperatures; keep the last ones for the Performance tab.
					setPerf((prev) =>
						full || !prev
							? stats
							: {
									...prev,
									ramUsed: stats.ramUsed,
									ramTotal: stats.ramTotal,
									diskUsed: stats.diskUsed,
									diskTotal: stats.diskTotal,
									drive: stats.drive,
									drives: stats.drives
								}
					);
				})
				.catch((e) => console.warn("Perf:", e));
		};
		const start = setTimeout(() => {
			pollPerfRef.current = poll;
			poll();
			interval = setInterval(poll, 2000);
		}, 700); // wait for the notch open animation to finish
		return () => {
			cancelled = true;
			pollPerfRef.current = null;
			clearTimeout(start);
			if (interval) clearInterval(interval);
		};
	}, [perfVisible]);

	const perfShowWeather = settingsWeatherEnabled && temperature !== null;

	// Read the temperatures as soon as the Performance tab (which shows them) is opened.
	useEffect(() => {
		if (dashTab === "performance") pollPerfRef.current?.();
	}, [dashTab]);

	// Profile and picture cache, kept in the app cache folder (ui_cache.rs). Loaded once at startup so
	// the Profile tab shows something straight away, then refreshed after the open animation.
	useEffect(() => {
		let alive = true;
		invoke<string | null>("ui_cache_read", { name: "profile.json" })
			.then((raw) => {
				if (!alive || !raw) return;
				try {
					const cached = JSON.parse(raw);
					setProfile((cur) => cur ?? cached);
				} catch {}
			})
			.catch(() => {});
		invoke<string | null>("ui_cache_read", { name: "avatar.txt" })
			.then((raw) => {
				if (alive && raw) setAvatar((cur) => cur ?? raw);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// Profile details and picture, refreshed after the panel has finished opening.
	useEffect(() => {
		if (!perfVisible) return;
		const t = setTimeout(() => {
			invoke<ProfileInfo>("get_profile_info")
				.then((info) => {
					const next = { info, at: Date.now() };
					setProfile(next);
					invoke("ui_cache_write", { name: "profile.json", value: JSON.stringify(next) }).catch(() => {});
				})
				.catch((e) => console.warn("Profile:", e));
			invoke<string | null>("get_profile_avatar")
				.then((a) => {
					setAvatar(a);
					invoke("ui_cache_write", { name: "avatar.txt", value: a }).catch(() => {});
				})
				.catch(() => {});
		}, 700);
		return () => clearTimeout(t);
	}, [perfVisible]);

	// Open windows for the Windows tab, refreshed while that tab is showing.
	useEffect(() => {
		if (!perfVisible || dashTab !== "windows") return;
		let cancelled = false;
		const load = () => {
			invoke<
				{
					name: string;
					icon: string | null;
					hwnd?: number | null;
					all_hwnds?: [number, string][] | null;
				}[]
			>("get_active_windows")
				.then((apps) => {
					if (cancelled) return;
					const entries: WindowEntry[] = [];
					for (const app of apps) {
						const hwnds: [number, string][] =
							app.all_hwnds && app.all_hwnds.length > 0
								? app.all_hwnds
								: app.hwnd != null
									? [[app.hwnd, app.name]]
									: [];
						for (const [hwnd, title] of hwnds) {
							entries.push({
								key: String(hwnd),
								hwnd,
								title: title || app.name,
								app: app.name,
								icon: app.icon
							});
						}
					}
					setWindowList(entries);
				})
				.catch((e) => console.warn("Windows:", e));
		};
		load();
		const id = setInterval(load, 2500);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [perfVisible, dashTab]);

	// Network speed for the Performance tab, sampled every second while the panel is showing
	// (on every tab, so the graph keeps its history while you look at another tab).
	useEffect(() => {
		if (!perfVisible) return;
		let cancelled = false;
		// The first sample after opening averages over the whole time the panel was closed.
		let first = true;
		// Keep the graph across short gaps; only start it over after a long one.
		if (Date.now() - netLastSampleAtRef.current > 60_000) {
			setNetHistory({ down: [0, 0], up: [0, 0] });
		}
		const poll = () => {
			invoke<NetworkUsage>("get_network_usage")
				.then((usage) => {
					if (cancelled) return;
					if (first) {
						first = false;
						return;
					}
					netLastSampleAtRef.current = Date.now();
					setNet(usage);
					setNetHistory((h) => ({
						down: [...h.down, usage.downPerSec].slice(-40),
						up: [...h.up, usage.upPerSec].slice(-40)
					}));
				})
				.catch(() => {});
		};
		poll();
		const id = setInterval(poll, 1000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [perfVisible]);

	const pickAvatar = async () => {
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const picked = await open({
				multiple: false,
				filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }]
			});
			if (typeof picked !== "string") return;
			const a = await invoke<string>("set_profile_avatar", { path: picked });
			setAvatar(a);
			invoke("ui_cache_write", { name: "avatar.txt", value: a }).catch(() => {});
		} catch (e) {
			console.warn("Avatar:", e);
		}
	};

	const resetAvatar = () => {
		invoke("clear_profile_avatar")
			.then(() => {
				setAvatar(null);
				invoke("ui_cache_write", { name: "avatar.txt", value: null }).catch(() => {});
			})
			.catch(console.error);
	};

	// Right-click on the memory card: next fixed drive (C -> D -> ...), refreshed right away.
	const cyclePerfDrive = () => {
		const drives = perf?.drives?.length ? perf.drives : ["C"];
		const at = drives.indexOf(perfDriveRef.current);
		const next = drives[(at + 1) % drives.length];
		perfDriveRef.current = next;
		setPerfDrive(next);
		localStorage.setItem(PERF_DRIVE_KEY, next);
		invoke("save_setting", { key: PERF_DRIVE_KEY, value: next }).catch(console.error);
		pollPerfRef.current?.();
	};

	// Listen for brightness changes
	useEffect(() => {
		const unlisten = listen<{ brightness: number }>("brightness-change", (event) => {
			setCurrentBrightness(event.payload.brightness);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Native Windows Media Controls - Listen for updates from background worker
	useEffect(() => {
		const unlisten = listen<MediaInfo>("media-update", (event) => {
			const info = event.payload;
			if (!info) return;

			setMediaInfo((prev) => {
				// Find if artwork changed by checking the first element
				const prevArt = prev.artwork?.[0];
				const nextArt = info.artwork?.[0];
				const artChanged = prevArt !== nextArt;

				if (
					prev.title === info.title &&
					prev.artist === info.artist &&
					prev.is_playing === info.is_playing &&
					prev.has_media === info.has_media &&
					!artChanged &&
					prev.position_ms === info.position_ms &&
					prev.duration_ms === info.duration_ms
				) {
					return prev;
				}

				// Update playing state separately for the hook triggers
				setIsPlaying(info.is_playing);

				if (info.artwork && info.artwork.length > 0) {
					const newArt = info.artwork[0];
					setAlbumArtUrl((prev) => {
						if (prev !== newArt) {
							setAlbumArtKey((k) => k + 1);
							return newArt;
						}
						return prev;
					});
				} else {
					setAlbumArtUrl(null);
				}

				return info;
			});
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Media controls via Tauri commands
	/* Unused saveAndBroadcast removed to fix TS build error */
	const togglePlayPause = useCallback(async () => {
		try {
			await invoke("media_play_pause");
			setIsPlaying(!isPlaying);
		} catch (e) {
			console.error("Failed to toggle play/pause:", e);
		}
	}, [isPlaying]);

	const skipNext = useCallback(async () => {
		try {
			await invoke("media_next");
		} catch (e) {
			console.error("Failed to skip next:", e);
		}
	}, []);

	const skipPrevious = useCallback(async () => {
		try {
			await invoke("media_previous");
		} catch (e) {
			console.error("Failed to skip previous:", e);
		}
	}, []);

	// Slide-push animation for prev/next buttons
	const prevFront = useAnimation();
	const prevBack = useAnimation();
	const nextFront = useAnimation();
	const nextBack = useAnimation();

	const animatePrev = useCallback(async () => {
		prevFront.set({ x: 0 });
		prevBack.set({ x: 30 });
		prevFront.start({ x: -30, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		await prevBack.start({ x: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		skipPrevious();
	}, [skipPrevious, prevFront, prevBack]);

	const animateNext = useCallback(async () => {
		nextFront.set({ x: 0 });
		nextBack.set({ x: -30 });
		nextFront.start({ x: 30, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		await nextBack.start({ x: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] } });
		skipNext();
	}, [skipNext, nextFront, nextBack]);

	const sendVolume = useTrailingThrottle((newVol: number) => {
		invoke("set_volume", { volume: newVol }).catch(() => {});
	}, 50);

	const handleVolumeChange = useCallback(
		(newVol: number) => {
			setVolume(newVol);
			// set_volume unmutes for any non-zero level.
			setIsMuted(newVol === 0);
			sendVolume(newVol);
		},
		[sendVolume]
	);

	// WiFi toggle
	const toggleWifi = useCallback(async () => {
		const previous = wifiStatus;
		const newState = !(previous?.enabled ?? false);
		setWifiStatus({
			enabled: newState,
			connected: newState ? (previous?.connected ?? false) : false,
			ssid: newState ? (previous?.ssid ?? null) : null
		});
		try {
			await invoke("set_wifi_state", { enabled: newState });
			// The radio and association take a moment to settle.
			setTimeout(() => void refreshWifiStatus(), 800);
		} catch (e) {
			setWifiStatus(previous);
			console.error("Failed to toggle WiFi:", e);
		}
	}, [wifiStatus, refreshWifiStatus]);

	// Bluetooth toggle
	const toggleBluetooth = useCallback(async () => {
		const newState = !bluetoothEnabled;
		setBluetoothEnabled(newState);
		try {
			await invoke("set_bluetooth_state", { enabled: newState });
		} catch (e) {
			setBluetoothEnabled(!newState);
			console.error("Failed to toggle Bluetooth:", e);
		}
	}, [bluetoothEnabled]);

	// Text color picker: choose any hex color for the island text
	const [textColor, setTextColor] = useState<string>(() => {
		const saved = localStorage.getItem("bloom-text-color") || "auto";
		return HEX_RE.test(saved) ? saved.toLowerCase() : "auto";
	});
	const textColorRef = useRef(textColor);
	const textPersistTimer = useRef<number | null>(null);
	const [textSheetOpen, setTextSheetOpen] = useState(false);
	const [pickerHsv, setPickerHsv] = useState({ h: 0, s: 0, v: 1 });
	const [hexDraft, setHexDraft] = useState("#ffffff");

	// Saved like the theme settings: localStorage and settings.json must both have it
	const persistTextColor = useCallback((value: string) => {
		localStorage.setItem("bloom-text-color", value);
		invoke("save_setting", { key: "bloom-text-color", value }).catch(console.error);
	}, []);

	// Live preview while dragging; the save is delayed until the picker settles
	const liveTextColor = useCallback(
		(hex: string) => {
			const h = hex.toLowerCase();
			textColorRef.current = h;
			setTextColor(h);
			if (textPersistTimer.current) window.clearTimeout(textPersistTimer.current);
			textPersistTimer.current = window.setTimeout(() => persistTextColor(h), 400);
		},
		[persistTextColor]
	);

	// Back to the theme's own text colors
	const resetTextColor = useCallback(() => {
		if (textPersistTimer.current) window.clearTimeout(textPersistTimer.current);
		textColorRef.current = "auto";
		setTextColor("auto");
		persistTextColor("auto");
		applyTheme(
			localStorage.getItem("bloom-theme-mode") || "dark",
			localStorage.getItem("bloom-theme-color") || "#007aff",
			parseFloat(localStorage.getItem("bloom-theme-opacity") || "0.80"),
			parseFloat(localStorage.getItem("bloom-theme-saturation") || "0.50"),
			parseFloat(localStorage.getItem("bloom-theme-brightness") || "0.15")
		);
		const base = currentThemeTextHex();
		setHexDraft(base);
		setPickerHsv(hexToHsv(base));
	}, [persistTextColor]);

	const toggleTextSheet = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (textSheetOpen) {
				setTextSheetOpen(false);
				return;
			}
			const base = HEX_RE.test(textColor) ? textColor : currentThemeTextHex();
			setHexDraft(base);
			setPickerHsv(hexToHsv(base));
			setTextSheetOpen(true);
		},
		[textSheetOpen, textColor]
	);

	const pickTextSV = (e: React.PointerEvent<HTMLDivElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const sat = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
		const val = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
		const hex = hsvToHex(pickerHsv.h, sat, val);
		setPickerHsv({ h: pickerHsv.h, s: sat, v: val });
		setHexDraft(hex);
		liveTextColor(hex);
	};

	// The theme rewrites --bloom-text whenever it is applied, so put the chosen color back
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

	useEffect(() => {
		if (bloomMode !== "command-center") setTextSheetOpen(false);
	}, [bloomMode]);
	// The side bar's Controls popup (a separate window) saves a text color and broadcasts it; take it here.
	useEffect(() => {
		if (windowLabel !== "main") return;
		const un = listen<{ key: string; value: unknown }>("settings-changed", (e) => {
			if (e.payload.key !== "bloom-text-color") return;
			const v = String(e.payload.value ?? "auto").toLowerCase();
			const next = HEX_RE.test(v) ? v : "auto";
			localStorage.setItem("bloom-text-color", next);
			textColorRef.current = next;
			setTextColor(next);
			if (next === "auto") {
				applyTheme(
					localStorage.getItem("bloom-theme-mode") || "dark",
					localStorage.getItem("bloom-theme-color") || "#007aff",
					parseFloat(localStorage.getItem("bloom-theme-opacity") || "0.80"),
					parseFloat(localStorage.getItem("bloom-theme-saturation") || "0.50"),
					parseFloat(localStorage.getItem("bloom-theme-brightness") || "0.15")
				);
			}
		});
		return () => {
			un.then((f) => f());
		};
	}, [windowLabel]);

	// Audio output picker (replaces the old Energy Saver shortcut)
	const [audioSheetOpen, setAudioSheetOpen] = useState(false);
	const [audioOutputs, setAudioOutputs] = useState<
		{ id: string; name: string; isDefault: boolean }[]
	>([]);

	const refreshAudioOutputs = useCallback(() => {
		invoke<{ id: string; name: string; isDefault: boolean }[]>("list_audio_outputs")
			.then(setAudioOutputs)
			.catch((e) => console.error("Failed to list audio outputs:", e));
	}, []);

	const toggleAudioSheet = useCallback(() => {
		setAudioSheetOpen((open) => {
			if (!open) refreshAudioOutputs();
			return !open;
		});
	}, [refreshAudioOutputs]);

	const pickAudioOutput = useCallback(
		(id: string) => {
			setAudioOutputs((list) => list.map((d) => ({ ...d, isDefault: d.id === id })));
			invoke("set_audio_output", { id })
				.catch((e) => console.error("Failed to switch audio output:", e))
				.finally(() => setTimeout(refreshAudioOutputs, 400));
		},
		[refreshAudioOutputs]
	);

	// Close the picker whenever the Command Center closes
	useEffect(() => {
		if (bloomMode !== "command-center") setAudioSheetOpen(false);
	}, [bloomMode]);

	// Brightness change with throttling
	const sendBrightness = useTrailingThrottle((newVal: number) => {
		invoke("set_brightness", { brightness: newVal }).catch(() => {});
	}, 50);

	const handleBrightnessChange = useCallback(
		(newVal: number) => {
			setCurrentBrightness(newVal);
			sendBrightness(newVal);
		},
		[sendBrightness]
	);

	// Launch the game overlay toggle (D:\\Toggle.exe)
	const launchGameOverlay = useCallback(async () => {
		try {
			await invoke("launch_game_overlay");
		} catch (e) {
			console.error("Failed to launch game overlay:", e);
		}
	}, []);

	// Theme cycle button: Custom -> Dark -> Light, with a short popup
	const [themeModeState, setThemeModeState] = useState(
		() => localStorage.getItem("bloom-theme-mode") || "dark"
	);
	const [themeToast, setThemeToast] = useState<string | null>(null);
	const themeToastTimer = useRef<number | null>(null);

	const cycleTheme = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		const current = localStorage.getItem("bloom-theme-mode") || "dark";
		const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
		localStorage.setItem("bloom-theme-mode", next);
		invoke("save_setting", { key: "bloom-theme-mode", value: next }).catch(console.error);
		setThemeModeState(next);
		// Re-apply here too: the settings-changed event is delivered to the other
		// windows, so without this the notch would keep the old colors.
		applyTheme(
			next,
			localStorage.getItem("bloom-theme-color") || "#007aff",
			parseFloat(localStorage.getItem("bloom-theme-opacity") || "0.80"),
			parseFloat(localStorage.getItem("bloom-theme-saturation") || "0.50"),
			parseFloat(localStorage.getItem("bloom-theme-brightness") || "0.15")
		);
		setThemeToast(`Theme: ${THEME_LABELS[next] ?? next}`);
		if (themeToastTimer.current) window.clearTimeout(themeToastTimer.current);
		themeToastTimer.current = window.setTimeout(() => setThemeToast(null), 1500);
	}, []);

	// The side bar's Controls popup (a separate window) asks for a theme change here, where the theme is applied.
	useEffect(() => {
		if (windowLabel !== "main") return;
		const un = listen<{ cmd: string }>("controls-cmd", (e) => {
			if (e.payload.cmd === "theme") cycleTheme({ stopPropagation() {} } as React.MouseEvent);
		});
		return () => {
			un.then((f) => f());
		};
	}, [windowLabel, cycleTheme]);

	// Re-read the theme when the Command Center opens (it may have changed in Settings)
	useEffect(() => {
		if (bloomMode === "command-center") {
			setThemeModeState(localStorage.getItem("bloom-theme-mode") || "dark");
		} else {
			setThemeToast(null);
		}
	}, [bloomMode]);

	const openSettingsWindow = useCallback(async () => {
		try {
			await invoke("open_settings_window");
		} catch (e) {
			console.error("Failed to open settings window:", e);
		}
	}, []);

	// Right-click opens the tile's own view, the same as its › button.
	const handleWifiRightClick = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setBloomMode("wifi");
	}, []);

	const toggleNotchModeSetting = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			const nextMode = notchMode === "fixed" ? "smart" : notchMode === "smart" ? "peek" : "fixed";
			setNotchMode(nextMode);
			localStorage.setItem("bloom-notch-mode", nextMode);
			invoke("save_setting", { key: "bloom-notch-mode", value: nextMode }).catch(console.error);
			try {
				await invoke("change_notch_mode", { mode: sbStrip ? "peek" : nextMode });
			} catch (err) {
				console.error("Failed to change notch mode:", err);
			}
		},
		[notchMode, sbStrip]
	);

	const handleBluetoothRightClick = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setBloomMode("bluetooth");
	}, []);

	// Render a status widget by ID
	const renderStatusWidget = (id: string) => {
		switch (id) {
			case "weather":
				if (!settingsWeatherEnabled || temperature === null) return null;
				return (
					<div
						className="passive-feature"
						key="weather"
						title={cityName ? `${weatherCondition} — ${cityName}` : weatherCondition}
					>
						<WeatherIcon size={12} strokeWidth={2.2} />
						<span className="label">
							{temperature}°{tempUnit === "fahrenheit" ? "F" : "C"}
						</span>
					</div>
				);
			case "battery":
				return (
					<div className="passive-feature" key="battery">
						<BatteryIcon
							charging={isCharging}
							level={batteryLevel}
							threshold={lowBatteryThreshold}
						/>
						<span className="label">{batteryLevel}%</span>
					</div>
				);
			case "cpu":
				return (
					<div className="passive-feature" key="cpu" title="CPU Usage">
						<Cpu size={12} strokeWidth={2} />
						<span className="label">{cpuUsage}%</span>
					</div>
				);
			case "ram":
				return (
					<div className="passive-feature" key="ram" title="RAM Usage">
						<MemoryStick size={12} strokeWidth={2} />
						<span className="label">{Math.round(ramUsage)}%</span>
					</div>
				);
			case "disk":
				return (
					<div className="passive-feature" key="disk" title="Free Disk Space">
						<HardDrive size={12} strokeWidth={2} />
						<span className="label">{diskSpace}GB</span>
					</div>
				);
			case "net":
				return (
					<div className="passive-feature" key="net" title="Network Speed">
						<ArrowUpDown size={12} strokeWidth={2} />
						<span className="label">
							↑{formatBytes(netUpSpeed)} ↓{formatBytes(netDownSpeed)}
						</span>
					</div>
				);
			default:
				return null;
		}
	};

	const formatBytes = (bytes: number) => {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
		return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	};

	// Music mode shows any time we have media info (playing or paused) and music mode setting is enabled
	const isMusicMode = mediaInfo.has_media && bloomMode === "music" && settingsMusicModeEnabled;

	// Calculate width dynamically based on enabled features
	// Side bar on: the status row (weather, time, CPU, battery) is left out of every view; whatever
	// sits below it moves up to the strip (see getDynamicHeight).
	const sbNoBar = sbStrip;
	const getDynamicWidth = () => {
		if (bloomMode === "announcement" && announcement && !announcementDismissed) return 380;
		// The board fills the width it can: up to 780px, less on a narrow monitor
		// (window width / zoom keeps this right on every screen).
		if (bloomMode === "tasks")
			return Math.max(420, Math.min(780, Math.floor(viewportWidth / scale) - 40));
		if (bloomMode === "pomodoro") return Math.min(600, Math.floor(viewportWidth / scale) - 40);
		if (bloomMode === "wallpaper") return wallpaperPanelWidth(viewportWidth, scale);
		if (bloomMode === "wifi" || bloomMode === "bluetooth") return 350;
		if (bloomMode === "command-center" && isHovered) return 350;
		if (bloomMode === "status" && isHovered) {
			const totalWidgets = statusWidgets.left.length + statusWidgets.right.length;
			// Wide enough for the three performance rings shown below the bar.
			// Wide enough for the dashboard panel (up to 640px, less on a narrow monitor).
			return Math.max(
				Math.min(640, Math.floor(viewportWidth / scale) - 40),
				Math.min(200 + totalWidgets * 50, 380)
			);
		}
		if (isMusicMode && isHovered) return mediaLayout === "compact" ? 300 : 340;
		if ((showPowerPulse || showLowBatteryPulse || showUpdatePulse) && !isHovered) return 200;

		let w = 140;
		if (isMusicMode) {
			w = 140;
			if (settingsVisualizerEnabled && isPlaying) w += 30;
			if (settingsAlbumArtEnabled) w += 30;

			if (isHovered) {
				w += 60;
			}
		}

		return w;
	};

	const getDynamicHeightRaw = () => {
		if (!isExpanded || !isVisible || isHidden) {
			return isImpacted ? 28.9 : 44.2;
		}
		// Announcement card: body is line-clamped, so a fixed size fits both cases.
		if (bloomMode === "announcement" && announcement && !announcementDismissed) {
			return announcement.url ? 168 : 148;
		}
		if (bloomMode === "tasks") return 385;
		if (bloomMode === "pomodoro") return 300;
		if (bloomMode === "wallpaper") return WALLPAPER_PANEL_HEIGHT;
		if (bloomMode === "wifi" || bloomMode === "bluetooth") return 300;
		if (bloomMode === "command-center") return isHovered ? 230 : 36;
		if (bloomMode === "status") return isHovered ? 332 : 36;
		if (isMusicMode && isHovered) {
			const hasProgressBar = (mediaInfo.duration_ms ?? 0) > 0;
			let h = mediaLayout === "compact" ? (hasProgressBar ? 132 : 116) : 120;
			if (mediaLayout === "compact") {
				if (compactVolumeExpanded) h += 36;
			}
			return h;
		}
		return 36;
	};
	// Side bar on: with the status row gone, every panel below it is that much shorter. The expanded
	// music view never had the row, so it keeps its height.
	const getDynamicHeight = () => {
		const h = getDynamicHeightRaw();
		if (!sbStrip || h <= 40 || (isMusicMode && isHovered)) return h;
		return h - SB_BAR_H;
	};
	if (sbStrip && sbShown && isReady) {
		sbSize.current = { w: getDynamicWidth(), h: getDynamicHeight() };
	}

	// Hover release, shared by the DOM hover-end handler and by setNotchPinned.
	// Returns the notch to its resting mode, like the pointer leaving always did.
	const notchPinnedRef = useRef(false);
	// The panel (controls, dashboard, to-do list, timer) the notch was on when it last closed; it opens on
	// that one again instead of always going back to the dashboard.
	const lastPanelRef = useRef<"command-center" | "status" | "tasks" | "pomodoro">("status");
	// Side bar on: Controls and Time gun are the side bar's popups, so the notch never opens on them.
	const notchPanel = (m: "command-center" | "status" | "tasks" | "pomodoro") =>
		sbStrip && (m === "command-center" || m === "pomodoro") ? "status" : m;
	const releaseDeferredRef = useRef(false);
	const releaseNotchHoverRef = useRef<() => void>(() => {});
	const doRelease = () => {
		if (
			bloomMode === "command-center" ||
			bloomMode === "status" ||
			bloomMode === "tasks" ||
			bloomMode === "pomodoro"
		) {
			lastPanelRef.current = bloomMode;
		}
		setIsHovered(false);
		const targetMode =
			mediaInfo.has_media && isPlaying && settingsMusicCompactNotch ? "music" : "status";
		if (bloomMode === "music") {
			setBloomMode(targetMode);
		} else if (
			bloomMode === "command-center" ||
			bloomMode === "tasks" ||
			bloomMode === "pomodoro" ||
			bloomMode === "status" ||
			bloomMode === "wifi" ||
			bloomMode === "bluetooth"
		) {
			setBloomMode(targetMode);
		}
	};
	const doReleaseRef = useRef(doRelease);
	doReleaseRef.current = doRelease;
	const releaseNotchHover = () => {
		if (!sbStrip) {
			doRelease();
			return;
		}
		// Side bar on: slide the open notch back up first, then collapse it once it is out of sight.
		if (sbClosingRef.current != null) return;
		setSbLeaving(true);
		sbClosingRef.current = window.setTimeout(() => {
			sbClosingRef.current = null;
			setSbLeaving(false);
			doReleaseRef.current();
		}, SB_CLOSE_MS);
	};
	sbCancelRef.current = () => {
		if (sbClosingRef.current == null) return;
		clearTimeout(sbClosingRef.current);
		sbClosingRef.current = null;
		setSbLeaving(false);
	};
	releaseNotchHoverRef.current = releaseNotchHover;

	// Side bar on: open and close the notch from the pointer position, read straight from the OS, so it
	// does not depend on the backend's edge detection. Opens at the top edge near the centre, closes
	// once the pointer has been away from the open notch for a moment. Same state changes as the
	// notch's own hover handlers.
	const sbLive = useRef({ hovered: false, mode: "status", wallpaper: false });
	sbLive.current = { hovered: isHovered, mode: bloomMode, wallpaper: wallpaperOpen };
	useEffect(() => {
		if (windowLabel !== "main" || !sbStrip) return;
		const win = getCurrentWebviewWindow();
		let busy = false;
		let away = 0;
		// Hysteresis: the notch's rectangle is still sliding in for a moment after it opens, so measuring
		// against it live made the pointer look "away" and closed it again (the jump). Give a fresh open a
		// grace period and test against the largest area the notch has covered since it opened.
		let openedAt = 0;
		let box: { l: number; r: number; b: number } | null = null;
		let cursorFn: (() => Promise<{ x: number; y: number }>) | null = null;
		const tick = async () => {
			if (busy) return;
			// A notch that has just opened counts as "inside" anyway (grace period below), so while it is still
			// sliding in nothing is measured: no calls into Rust and no layout read in the middle of the slide.
			if (sbLive.current.hovered && performance.now() - openedAt < 450) {
				sbCancelRef.current();
				return;
			}
			busy = true;
			try {
				if (!cursorFn) {
					// cursorPosition is a module-level function in @tauri-apps/api/window, not a window method.
					const m: any = await import("@tauri-apps/api/window");
					cursorFn = m.cursorPosition ?? null;
					if (!cursorFn) throw new Error("cursorPosition missing: update @tauri-apps/api");
				}
				const [cur, outer, sf] = await Promise.all([
					cursorFn(),
					win.outerPosition(),
					win.scaleFactor()
				]);
				const x = (cur.x - outer.x) / sf;
				const y = (cur.y - outer.y) / sf;
				const vw = window.innerWidth;
				const inTopZone = y >= -4 && y <= 3 && Math.abs(x - vw / 2) <= 180;
				const live = sbLive.current;
				if (!live.hovered) {
					away = 0;
					// Not again while the notch is still opening.
					if (inTopZone && performance.now() - openedAt > 400) {
						releaseDeferredRef.current = false;
						openedAt = performance.now();
						box = null;
						setIsHovered(true);
						if (
							live.mode !== "announcement" &&
							live.mode !== "wifi" &&
							live.mode !== "bluetooth" &&
							live.mode !== "wallpaper"
						) {
							setBloomMode(notchPanel(lastPanelRef.current));
						}
					}
				} else if (!live.wallpaper) {
					const r = bloomRef.current?.getBoundingClientRect();
					if (r && r.height > 0) {
						box = box
							? {
									l: Math.min(box.l, r.left),
									r: Math.max(box.r, r.right),
									b: Math.max(box.b, r.bottom)
								}
							: { l: r.left, r: r.right, b: r.bottom };
					}
					const inside =
						inTopZone ||
						performance.now() - openedAt < 600 ||
						(!!box &&
							y <= box.b + 14 &&
							x >= box.l - 14 &&
							x <= box.r + 14 &&
							y >= -4);
					away = inside ? 0 : away + 1;
					if (inside) sbCancelRef.current();
					if (away >= 5) {
						away = 0;
						box = null;
						if (notchPinnedRef.current) releaseDeferredRef.current = true;
						else releaseNotchHoverRef.current();
					}
				}
			} catch {
				// no cursor access: leave the notch to its own hover handling
			} finally {
				busy = false;
			}
		};
		const id = setInterval(tick, 50);
		return () => clearInterval(id);
	}, [sbStrip, windowLabel]); // eslint-disable-line react-hooks/exhaustive-deps

	// Called by views that take typed input; see the hover-end handler.
	const setNotchPinned = useCallback((pinned: boolean) => {
		notchPinnedRef.current = pinned;
		if (!pinned && releaseDeferredRef.current) {
			releaseDeferredRef.current = false;
			releaseNotchHoverRef.current();
		}
	}, []);

	// Close compact media player expansions when notch is unhovered or mode changes
	useEffect(() => {
		if (mediaLayout === "compact") {
			setCompactVolumeExpanded(false);
		}
	}, [isHovered, mediaLayout, bloomMode]);

	return (
		<div className="screen" style={{ overflow: "hidden" }}>
			{/* Screen Corners (Top) */}
			<AnimatePresence>
				{isVisible && settingsCornersEnabled && !sbStrip && (
					<>
						<motion.div
							className="screen-corner top-left"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
						/>
						<motion.div
							className="screen-corner top-right"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
						/>
					</>
				)}
			</AnimatePresence>

			<div style={{ zoom: scale, width: "100%", display: "flex", justifyContent: "center" }}>
				<motion.div
					ref={bloomRef}
					className={`bloom ${isHovered ? "expanded" : ""} ${bloomMode === "pomodoro" ? "tg-open" : ""} ${sbStrip ? "is-impacted sb-strip" : ""} ${sbStrip && !sbShown ? "sb-closing" : ""} ${sbStrip && sbLanded && sbShown ? "sb-landed" : ""}`}
					onMouseEnter={() => setIsNotchHovered(true)}
					onMouseLeave={() => setIsNotchHovered(false)}
					onWheel={handleWheel}
					initial={{
						y: 250,
						width: 30.6,
						height: 44.2,
						borderTopLeftRadius: 18,
						borderTopRightRadius: 18,
						borderBottomLeftRadius: 18,
						borderBottomRightRadius: 18,
						scaleX: 1,
						scaleY: 1,
						opacity: 0
					}}
					animate={{
						y: !isReady
							? 250
							: isVisible
								? sbStrip
									? sbShown && sbGo
										? sbTop
										: -(sbSize.current.h + 24)
									: isHidden
										? -100
										: NOTCH_FLOAT_GAP
								: -150,
						width: !isReady
							? 34
							: sbStrip && !sbShown
								? sbSize.current.w
								: isExpanded && isVisible && !isHidden
								? getDynamicWidth()
								: isImpacted
									? 39.1
									: 30.6,
						height: !isReady ? 34 : sbStrip && !sbShown ? sbSize.current.h : getDynamicHeight(),
						opacity: isVisible ? (sbStrip && !sbShown && sbGone ? 0 : 1) : 0,
						scaleX: 1,
						scaleY: 1,
						borderTopLeftRadius: sbStrip
							? 0
							: bloomMode === "tasks" || bloomMode === "pomodoro" || bloomMode === "wallpaper"
								? 28
								: 18,
						borderTopRightRadius: sbStrip
							? 0
							: bloomMode === "tasks" || bloomMode === "pomodoro" || bloomMode === "wallpaper"
								? 28
								: 18,
						borderBottomLeftRadius: bloomMode === "tasks" || bloomMode === "pomodoro" || bloomMode === "wallpaper" ? 28 : 18,
						borderBottomRightRadius: bloomMode === "tasks" || bloomMode === "pomodoro" || bloomMode === "wallpaper" ? 28 : 18,
						pointerEvents: isVisible && !(sbStrip && !sbShown) ? "auto" : "none"
					}}
					onClick={(e) => {
						e.stopPropagation();
					}}
					onHoverStart={() => {
						// Side bar on: the OS cursor check is the only thing that opens or closes the notch. The
						// notch slides in under a still pointer and lands 8px lower, which fires this start/end pair
						// mid-open and used to re-trigger the open (and the close). Only a notch that is shown
						// without a hover (announcement, wallpaper panel) still expands when the pointer reaches it.
						if (sbStrip) {
							sbCancelRef.current();
							if (isHovered || !(announceOpen || wallpaperOpen)) return;
						}
						sbCancelRef.current();
						releaseDeferredRef.current = false;
						setIsHovered(true);
						if (
							bloomMode !== "announcement" &&
							bloomMode !== "wifi" &&
							bloomMode !== "bluetooth" &&
							bloomMode !== "wallpaper"
						) {
							setBloomMode(notchPanel(lastPanelRef.current));
						}
					}}
					onHoverEnd={() => {
						if (sbStrip) return;
						// A view being typed into (a Wi-Fi password) keeps the notch open; the
						// release happens once it lets go, if the pointer is still away.
						if (notchPinnedRef.current) {
							releaseDeferredRef.current = true;
							return;
						}
						releaseNotchHover();
					}}
					// Side bar on: keep the notch on its own layer so it is not rebuilt from scratch on every open.
					style={{ originY: 0, y: sbY, willChange: sbStrip ? "transform" : undefined }}
					transition={{
						// Side bar on: the size snaps while the notch is out of sight, so only the slide is seen.
						width: sbStrip && sbGone ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 31 },
						height: sbStrip && sbGone ? { duration: 0 } : { type: "spring", stiffness: 450, damping: 29 },
						y: sbStrip
							? sbShown
								? SB_OPEN_SPRING
								: { duration: SB_CLOSE_S, ease: [0.4, 0, 1, 1] }
							: { type: "spring", stiffness: 550, damping: 45, mass: 0.8, restDelta: 0.001 },
						// Side bar on: no fade. It appears the instant it starts growing and disappears once it
						// has shrunk back into the strip.
						opacity: { duration: sbStrip ? 0 : 0.2 },
						borderTopLeftRadius: { type: "spring", stiffness: 1000, damping: 40 },
						borderTopRightRadius: { type: "spring", stiffness: 1000, damping: 40 },
						borderBottomLeftRadius: { type: "spring", stiffness: 1000, damping: 40 },
						borderBottomRightRadius: { type: "spring", stiffness: 1000, damping: 40 },
						default: { type: "spring", stiffness: 500, damping: 30, mass: 1 }
					}}
				>
					{sbStrip && (
						<div
							ref={sbBridgeRef}
							aria-hidden
							style={{
								position: "absolute",
								left: 0,
								right: 0,
								top: -1,
								height: 1,
								background: "var(--notch-bg)",
								pointerEvents: "none"
							}}
						/>
					)}
					<AnimatePresence>
						{isMusicMode &&
							settingsAmbienceEnabled &&
							albumArtUrl &&
							isHovered && (
								<motion.div
									className="notch-ambient-glow"
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.15 }}
								>
									<AnimatePresence mode="wait">
										<motion.img
											key={albumArtUrl}
											src={albumArtUrl}
											alt=""
											draggable={false}
											initial={{ opacity: 0, scale: 1.1 }}
											animate={{ opacity: 1, scale: 1.8 }}
											exit={{ opacity: 0 }}
											transition={{ duration: 0.3 }}
										/>
									</AnimatePresence>
								</motion.div>
							)}
					</AnimatePresence>
					<AnimatePresence mode="wait">
						{isExpanded && (
							<motion.div
								key="bloom-content"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.1 }}
								style={{
									width: "100%",
									height: "100%",
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									position: "relative",
									borderRadius: "inherit",
									overflow: sbStrip && !sbShown ? "hidden" : undefined,
									visibility: sbStrip && !sbShown && sbContentHidden ? "hidden" : undefined
								}}
							>
								{/* Faster Waiting Transition Area */}
								<AnimatePresence mode="wait">
									{isHovered && isMusicMode ? (
										<motion.div
											key="expanded-music"
											className="expanded-music-container"
											initial={{ opacity: 0, scale: 0.98 }}
											animate={{ opacity: 1, scale: 1 }}
											exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 500, damping: 30 }}
										>
											{mediaLayout === "compact" ? (
												<CompactMediaPlayer
													mediaInfo={mediaInfo}
													albumArtUrl={albumArtUrl}
													albumArtKey={albumArtKey}
													isPlaying={isPlaying}
													volume={displayVolume}
													volumeExpanded={compactVolumeExpanded}
													onVolumeExpandedChange={setCompactVolumeExpanded}
													onTogglePlayPause={togglePlayPause}
													onVolumeChange={handleVolumeChange}
													prevFront={prevFront}
													prevBack={prevBack}
													nextFront={nextFront}
													nextBack={nextBack}
													onAnimatePrev={animatePrev}
													onAnimateNext={animateNext}
													onLayoutChange={(layout) => {
														setMediaLayout(layout);
														localStorage.setItem("bloom-media-layout", layout);
														invoke("save_setting", { key: "bloom-media-layout", value: layout }).catch(
															console.error
														);
														window.dispatchEvent(
															new CustomEvent("settings-changed", {
																detail: { key: "media-layout", value: layout }
															})
														);
													}}
												/>
											) : (
												<div className="compact-premium-layout">
													<div className="album-art-section">
														<motion.div
															className="premium-album-art"
															whileHover={{ scale: 1.05 }}
															whileTap={{ scale: 0.95 }}
															onClick={(e) => {
																e.stopPropagation();
																setMediaLayout("compact");
																localStorage.setItem("bloom-media-layout", "compact");
																invoke("save_setting", {
																	key: "bloom-media-layout",
																	value: "compact"
																}).catch(console.error);
																window.dispatchEvent(
																	new CustomEvent("settings-changed", {
																		detail: { key: "media-layout", value: "compact" }
																	})
																);
															}}
															style={{ cursor: "pointer" }}
														>
															<AnimatePresence mode="wait" initial={false}>
																{albumArtUrl ? (
																	<motion.img
																		key={`art-${albumArtKey}`}
																		src={albumArtUrl}
																		alt="Art"
																		initial={{ rotateY: 90, opacity: 0 }}
																		animate={{ rotateY: 0, opacity: 1 }}
																		exit={{ rotateY: -90, opacity: 0 }}
																		transition={{ duration: 0.3, ease: "easeInOut" }}
																		style={{ width: "100%", height: "100%", objectFit: "cover" }}
																	/>
																) : (
																	<motion.div
																		key="placeholder"
																		className="art-placeholder-mini"
																		initial={{ rotateY: 90, opacity: 0 }}
																		animate={{ rotateY: 0, opacity: 1 }}
																		exit={{ rotateY: -90, opacity: 0 }}
																		transition={{ duration: 0.3, ease: "easeInOut" }}
																	>
																		<MusicNoteIcon size={32} className="music-placeholder-svg" />
																	</motion.div>
																)}
															</AnimatePresence>
														</motion.div>
													</div>

													<div className="metadata-controls-section-middle">
														<div className="track-header-row">
															<div className="track-info-middle">
																<TitleMarquee title={mediaInfo.title} />
																<span className="premium-artist">{mediaInfo.artist}</span>
															</div>
															<div className="header-visualizer-wrap">
																<div className="header-visualizer">
																	<Visualizer isPlaying={isPlaying} bars={5} height={18} />
																</div>
																<motion.button
																	className="classic-audio-output-btn"
																	onClick={(e) => {
																		e.stopPropagation();
																		invoke("open_sound_settings").catch(() => {});
																	}}
																	whileTap={{ scale: 0.9 }}
																	title="Audio Output"
																>
																	<HeadphonesIcon size={20} style={{ opacity: 0.5 }} />
																</motion.button>
															</div>
														</div>

														<div className="controls-row-sleek">
															<motion.button
																className="sleek-btn previous-btn"
																onClick={(e) => {
																	e.stopPropagation();
																	animatePrev();
																}}
																whileHover={{ scale: 1.2 }}
																whileTap={{ scale: 0.9 }}
																transition={{ type: "spring", stiffness: 400, damping: 25 }}
															>
																<div
																	style={{
																		position: "relative",
																		width: 32,
																		height: 16,
																		overflow: "hidden"
																	}}
																>
																	<motion.div
																		animate={prevBack}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipBackIcon size={32} />
																	</motion.div>
																	<motion.div
																		animate={prevFront}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipBackIcon size={32} />
																	</motion.div>
																</div>
															</motion.button>

															<motion.button
																className="sleek-btn play-pause-btn-floating"
																onClick={(e) => {
																	e.stopPropagation();
																	togglePlayPause();
																}}
																whileHover={{ scale: 1.2 }}
																whileTap={{ scale: 0.95 }}
																transition={{ type: "spring", stiffness: 400, damping: 25 }}
															>
																<AnimatePresence mode="wait" initial={false}>
																	<motion.div
																		key={isPlaying ? "pause" : "play"}
																		initial={{ opacity: 0, scale: 0.8 }}
																		animate={{ opacity: 1, scale: 1 }}
																		exit={{ opacity: 0, scale: 0.8 }}
																		transition={{ duration: 0.15 }}
																		style={{
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		{isPlaying ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
																	</motion.div>
																</AnimatePresence>
															</motion.button>

															<motion.button
																className="sleek-btn next-btn"
																onClick={(e) => {
																	e.stopPropagation();
																	animateNext();
																}}
																whileHover={{ scale: 1.2 }}
																whileTap={{ scale: 0.9 }}
																transition={{ type: "spring", stiffness: 400, damping: 25 }}
															>
																<div
																	style={{
																		position: "relative",
																		width: 32,
																		height: 16,
																		overflow: "hidden"
																	}}
																>
																	<motion.div
																		animate={nextBack}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipForwardIcon size={32} />
																	</motion.div>
																	<motion.div
																		animate={nextFront}
																		style={{
																			position: "absolute",
																			inset: 0,
																			display: "flex",
																			alignItems: "center",
																			justifyContent: "center"
																		}}
																	>
																		<SkipForwardIcon size={32} />
																	</motion.div>
																</div>
															</motion.button>
														</div>

														<div className="volume-slider-container">
															<VolumeLowIcon size={12} style={{ opacity: 0.5 }} />
															<div className="slider-track-premium">
																<input
																	type="range"
																	min="0"
																	max="1"
																	step="0.01"
																	value={displayVolume}
																	onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
																	onPointerDown={(e) => e.stopPropagation()}
																	onClick={(e) => e.stopPropagation()}
																	className="premium-slider"
																/>
																<div
																	className="slider-progress-fill"
																	style={{ width: `${displayVolume * 100}%` }}
																/>
															</div>
															<VolumeHighIcon size={14} style={{ opacity: 0.5 }} />
														</div>
													</div>
												</div>
											)}
										</motion.div>
									) : (
										<motion.div
											key="standard-view-group"
											initial={{ opacity: 0, y: -5 }}
											animate={{ opacity: 1, y: 0 }}
											exit={{ opacity: 0, y: 5, transition: { duration: 0.1 } }}
											transition={{ duration: 0.2 }}
											style={{ width: "100%" }}
										>
											{sbNoBar ? null : (
											<div className="main-row">
												<AnimatePresence mode="wait">
													{(showPowerPulse || showLowBatteryPulse || showUpdatePulse) &&
													!isHovered ? (
														showUpdatePulse ? (
															<motion.div
																key="update-pulse-view"
																initial={{ opacity: 0, scale: 0.95 }}
																animate={{ opacity: 1, scale: 1 }}
																exit={{ opacity: 0, scale: 1.05 }}
																className="power-pulse-content"
															>
																<GreenDownArrowIcon />
																<span className="label" style={{ color: "#32D74B" }}>
																	Update Available
																</span>
															</motion.div>
														) : (
															<motion.div
																key="pulse-view"
																initial={{ opacity: 0, scale: 0.95 }}
																animate={{ opacity: 1, scale: 1 }}
																exit={{ opacity: 0, scale: 1.05 }}
																className="power-pulse-content"
															>
																{updateAvailable && <GreenDownArrowIcon />}
																<BatteryIcon
																	charging={isCharging}
																	level={batteryLevel}
																	threshold={lowBatteryThreshold}
																/>
																<span
																	className="label"
																	style={{ color: showLowBatteryPulse ? "#FF453A" : "inherit" }}
																>
																	{showLowBatteryPulse
																		? "Low Battery"
																		: isCharging
																			? "Charging"
																			: "On Battery"}{" "}
																	• {batteryLevel}%
																</span>
															</motion.div>
														)
													) : (
														<motion.div
															key="standard-view"
															className="main-row-inner"
															initial={{ opacity: 0 }}
															animate={{ opacity: 1 }}
															exit={{ opacity: 0 }}
														>
															{/* Left: visualizer (music) or weather (command-center) */}
															<div className="side-content left">
																{isMusicMode && settingsVisualizerEnabled ? (
																	<AnimatePresence>
																		{settingsVisualizerEnabled && (
																			<motion.div
																				key="visualizer"
																				initial={{ scale: 0.8, opacity: 0 }}
																				animate={{ scale: 1, opacity: 1 }}
																				exit={{ scale: 0.8, opacity: 0 }}
																			>
																				<Visualizer isPlaying={isPlaying} />
																			</motion.div>
																		)}
																	</AnimatePresence>
																) : !isMusicMode && isHovered && statusWidgets.left.length > 0 ? (
																	<motion.div
																		key="left-widgets"
																		className="passive-features-group"
																		initial={{ opacity: 0 }}
																		animate={{ opacity: 1 }}
																		exit={{ opacity: 0 }}
																		transition={{ duration: 0.2 }}
																	>
																		{statusWidgets.left.map(renderStatusWidget)}
																	</motion.div>
																) : null}
															</div>

															{/* Center - Time (always visible) */}
															<div className="time-center">
																<div className="time-flip-container" onClick={(e) => e.stopPropagation()}>
																	<AnimatePresence initial={false}>
																		{pomoInNotch ? (
																			<motion.span
																				key="pomo"
																				className="time compact-timer"
																				style={pomo.running ? undefined : { color: "rgba(255, 255, 255, 0.55)" }}
																				initial={{ rotateX: -90, opacity: 0 }}
																				animate={{ rotateX: 0, opacity: 1 }}
																				exit={{ rotateX: 90, opacity: 0 }}
																				transition={{ type: "spring", stiffness: 600, damping: 30 }}
																			>
																				{formatTimerTime(pomoNotchSeconds)}
																			</motion.span>
																		) : (
																			<motion.span
																				key="clock"
																				className="time"
																				initial={{ rotateX: -90, opacity: 0 }}
																				animate={{ rotateX: 0, opacity: 1 }}
																				exit={{ rotateX: 90, opacity: 0 }}
																				transition={{ type: "spring", stiffness: 600, damping: 30 }}
																			>
																				{time}
																			</motion.span>
																		)}
																	</AnimatePresence>
																</div>
																{updateAvailable && showUpdateIndicator && (
																	<div className="update-dot" />
																)}
															</div>

															{/* Right: album art (music) or battery (command-center) */}
															<div className="side-content right">
																{isMusicMode && settingsAlbumArtEnabled ? (
																	<AnimatePresence mode="wait">
																		<motion.div
																			key="album-art"
																			className="album-art-glow-wrapper"
																			initial={{ opacity: 0, scale: 0.8 }}
																			animate={{ opacity: 1, scale: 1 }}
																			exit={{ opacity: 0, y: -20, scale: 0.8 }}
																			transition={{ duration: 0.12 }}
																		>
																			{albumArtUrl && settingsCompactGlowEnabled && (
																				<img
																					src={albumArtUrl}
																					alt=""
																					className="album-art-glow-bg"
																					draggable={false}
																				/>
																			)}
																			<button
																				className={`album-art${isHovered ? " album-art-large" : ""}${!isPlaying ? " paused" : ""}`}
																				onClick={(e) => {
																					e.stopPropagation();
																					togglePlayPause();
																				}}
																				onDoubleClick={(e) => {
																					e.stopPropagation();
																					skipNext();
																				}}
																				onContextMenu={(e) => {
																					e.preventDefault();
																					e.stopPropagation();
																					skipPrevious();
																				}}
																			>
																				<div className="album-art-inner">
																					<AnimatePresence mode="wait" initial={false}>
																						{albumArtUrl ? (
																							<motion.img
																								key={`compact-art-${albumArtKey}`}
																								src={albumArtUrl}
																								alt="Art"
																								draggable={false}
																								initial={{ rotateY: 90, opacity: 0 }}
																								animate={{ rotateY: 0, opacity: 1 }}
																								exit={{ rotateY: -90, opacity: 0 }}
																								transition={{ duration: 0.25, ease: "easeInOut" }}
																								style={{
																									width: "100%",
																									height: "100%",
																									objectFit: "cover"
																								}}
																							/>
																						) : (
																							<motion.div
																								key="compact-placeholder"
																								className="album-art-placeholder"
																								initial={{ rotateY: 90, opacity: 0 }}
																								animate={{ rotateY: 0, opacity: 1 }}
																								exit={{ rotateY: -90, opacity: 0 }}
																								transition={{ duration: 0.25, ease: "easeInOut" }}
																							>
																								<MusicNoteIcon className="music-placeholder-svg-small" />
																							</motion.div>
																						)}
																					</AnimatePresence>
																					<div className="album-art-overlay">
																						<div className="control-icon-small">
																							{isPlaying ? <PauseIcon /> : <PlayIcon />}
																						</div>
																					</div>
																				</div>
																			</button>
																		</motion.div>
																	</AnimatePresence>
																) : !isMusicMode && isHovered && statusWidgets.right.length > 0 ? (
																	<motion.div
																		key="right-widgets"
																		className="passive-features-group"
																		initial={{ opacity: 0 }}
																		animate={{ opacity: 1 }}
																		exit={{ opacity: 0 }}
																		transition={{ duration: 0.2 }}
																	>
																		{statusWidgets.right.map(renderStatusWidget)}
																	</motion.div>
																) : null}
															</div>
														</motion.div>
													)}
												</AnimatePresence>
											</div>
											)}
										</motion.div>
									)}
								</AnimatePresence>

								{/* Wi-Fi networks, opened from the controls panel's Wi-Fi tile */}
								<AnimatePresence>
									{bloomMode === "wifi" && (
										<motion.div
											key="wifi-view"
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<WifiPanel
												enabled={wifiEnabled}
												onToggle={toggleWifi}
												onBack={() => setBloomMode("command-center")}
												onPinChange={setNotchPinned}
											/>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Bluetooth devices, opened from the controls panel's Bluetooth tile */}
								<AnimatePresence>
									{bloomMode === "bluetooth" && (
										<motion.div
											key="bluetooth-view"
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<BluetoothPanel
												enabled={bluetoothEnabled}
												onToggle={toggleBluetooth}
												onBack={() => setBloomMode("command-center")}
												onPinChange={setNotchPinned}
											/>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Wallpaper switcher (Alt+A) */}
								<AnimatePresence>
									{bloomMode === "wallpaper" && (
										<motion.div
											key="wallpaper-view"
											className="wp-panel"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<WallpaperPanel
												width={wallpaperPanelWidth(viewportWidth, scale)}
												onClose={closeWallpaper}
											/>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Command Center Panel */}
								<AnimatePresence>
									{bloomMode === "command-center" && (
										<motion.div
											className={`command-center-content-minimal ${audioSheetOpen || textSheetOpen ? "cc-audio-open" : ""}`}
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											{/* Pills Grid */}
											<div className="cc-pills-grid">
												{/* Wi-Fi Pill */}
												<div
													className={`cc-pill-tile ${wifiEnabled ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														toggleWifi();
													}}
													onContextMenu={handleWifiRightClick}
													title="Left-click to toggle, Right-click for networks"
												>
													<div className="cc-pill-icon-wrapper">
														<WifiIcon enabled={wifiEnabled} connected={wifiConnected} />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Wi-Fi</span>
														<span className="cc-pill-status">
															{wifiStatus === null
																? "…"
																: !wifiEnabled
																	? "Off"
																	: wifiConnected
																		? (wifiStatus?.ssid ?? "Connected")
																		: "Not connected"}
														</span>
													</div>
													<button
														className="cc-pill-more"
														aria-label="Wi-Fi networks"
														title="Wi-Fi networks"
														onClick={(e) => {
															e.stopPropagation();
															setBloomMode("wifi");
														}}
													>
														<ChevronRight />
													</button>
												</div>

												{/* Dock Mode Pill */}
												<div
													className="cc-pill-tile"
													onClick={cycleTheme}
													title="Cycle theme: Custom / Dark / Light"
												>
													<div className="cc-pill-icon-wrapper">
														<ThemeIcon />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Theme</span>
														<span className="cc-pill-status">
															{THEME_LABELS[themeModeState] ?? themeModeState}
														</span>
													</div>
												</div>

												{/* Bluetooth Pill */}
												<div
													className={`cc-pill-tile ${bluetoothEnabled ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														toggleBluetooth();
													}}
													onContextMenu={handleBluetoothRightClick}
													title="Left-click to toggle, Right-click for devices"
												>
													<div className="cc-pill-icon-wrapper">
														<BluetoothIcon />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Bluetooth</span>
														<span className="cc-pill-status">
															{!bluetoothEnabled
																? "Off"
																: btConnectedNames.length === 1
																	? btConnectedNames[0]
																	: btConnectedNames.length > 1
																		? `${btConnectedNames.length} connected`
																		: "On"}
														</span>
													</div>
													<button
														className="cc-pill-more"
														aria-label="Bluetooth devices"
														title="Bluetooth devices"
														onClick={(e) => {
															e.stopPropagation();
															setBloomMode("bluetooth");
														}}
													>
														<ChevronRight />
													</button>
												</div>

												{/* Notch Mode Pill */}
												<div
													className={`cc-pill-tile ${notchMode === "fixed" ? "active" : ""}`}
													onClick={toggleNotchModeSetting}
													title="Cycle notch mode: Fixed / Smart / Peek"
												>
													<div className="cc-pill-icon-wrapper">
														<NotchIcon />
													</div>
													<div className="cc-pill-info">
														<span className="cc-pill-title">Notch Mode</span>
														<span className="cc-pill-status">
															{notchMode === "fixed"
																? "Fixed"
																: notchMode === "smart"
																	? "Smart"
																	: "Peek"}
														</span>
													</div>
												</div>
											</div>

											{/* Circular Actions Row */}
											<div className="cc-circular-actions-row">
												<button
													className={`cc-circular-btn ${dndActive ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														setDndActive((prev) => !prev);
													}}
													title={`Focus / DND: ${dndActive ? "On" : "Off"}`}
												>
													<MoonIcon />
												</button>
												<button
													className={`cc-circular-btn ${audioSheetOpen ? "active" : ""}`}
													onClick={(e) => {
														e.stopPropagation();
														toggleAudioSheet();
													}}
													title="Sound output"
												>
													<AudioOutputIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														launchGameOverlay();
													}}
													title="Game Overlay"
												>
													<GameControllerIcon />
												</button>
												<button
													className={`cc-circular-btn ${HEX_RE.test(textColor) ? "active" : ""}`}
													onClick={toggleTextSheet}
													title="Text color"
												>
													<TextColorIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														openSettingsWindow();
													}}
													title="Bloom Settings"
												>
													<SettingsIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														invoke("restart_bloom");
													}}
													title="Restart Bloom"
												>
													<ReloadIcon />
												</button>
												<button
													className="cc-circular-btn"
													onClick={(e) => {
														e.stopPropagation();
														invoke("cycle_bloom_monitor");
													}}
													title="Move Bloom to next monitor"
												>
													<svg
														width="16"
														height="16"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														strokeWidth="2"
														strokeLinecap="round"
														strokeLinejoin="round"
													>
														<rect x="2" y="4" width="8" height="12" rx="1" />
														<rect x="14" y="4" width="8" height="12" rx="1" />
														<path d="M6 20h12M12 16v4" />
												</svg>
												</button>
											</div>

											{/* Classic Sliders Area */}
											<div className="cc-classic-sliders-area">
												{/* Volume Slider */}
												<div className="cc-classic-slider-row">
													<div className="cc-classic-slider-label">
														<VolumeLowIcon style={{ opacity: 0.5 }} />
														<span>Volume</span>
													</div>
													<div className="cc-classic-slider-track">
														<input
															type="range"
															min="0"
															max="1"
															step="0.01"
															value={displayVolume}
															onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
															onPointerDown={(e) => e.stopPropagation()}
															onClick={(e) => e.stopPropagation()}
															className="cc-classic-input"
														/>
														<div
															className="cc-classic-fill"
															style={{ width: `${displayVolume * 100}%` }}
														/>
													</div>
													<span className="cc-classic-percentage">{Math.round(displayVolume * 100)}%</span>
												</div>

												{/* Brightness Slider */}
												<div className="cc-classic-slider-row">
													<div className="cc-classic-slider-label">
														<BrightnessLowIcon />
														<span>Brightness</span>
													</div>
													<div className="cc-classic-slider-track">
														<input
															type="range"
															min="0"
															max="100"
															step="1"
															value={currentBrightness}
															onChange={(e) => handleBrightnessChange(parseInt(e.target.value))}
															onPointerDown={(e) => e.stopPropagation()}
															onClick={(e) => e.stopPropagation()}
															className="cc-classic-input"
														/>
														<div
															className="cc-classic-fill"
															style={{ width: `${currentBrightness}%` }}
														/>
													</div>
													<span className="cc-classic-percentage">{currentBrightness}%</span>
												</div>
											</div>

											{/* Text color picker */}
											<AnimatePresence>
												{textSheetOpen && (
													<motion.div
														className="cc-audio-sheet"
														ref={(el: HTMLDivElement | null) => {
															el?.addEventListener("wheel", stopWheelPropagation, { passive: true });
														}}
														onClick={(e) => e.stopPropagation()}
														initial={{ opacity: 0, y: 28, scale: 0.97 }}
														animate={{ opacity: 1, y: 0, scale: 1 }}
														exit={{ opacity: 0, y: 18, scale: 0.98, transition: { duration: 0.14 } }}
														transition={{ type: "spring", stiffness: 420, damping: 32 }}
													>
														<div className="cc-audio-header">
															<span className="cc-audio-title">Text Color</span>
															<button
																className="cc-audio-close"
																onClick={(e) => {
																	e.stopPropagation();
																	setTextSheetOpen(false);
																}}
																title="Close"
															>
																<X size={13} strokeWidth={2.2} />
															</button>
														</div>
														<div className="cc-tc-body">
															<div className="cc-tc-left">
																<div
																	className="cc-tc-sv"
																	style={{
																		background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${pickerHsv.h}, 100%, 50%))`
																	}}
																	onPointerDown={(e) => {
																		e.currentTarget.setPointerCapture(e.pointerId);
																		pickTextSV(e);
																	}}
																	onPointerMove={(e) => {
																		if (e.currentTarget.hasPointerCapture(e.pointerId)) pickTextSV(e);
																	}}
																>
																	<div
																		className="cc-tc-knob"
																		style={{ left: `${pickerHsv.s * 100}%`, top: `${(1 - pickerHsv.v) * 100}%` }}
																	/>
																</div>
																<input
																	type="range"
																	className="cc-tc-hue"
																	min={0}
																	max={360}
																	value={Math.round(pickerHsv.h)}
																	onChange={(e) => {
																		const h = Number(e.target.value);
																		const hex = hsvToHex(h, pickerHsv.s, pickerHsv.v);
																		setPickerHsv({ ...pickerHsv, h });
																		setHexDraft(hex);
																		liveTextColor(hex);
																	}}
																/>
															</div>
															<div className="cc-tc-right">
																<div
																	className="cc-tc-swatch"
																	style={{ background: HEX_RE.test(textColor) ? textColor : currentThemeTextHex() }}
																/>
																<input
																	className="cc-tc-hex"
																	value={hexDraft}
																	maxLength={7}
																	spellCheck={false}
																	onChange={(e) => {
																		const v = e.target.value;
																		setHexDraft(v);
																		if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
																			const hex = normalizeHex(v);
																			if (hex) {
																				setPickerHsv(hexToHsv(hex));
																				liveTextColor(hex);
																			}
																		}
																	}}
																	onBlur={() => {
																		const hex = normalizeHex(hexDraft);
																		if (hex) {
																			setHexDraft(hex);
																			setPickerHsv(hexToHsv(hex));
																			liveTextColor(hex);
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
																	className={`cc-tc-auto ${textColor === "auto" ? "active" : ""}`}
																	onClick={(e) => {
																		e.stopPropagation();
																		resetTextColor();
																	}}
																	title="Use the theme's own text color"
																>
																	Auto
																</button>
															</div>
														</div>
													</motion.div>
												)}
											</AnimatePresence>
											{/* Sound output picker */}
											<AnimatePresence>
												{audioSheetOpen && (
													<motion.div
														className="cc-audio-sheet"
														ref={(el: HTMLDivElement | null) => {
															el?.addEventListener("wheel", stopWheelPropagation, { passive: true });
														}}
														onClick={(e) => e.stopPropagation()}
														initial={{ opacity: 0, y: 28, scale: 0.97 }}
														animate={{ opacity: 1, y: 0, scale: 1 }}
														exit={{
															opacity: 0,
															y: 18,
															scale: 0.98,
															transition: { duration: 0.14 }
														}}
														transition={{ type: "spring", stiffness: 420, damping: 32 }}
													>
														<div className="cc-audio-header">
															<span className="cc-audio-title">Sound Output</span>
															<button
																className="cc-audio-close"
																onClick={(e) => {
																	e.stopPropagation();
																	setAudioSheetOpen(false);
																}}
																title="Close"
															>
																<X size={13} strokeWidth={2.2} />
															</button>
														</div>
														<div className="cc-audio-list">
															{audioOutputs.length === 0 ? (
																<div className="cc-audio-empty">No output devices found</div>
															) : (
																audioOutputs.map((device, i) => (
																	<motion.button
																		key={device.id}
																		className={`cc-audio-item ${device.isDefault ? "active" : ""}`}
																		onClick={(e) => {
																			e.stopPropagation();
																			pickAudioOutput(device.id);
																		}}
																		initial={{ opacity: 0, x: -12 }}
																		animate={{ opacity: 1, x: 0 }}
																		transition={{
																			type: "spring",
																			stiffness: 500,
																			damping: 34,
																			delay: 0.05 + i * 0.045
																		}}
																		whileTap={{ scale: 0.98 }}
																		title={device.name}
																	>
																		<span className="cc-audio-item-icon">
																			<AudioOutputIcon />
																		</span>
																		<span className="cc-audio-item-name">{device.name}</span>
																		<AnimatePresence>
																			{device.isDefault && (
																				<motion.span
																					className="cc-audio-check"
																					initial={{ scale: 0, opacity: 0 }}
																					animate={{ scale: 1, opacity: 1 }}
																					exit={{ scale: 0, opacity: 0 }}
																					transition={{ type: "spring", stiffness: 600, damping: 26 }}
																				>
																					<Check size={14} strokeWidth={2.6} />
																				</motion.span>
																			)}
																		</AnimatePresence>
																	</motion.button>
																))
															)}
														</div>
													</motion.div>
												)}
											</AnimatePresence>
											{/* Theme popup */}
											<AnimatePresence>
												{themeToast && (
													<div className="cc-theme-toast-wrap">
														<motion.div
															key={themeToast}
															className="cc-theme-toast"
															initial={{ opacity: 0, y: 10, scale: 0.94 }}
															animate={{ opacity: 1, y: 0, scale: 1 }}
															exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.18 } }}
															transition={{ type: "spring", stiffness: 460, damping: 30 }}
														>
															{themeToast}
														</motion.div>
													</div>
												)}
											</AnimatePresence>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Announcement Card */}
								<AnimatePresence>
									{bloomMode === "announcement" &&
										announcement &&
										!announcementDismissed && (
											<motion.div
												className={`announcement-content severity-${announcement.severity}${isReminderAnnouncement ? " reminder-alert" : ""}${isPomoAlert ? " pomo-alert" : ""}`}
												onClick={(e) => e.stopPropagation()}
												initial={{ opacity: 0 }}
												animate={{ opacity: 1 }}
												exit={{
													opacity: 0,
													transition: { duration: 0.1 }
												}}
												transition={{ type: "spring", stiffness: 400, damping: 30 }}
											>
												<div className="announcement-header">
													<div className="announcement-heading">
														{isPomoAlert ? (
															<HardDrive size={14} className="announcement-icon" />
														) : isReminderAnnouncement ? (
															<BellRing size={14} className="announcement-icon" />
														) : (
															<Megaphone size={14} className="announcement-icon" />
														)}
														<span className="announcement-title">
															{announcement.title}
														</span>
													</div>
													<button
														className="announcement-close"
														onClick={dismissAnnouncement}
														title="Dismiss"
													>
														<X size={13} strokeWidth={2.2} />
													</button>
												</div>
												{announcement.body && (
													<p className="announcement-body">
														{announcement.body}
													</p>
												)}
												{announcement.url && (
													<button
														className="announcement-link"
														onClick={() => openUrl(announcement.url!)}
													>
														Learn more
													</button>
												)}
											</motion.div>
										)}
								</AnimatePresence>

								{/* Dashboard panel: tabbed, shown under the status bar while it is hovered */}
								<AnimatePresence>
									{(perfVisible || dashKeepAlive) && (
										<motion.div
											ref={setDashPanelEl}
											className="dash-panel"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ duration: sbStrip ? 0.1 : 0.18 }}
										>
											<DashTabs tab={dashTab} onChange={changeDashTab} host={dashPanelEl} />
											<DashBody tab={dashTab} dir={dashDir}>
												{dashTab === "dashboard" && (
													<DashboardTab
														weather={
															perfShowWeather ? (
																<DashWeather
																	Icon={WeatherIcon}
																	temperature={temperature ?? 0}
																	high={tempHigh}
																	low={tempLow}
																	unit={tempUnit === "fahrenheit" ? "F" : "C"}
																	condition={weatherCondition}
																	city={cityName}
																/>
															) : null
														}
														profile={profile?.info ?? null}
														uptimeSecs={
															profile ? profile.info.uptimeSecs + Math.floor((Date.now() - profile.at) / 1000) : null
														}
														avatar={avatar}
														onPickAvatar={pickAvatar}
														onResetAvatar={resetAvatar}
														notes={calendarNotes}
														onSaveNote={saveCalendarNote}
														cpu={cpuUsage}
														ram={ramUsage}
														ramFree={perf ? toGiB(perf.ramTotal - perf.ramUsed) : null}
														disk={
															perf?.diskUsed != null && perf.diskTotal
																? (perf.diskUsed / perf.diskTotal) * 100
																: null
														}
														diskFree={
															perf?.diskUsed != null && perf.diskTotal != null
																? toGiB(perf.diskTotal - perf.diskUsed)
																: null
														}
														drive={perfDrive}
														media={{
															hasMedia: mediaInfo.has_media,
															title: mediaInfo.title,
															artist: mediaInfo.artist,
															isPlaying,
															art: albumArtUrl
														}}
													/>
												)}
												{dashTab === "performance" && (
													<PerformanceTab
														cpuUsage={cpuUsage}
														cpuTemp={perf?.cpuTemp ?? null}
														cpuName={profile?.info.cpu ?? ""}
														gpuUsage={perf?.gpuUsage ?? null}
														gpuTemp={perf?.gpuTemp ?? null}
														gpuName={profile?.info.gpu ?? ""}
														ramUsed={perf?.ramUsed ?? null}
														ramTotal={perf?.ramTotal ?? null}
														diskUsed={perf?.diskUsed ?? null}
														diskTotal={perf?.diskTotal ?? null}
														drive={perfDrive}
														onCycleDrive={cyclePerfDrive}
														net={net}
														downHistory={netHistory.down}
														upHistory={netHistory.up}
													/>
												)}
												{dashTab === "profile" && (
													<ProfileTab
														profile={profile?.info ?? null}
														uptimeSecs={
															profile ? profile.info.uptimeSecs + Math.floor((Date.now() - profile.at) / 1000) : null
														}
														avatar={avatar}
														onPickAvatar={pickAvatar}
														onResetAvatar={resetAvatar}
													/>
												)}
												{dashTab === "windows" && (
													<WindowsTab
														windows={windowList}
														onFocus={(hwnd) => {
															invoke("focus_window", { hwnd }).catch(console.error);
														}}
														onClose={(hwnd) => {
															// Drop the row right away; if the window stays open (e.g. a "save changes?"
															// prompt) the next refresh puts it back.
															setWindowList((list) => list.filter((w) => w.hwnd !== hwnd));
															invoke("close_window", { hwnd }).catch(console.error);
														}}
													/>
												)}
											</DashBody>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Tasks Panel */}
								<AnimatePresence>
									{bloomMode === "tasks" && (
										<motion.div
											className="tasks-panel tb-panel"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											{/* The board is laid out at its final width from the first frame. While the notch is
											    still growing it only reveals more of the board (the panel clips it), so the task
											    text no longer re-wraps and the cards no longer shift as the notch opens. */}
											<div
												className="tb-fixed"
												style={{
													width: getDynamicWidth() - 32,
													marginLeft: -(getDynamicWidth() - 32) / 2,
													left: "50%",
													position: "relative",
													flex: "1 1 0",
													minHeight: 0,
													height: "100%",
													display: "flex",
													flexDirection: "column"
												}}
											>
												<TaskBoard
													tasks={tasks}
													onChange={updateTasks}
													draft={taskDraft}
													onDraftChange={setTaskDraft}
													time={taskTime}
													onTimeChange={setTaskTime}
													composer={taskComposer}
													onComposerChange={setTaskComposer}
													onAdd={addTask}
													onComplete={playTaskComplete}
													onSlotChange={() => playTaskSnap(false)}
													maxLength={TASK_MAX_LENGTH}
												/>
											</div>
										</motion.div>
									)}
								</AnimatePresence>

								{/* Time gun (Pomodoro) */}
								<AnimatePresence>
									{bloomMode === "pomodoro" && (
										<motion.div
											className="tg-panel"
											onClick={(e) => e.stopPropagation()}
											initial={{ opacity: 0 }}
											animate={{ opacity: 1 }}
											exit={{ opacity: 0, transition: { duration: 0.1 } }}
											transition={{ type: "spring", stiffness: 400, damping: 30 }}
										>
											<TimeGun
												phase={pomo.phase}
												running={pomo.running}
												remainingMs={
													pomo.running ? Math.max(0, pomo.endAt - Date.now()) : pomo.remainingMs
												}
												totalMs={phaseMs(pomo.phase, pomoDurations)}
												rounds={pomo.rounds}
												durations={pomoDurations}
												quoteSignal={pomoQuote}
												onToggle={togglePomodoro}
												onSkip={skipPomodoro}
												onReset={resetPomodoro}
												onDuration={changePomoDuration}
											/>
										</motion.div>
									)}
								</AnimatePresence>
							</motion.div>
						)}
					</AnimatePresence>
					{/* The outline of the joined notch (adaptive light and retro): its two sides and its rounded bottom. It is the
					    last child, so it is drawn over the panels, and it copies the notch's own corner radius, so it stays 2px thick
					    whatever the radius is (18 or 28) while that animates. See .sb-notch-ring in SidebarNotch.css. */}
					{sbStrip && <span className="sb-notch-ring" aria-hidden />}
				</motion.div>
			</div>
		</div>
	);
}

interface PerfExtras {
	cpuTemp: number | null;
	gpuTemp: number | null;
	gpuUsage: number | null;
	ramUsed: number;
	ramTotal: number;
	// Used and total bytes of the selected drive; null if it can't be read.
	diskUsed: number | null;
	diskTotal: number | null;
	drive: string;
	drives: string[];
}

const toGiB = (bytes: number) => bytes / 1024 ** 3;

function BluetoothIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
		</svg>
	);
}

function SettingsIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ opacity: 0.9 }}
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}

function BrightnessLowIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ opacity: 0.5 }}
		>
			<circle cx="12" cy="12" r="5" fill="currentColor" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
	);
}

function NotchIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M4 3h16a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
			<path d="M9 9v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V9" />
		</svg>
	);
}

// Text color picker
const HEX_RE = /^#[0-9a-f]{6}$/i;

// "#abc", "abc", "#aabbcc" -> "#aabbcc" (lowercase), or null if it isn't a hex color
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

// The text color the current theme is painting right now (used to start the picker)
function currentThemeTextHex(): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue("--bloom-text").trim();
	return normalizeHex(v) ?? "#ffffff";
}

function TextColorIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M6 16 12 4l6 12" />
			<path d="M8.4 12h7.2" />
			<path d="M4 21h16" strokeWidth="3" />
		</svg>
	);
}

function ReloadIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
		</svg>
	);
}

function AudioOutputIcon() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M11 5L6 9H2v6h4l5 4V5z" />
			<path d="M15.5 8.5a5 5 0 0 1 0 7" />
			<path d="M18.5 5.5a9 9 0 0 1 0 13" />
		</svg>
	);
}

export default App;
