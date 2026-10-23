import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
	AnimatePresence,
	animate as animateValue,
	motion,
	useMotionValue,
	useReducedMotion,
	useTransform
} from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
	Check,
	ChevronLeft,
	Copy,
	Headphones,
	ImagePlus,
	Monitor,
	RefreshCw,
	Volume2,
	X
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { MusicNoteIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "./icons";
import { scopeTrace } from "./scopeTrace";
import "./DashboardProfile.css";
import { Floppy } from "./Floppy";
import { DashDiskArt } from "./DashDisk";
import { useDiskVariant } from "./useDiskVariant";
import { CUBE_FLAME_FRAMES, CUBE_FLAME_FRAME_SECONDS, CUBE_FLAME_VIEWBOX } from "./cubeFlame";
import { ScopeWave } from "./ScopeWave";
import { MediaScope } from "./MediaScope";
import "./MediaTab.css";
import "./MediaFit.css";
import "./MediaDisk.css";
import "./CubeFlame.css";
// Pressing the album disk on the dashboard's now-playing card lets a music note out (self-installing).
import "./diskNotes";

// Without a picture the tab is just the cover and the info, centred as one group and scaled to
// fill the tab. These are that group's size in px, counting the rings that stick out past the
// info column on the right, with a little room around it. The scale is whichever of the two
// limits is reached first, kept between the min and the max.
const SOLO_FIT_W = 500;
const SOLO_FIT_H = 205;
const SOLO_FIT_MIN = 0.75;
const SOLO_FIT_MAX = 1.3;

export interface MediaTabInfo {
	hasMedia: boolean;
	title: string;
	artist: string;
	album: string;
	// Raw app id of the player (for example "Spotify.exe"), shown as a friendly name.
	source: string;
	art: string | null;
	isPlaying: boolean;
	positionMs: number;
	durationMs: number;
	seekEnabled: boolean;
	positionUpdatedAt: number;
}

/**
 * True while the retro theme is active.
 *
 * theme.ts sets the theme class on <html> and swapping themes swaps that class,
 * so observing it keeps this in step with the cycle button and with a
 * settings.json edit made outside the app -- there is no theme event to use.
 */
function useRetroTheme(): boolean {
	const [retro, setRetro] = useState(
		() => typeof document !== "undefined" && document.documentElement.classList.contains("theme-retro")
	);
	useEffect(() => {
		const root = document.documentElement;
		const sync = () => setRetro(root.classList.contains("theme-retro"));
		sync();
		const obs = new MutationObserver(sync);
		obs.observe(root, { attributes: true, attributeFilter: ["class"] });
		return () => obs.disconnect();
	}, []);
	return retro;
}

// Ring of bars around the cover. The backend only reports a handful of frequency bands (a few
// times a second, and fairly jumpy), so the bars do their own smoothing: each bar chases its
// target with a quick rise and a slow fall, neighbours are blended so the ring flows instead
// of stepping, and every bar gets a slow wobble of its own so it never looks rigid.
const RING_BARS = 36;
// The cover is 90px across, so the bars start right at its edge.
const RING_RADIUS = 45;
const BAR_MIN = 4;
const BAR_MAX = 22;
const IDLE_LEVEL = 0.18;
// Circumference of the volume ring drawn on the cover (radius 41).
const VOL_ARC = 2 * Math.PI * 41;
// Time constants in ms: how fast a bar rises to a louder level and falls back from it.
const RISE_MS = 55;
const FALL_MS = 260;

const ringLevel = (bands: number[], index: number): number => {
	if (bands.length === 0) return IDLE_LEVEL;
	const t = index / RING_BARS;
	const mirrored = t < 0.5 ? t * 2 : (1 - t) * 2;
	const pos = mirrored * (bands.length - 1);
	const lo = Math.floor(pos);
	const hi = Math.min(bands.length - 1, lo + 1);
	// Smoothstep between the two nearest bands so the ring has no visible corners.
	const f = pos - lo;
	const eased = f * f * (3 - 2 * f);
	const v = bands[lo] + (bands[hi] - bands[lo]) * eased;
	return Math.max(IDLE_LEVEL, Math.min(1, v));
};

// Each bar wobbles at its own speed and offset (fixed numbers, so it is the same every time).
const WOBBLE = Array.from({ length: RING_BARS }, (_, i) => ({
	speed: 0.7 + (((i * 7) % 11) / 11) * 1.1,
	phase: (i * 2.399) % (Math.PI * 2)
}));

// The disk makes one turn in 30 seconds, in 600 steps of 0.6 degrees (20 steps a second): a slow,
// ticking turn. Fewer steps look choppier, more look smoother; shorten the time to spin faster.
const DISK_TURN_SECONDS = 30;
const DISK_STEPS = 600;
const diskStep = (t: number) => Math.floor(t * DISK_STEPS) / DISK_STEPS;
// Half the disk's width in px (.mt-disk in MediaDisk.css is 110px): used to find the dark area to its right.
const DISK_HALF = 55;
// The angle the disk rests at: 0 is upright, a negative number leans it left.
const DISK_REST_DEG = 0;
// Where the disk was when the tab last went away. The tab is removed when the pill collapses, so
// without this the disk would start over at rest every time it comes back. With it the disk carries
// on from there: it keeps turning if the music still plays, or springs back to rest if the music
// was paused (from the player itself, say) while the tab was away.
let savedDiskAngle = DISK_REST_DEG;
// How it spins back when the music pauses: a spring, so it overshoots the resting angle and settles
// with a bounce. Lower damping bounces more (8 is bouncy, 20 barely bounces); higher stiffness is
// faster.
const DISK_SPIN_BACK = { type: "spring" as const, stiffness: 150, damping: 13 };
// How it spins up when the music starts: it eases in slowly from standing, builds to a very fast spin
// (the reference clip turns several times a second), holds it for a moment, then slows down for a
// long, soft landing until it is turning at the normal speed above, and carries on at that speed.
// Make the time longer for a lazier start and a longer landing; raise the peak for a faster middle
// (degrees per second, 360 is one turn a second).
const DISK_SPINUP_SECONDS = 3.8;
const DISK_SPINUP_PEAK_DEG_PER_SEC = 1800;
const DISK_STEADY_DEG_PER_SEC = 360 / DISK_TURN_SECONDS;
// Where the spin-up is up to speed (0 to 1 of the way through), and where the slowing down starts.
const SPINUP_RISE_END = 0.3;
const SPINUP_HOLD_END = 0.3;
const sstep = (x: number) => {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
};
// Speed over the spin-up. Up to SPINUP_HOLD_END: the normal speed eased in from standing, plus a fast
// spin that builds up and holds. After it: the speed comes down in an even ratio (the same fraction
// lost every moment, which is how the eye judges speed), not an even amount, so it keeps
// slowing gently all the way instead of dropping fast and then crawling. It ends exactly at the
// normal speed, with no jump when the slow turn takes over.
const diskSpinUpSpeed = (s: number) => {
	const rising =
		DISK_STEADY_DEG_PER_SEC * sstep(s) + DISK_SPINUP_PEAK_DEG_PER_SEC * sstep(s / SPINUP_RISE_END);
	if (s < SPINUP_HOLD_END) return rising;
	const peak =
		DISK_STEADY_DEG_PER_SEC * sstep(SPINUP_HOLD_END) + DISK_SPINUP_PEAK_DEG_PER_SEC;
	const u = sstep((s - SPINUP_HOLD_END) / (1 - SPINUP_HOLD_END));
	return DISK_STEADY_DEG_PER_SEC * Math.pow(peak / DISK_STEADY_DEG_PER_SEC, 1 - u);
};
// Angle turned so far at each point, added up once (it never changes).
const SPINUP_TABLE_STEPS = 400;
const DISK_SPINUP_ANGLES = (() => {
	const out = [0];
	for (let i = 1; i <= SPINUP_TABLE_STEPS; i++) {
		const mid = (i - 0.5) / SPINUP_TABLE_STEPS;
		out.push(out[i - 1] + (diskSpinUpSpeed(mid) * DISK_SPINUP_SECONDS) / SPINUP_TABLE_STEPS);
	}
	return out;
})();
const DISK_SPINUP_TOTAL_DEG = DISK_SPINUP_ANGLES[SPINUP_TABLE_STEPS];
// Same ticking steps as the slow turn, so the spin-up looks like the same disk.
const diskSpinUpEase = (s: number) => {
	if (s >= 1) return 1;
	const x = Math.max(0, s) * SPINUP_TABLE_STEPS;
	const i = Math.floor(x);
	const angle = DISK_SPINUP_ANGLES[i] + (DISK_SPINUP_ANGLES[i + 1] - DISK_SPINUP_ANGLES[i]) * (x - i);
	const step = 360 / DISK_STEPS;
	return (Math.floor(angle / step) * step) / DISK_SPINUP_TOTAL_DEG;
};

// No longer rendered (the scope replaced it); exported so the build does not flag it as unused.
export function RingBars({ isPlaying }: { isPlaying: boolean }) {
	const barRefs = useRef<(HTMLDivElement | null)[]>([]);
	const levelsRef = useRef<number[]>(Array(RING_BARS).fill(IDLE_LEVEL));
	const latestRef = useRef<number[]>([]);

	useEffect(() => {
		// Bars are written straight to the DOM (no React re-render per frame).
		const levels = levelsRef.current;
		const paint = () => {
			barRefs.current.forEach((el, i) => {
				if (!el) return;
				const level = levels[i];
				el.style.height = `${BAR_MIN + level * (BAR_MAX - BAR_MIN)}px`;
				// Solid enough to stay readable over the pale tag plates of the backdrop.
				el.style.opacity = String(0.75 + (level - IDLE_LEVEL) * 0.3);
			});
		};

		let unlisten: Promise<() => void> | null = null;
		if (isPlaying) {
			unlisten = listen<{ frequencies: number[] }>("audio-visualization", (event) => {
				latestRef.current = event.payload.frequencies;
			});
		} else {
			latestRef.current = [];
		}

		let frame = 0;
		let last = performance.now();
		const raw = new Array<number>(RING_BARS).fill(IDLE_LEVEL);
		const loop = (now: number) => {
			const dt = Math.min(now - last, 50);
			last = now;
			const t = now / 1000;
			const bands = latestRef.current;

			// Target level per bar, with its own slow wobble (only above the idle level, so a
			// quiet moment stays calm).
			for (let i = 0; i < RING_BARS; i++) {
				const base = ringLevel(bands, i);
				const wobble = 1 + 0.14 * Math.sin(t * WOBBLE[i].speed + WOBBLE[i].phase);
				raw[i] = Math.min(1, IDLE_LEVEL + (base - IDLE_LEVEL) * wobble);
			}

			let moving = false;
			for (let i = 0; i < RING_BARS; i++) {
				// Blend with the two neighbours so the ring flows.
				const target =
					raw[i] * 0.5 + (raw[(i + RING_BARS - 1) % RING_BARS] + raw[(i + 1) % RING_BARS]) * 0.25;
				const cur = levels[i];
				const tau = target > cur ? RISE_MS : FALL_MS;
				const next = cur + (target - cur) * (1 - Math.exp(-dt / tau));
				levels[i] = next;
				if (Math.abs(target - next) > 0.002) moving = true;
			}
			paint();
			// Stop animating once paused and settled; start again when playback resumes.
			if (isPlaying || moving) frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => {
			cancelAnimationFrame(frame);
			unlisten?.then((fn) => fn());
		};
	}, [isPlaying]);

	return (
		<>
			{Array.from({ length: RING_BARS }, (_, i) => (
				<div
					key={i}
					className="mt-bar-pivot"
					style={{ transform: `rotate(${(i * 360) / RING_BARS}deg)` }}
				>
					<div
						ref={(el) => {
							barRefs.current[i] = el;
						}}
						className="mt-bar"
						style={{ bottom: RING_RADIUS, height: BAR_MIN }}
					/>
				</div>
			))}
		</>
	);
}

const SOURCE_NAMES: Record<string, string> = {
	spotify: "Spotify",
	chrome: "Chrome",
	msedge: "Edge",
	edge: "Edge",
	firefox: "Firefox",
	brave: "Brave",
	opera: "Opera",
	vlc: "VLC",
	zune: "Media Player",
	itunes: "iTunes",
	applemusic: "Apple Music",
	tidal: "TIDAL",
	foobar: "foobar2000",
	// Browsers like Zen and Firefox report a hash-like id instead of a name.
	f0dc299d809b97: "Zen",
	"308046b0af4a39cb": "Firefox",
	zen: "Zen"
};

// "SpotifyAB.SpotifyMusic_xxx!Spotify" or "Spotify.exe" -> "Spotify"
const friendlySource = (id: string): string => {
	if (!id) return "";
	const tail = id.includes("!") ? id.split("!").pop() || id : id;
	const key = tail.replace(/\.exe$/i, "").toLowerCase();
	const known = Object.keys(SOURCE_NAMES).find((k) => key.includes(k));
	if (known) return SOURCE_NAMES[known];
	// An id we do not know that is just a long hex hash would only show up as a weird pill.
	if (/^[0-9a-f]{12,}$/.test(key)) return "";
	const last = key.split(".").pop() || key;
	return last.charAt(0).toUpperCase() + last.slice(1);
};

function formatTime(ms: number): string {
	if (ms <= 0) return "0:00";
	const total = Math.floor(ms / 1000);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// When the notch collapses to the pill the tab is removed, and every CSS animation in it (the
// orbit, the spinning cover and rings, the flame, ...) would start over from zero when it comes
// back. So the tab remembers how far each animation had got when it left, and puts that back
// when it returns: the animations pause while the pill is collapsed and carry on afterwards.
const savedAnimationTime = new Map<string, number>();

// An animation is identified by the element it runs on (tag and classes) and its keyframes name.
function animationKey(anim: Animation): string | null {
	const name = (anim as Animation & { animationName?: string }).animationName;
	const target = (anim.effect as KeyframeEffect | null)?.target;
	if (!name || !target) return null;
	return `${target.tagName}.${target.getAttribute("class") ?? ""}|${name}`;
}

interface AudioOutput {
	id: string;
	name: string;
	isDefault: boolean;
}

// Icon that fits the device: headphones, a monitor (HDMI / DisplayPort), or a speaker.
function OutputIcon({ name }: { name: string }) {
	if (/head|buds|airpods|earphone|bluetooth|hands-?free/i.test(name)) return <Headphones size={15} />;
	if (/hdmi|display|monitor|nvidia/i.test(name)) return <Monitor size={15} />;
	return <Volume2 size={15} />;
}

// ---- Volume mixer, shown beside the output list. Same commands as the volume overlay (Overlay.tsx):
// get_audio_sessions / set_app_volume / set_app_mute / get_app_icon. One vertical slider for the
// whole system volume, then one per app that is making sound. ----
interface AudioSession {
	pid: number;
	name: string;
	process_path: string | null;
	volume: number;
	is_muted: boolean;
}

// One vertical slider with a round button under it (the app icon, or a speaker for the master).
// While it is being dragged the percentage replaces the icon.
function MixTile({
	value,
	title,
	onChange,
	onDragChange,
	onAction,
	muted,
	children
}: {
	value: number;
	title: string;
	onChange: (volume: number) => void;
	onDragChange: (dragging: boolean) => void;
	onAction?: () => void;
	muted?: boolean;
	children: React.ReactNode;
}) {
	const barRef = useRef<HTMLDivElement>(null);
	const [dragging, setDragging] = useState(false);
	const pct = Math.round(value * 100);

	// Scrolling over the bar changes its volume: 5% per mouse notch, smaller steps on a touchpad
	// (the same feel as scrolling on the cover). A native listener, so it can stop the page from
	// also reacting to the wheel.
	const valueRef = useRef(value);
	valueRef.current = value;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		const el = barRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			event.stopPropagation();
			const step = Math.max(-0.06, Math.min(0.06, -event.deltaY * 0.0005));
			const next = Math.max(0, Math.min(1, valueRef.current + step));
			valueRef.current = next;
			onChangeRef.current(next);
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const fromY = (clientY: number) => {
		const rect = barRef.current?.getBoundingClientRect();
		if (!rect || rect.height === 0) return;
		onChange(Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height)));
	};
	const setDrag = (on: boolean) => {
		setDragging(on);
		onDragChange(on);
	};

	return (
		<div className={`mt-mix-tile${dragging ? " dragging" : ""}${muted ? " muted" : ""}`}>
			<div
				ref={barRef}
				className="mt-mix-bar"
				title={`${title} — ${pct}%`}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					setDrag(true);
					fromY(event.clientY);
				}}
				onPointerMove={(event) => {
					if (event.currentTarget.hasPointerCapture(event.pointerId)) fromY(event.clientY);
				}}
				onPointerUp={() => setDrag(false)}
				onPointerCancel={() => setDrag(false)}
			>
				<div className="mt-mix-fill" style={{ height: `${pct}%` }} />
			</div>
			<button
				type="button"
				className="mt-mix-action"
				title={onAction ? (muted ? "Unmute" : "Mute") : title}
				onClick={onAction}
				disabled={!onAction}
			>
				<span className="mt-mix-action-icon">{children}</span>
				<span className="mt-mix-action-pct">{pct}%</span>
			</button>
		</div>
	);
}

// The icon of the app (fetched once), or its first letter when it has none.
function AppMixTile({
	session,
	onChange,
	onDragChange,
	onMute
}: {
	session: AudioSession;
	onChange: (pid: number, volume: number) => void;
	onDragChange: (pid: number, dragging: boolean) => void;
	onMute: (pid: number) => void;
}) {
	const [icon, setIcon] = useState<string | null>(null);
	useEffect(() => {
		if (!session.process_path) return;
		let alive = true;
		invoke<string | null>("get_app_icon", {
			path: session.process_path,
			name: session.name,
			hwnd: null
		})
			.then((data) => {
				if (alive) setIcon(data);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [session.process_path, session.name]);

	return (
		<MixTile
			value={session.is_muted ? 0 : session.volume}
			title={session.name}
			muted={session.is_muted}
			onChange={(volume) => onChange(session.pid, volume)}
			onDragChange={(on) => onDragChange(session.pid, on)}
			onAction={() => onMute(session.pid)}
		>
			{icon ? (
				<img src={icon} alt="" draggable={false} />
			) : (
				<span className="mt-mix-letter">{session.name.charAt(0).toUpperCase()}</span>
			)}
		</MixTile>
	);
}

function MixerPane({
	masterVolume,
	masterMuted,
	onMasterChange
}: {
	masterVolume: number;
	masterMuted: boolean;
	onMasterChange: (volume: number) => void;
}) {
	const [sessions, setSessions] = useState<AudioSession[]>([]);
	const listRef = useRef<HTMLDivElement>(null);
	// With more apps than fit, scrolling anywhere on the mixer except over a bar (that changes the
	// volume) slides the row sideways to show the rest.
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			if (el.scrollWidth <= el.clientWidth) return;
			event.preventDefault();
			event.stopPropagation();
			el.scrollLeft += event.deltaY + event.deltaX;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);
	// The app being dragged keeps its local value, so the refresh below does not jump it back.
	const draggingPid = useRef<number | null>(null);
	const pending = useRef<Map<number, number>>(new Map());
	const flushTimer = useRef(0);

	const refresh = useCallback(() => {
		invoke<AudioSession[]>("get_audio_sessions")
			.then((list) =>
				setSessions((prev) => {
					const before = new Map(prev.map((s) => [s.pid, s]));
					return list.map((session) => {
						const local = draggingPid.current === session.pid ? before.get(session.pid) : undefined;
						return local ? { ...session, volume: local.volume, is_muted: local.is_muted } : session;
					});
				})
			)
			.catch(() => {});
	}, []);

	useEffect(() => {
		refresh();
		const interval = window.setInterval(refresh, 2000);
		return () => window.clearInterval(interval);
	}, [refresh]);

	// Dragging fires many times a second: send one call per ~60 ms, and always the last value.
	const flush = useCallback(() => {
		flushTimer.current = 0;
		const queued = pending.current;
		pending.current = new Map();
		queued.forEach((volume, pid) => {
			invoke("set_app_volume", { pid, volume }).catch(() => {});
		});
	}, []);

	useEffect(
		() => () => {
			if (flushTimer.current) {
				window.clearTimeout(flushTimer.current);
				flush();
			}
		},
		[flush]
	);

	const changeApp = useCallback(
		(pid: number, volume: number) => {
			setSessions((list) =>
				list.map((s) =>
					s.pid === pid ? { ...s, volume, is_muted: volume === 0 ? s.is_muted : false } : s
				)
			);
			pending.current.set(pid, volume);
			if (!flushTimer.current) flushTimer.current = window.setTimeout(flush, 60);
		},
		[flush]
	);

	const dragApp = useCallback((pid: number, dragging: boolean) => {
		draggingPid.current = dragging ? pid : null;
	}, []);

	const muteApp = useCallback(
		(pid: number) => {
			const muted = !(sessions.find((s) => s.pid === pid)?.is_muted ?? false);
			setSessions((list) => list.map((s) => (s.pid === pid ? { ...s, is_muted: muted } : s)));
			invoke("set_app_mute", { pid, muted }).catch(() => {});
		},
		[sessions]
	);

	return (
		<div className="mt-mix">
			<div className="mt-mix-list" ref={listRef}>
				<MixTile
					value={masterMuted ? 0 : masterVolume}
					title="System volume"
					onChange={onMasterChange}
					onDragChange={() => {}}
				>
					<Volume2 size={14} />
				</MixTile>
				{sessions.map((session) => (
					<AppMixTile
						key={session.pid}
						session={session}
						onChange={changeApp}
						onDragChange={dragApp}
						onMute={muteApp}
					/>
				))}
			</div>
		</div>
	);
}

// Same motion as the dashboard's power panel (Dashboard.tsx).
const OUT_SPRING = { type: "spring", stiffness: 210, damping: 18, mass: 0.9 } as const;
const OUT_FADE_IN = { duration: 0.16, ease: "easeOut" } as const;
const OUT_FADE_OUT = { duration: 0.12, ease: "easeOut" } as const;

// Replaces the media tab with the list of sound outputs, the way the power panel replaces the
// dashboard grid when you press the profile picture. The back button or Esc closes it.
function OutputPanel({
	outputs,
	onPick,
	onBack,
	masterVolume,
	masterMuted,
	onMasterChange
}: {
	outputs: AudioOutput[];
	onPick: (id: string) => void;
	onBack: () => void;
	masterVolume: number;
	masterMuted: boolean;
	onMasterChange: (volume: number) => void;
}) {
	useEffect(() => {
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onBack();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [onBack]);

	return (
		<motion.div
			className="dash-power-panel mt-out-panel"
			role="dialog"
			aria-label="Sound output"
			initial={{ opacity: 0, y: 16, scale: 0.98 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 10, scale: 0.99, transition: OUT_FADE_OUT }}
			transition={{ y: OUT_SPRING, scale: OUT_SPRING, opacity: OUT_FADE_IN }}
			onClick={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			<div className="dash-power-head">
				<button type="button" className="dash-power-back" onClick={onBack} title="Back (Esc)">
					<ChevronLeft size={16} strokeWidth={2} />
				</button>
				<span className="dash-power-title">Sound Output</span>
				<span className="dash-power-hint">Default output</span>
			</div>
			<div className="mt-out-body">
				<div className="mt-out-list">
					{outputs.length === 0 ? (
						<div className="mt-out-empty">No output devices found</div>
					) : (
						outputs.map((device, index) => (
							<motion.button
								key={device.id}
								type="button"
								className={`mt-out-item${device.isDefault ? " active" : ""}`}
								title={device.name}
								initial={{ opacity: 0, y: 12 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ ...OUT_SPRING, delay: 0.05 + Math.min(index, 7) * 0.04 }}
								whileTap={{ scale: 0.97 }}
								onClick={() => onPick(device.id)}
							>
								<span className="mt-out-icon">
									<OutputIcon name={device.name} />
								</span>
								<span className="mt-out-name">{device.name}</span>
								{device.isDefault && <Check size={14} strokeWidth={2.6} className="mt-out-check" />}
							</motion.button>
						))
					)}
				</div>
				<MixerPane
					masterVolume={masterVolume}
					masterMuted={masterMuted}
					onMasterChange={onMasterChange}
				/>
			</div>
		</motion.div>
	);
}

// Same sliding as the old media pill (TitleMarquee in App.tsx): speed and floor are the same.
const TITLE_SLIDE_SPEED = 30; // px per second, for every title
const TITLE_SLIDE_MIN_SECONDS = 5; // so a title that only just overflows does not flicker

// A title that is too long for its box slides sideways to show the rest: it waits, slides to
// the end, waits, and slides back. It only slides while the music plays, and it stays still
// when it fits.
function MediaTitle({ title, playing }: { title: string; playing: boolean }) {
	const wrapRef = useRef<HTMLSpanElement>(null);
	const textRef = useRef<HTMLSpanElement>(null);
	// How far the text sticks out past its box, in px (0 means it fits).
	const [overflow, setOverflow] = useState(0);

	useEffect(() => {
		const check = () => {
			const wrap = wrapRef.current;
			const text = textRef.current;
			if (!wrap || !text) return;
			// offsetWidth ignores the slide itself, so measuring does not fight the animation.
			const extra = Math.ceil(text.offsetWidth - wrap.clientWidth);
			setOverflow(extra > 1 ? extra : 0);
		};
		check();
		const observer = new ResizeObserver(check);
		if (wrapRef.current) observer.observe(wrapRef.current);
		if (textRef.current) observer.observe(textRef.current);
		return () => observer.disconnect();
	}, [title]);

	const sliding = playing && overflow > 0;
	return (
		<span
			ref={wrapRef}
			className={`mt-title mt-title-wrap${overflow > 0 ? " overflowing" : ""}`}
			title={title}
		>
			<span
				ref={textRef}
				className={`mt-title-text${sliding ? " sliding" : ""}`}
				style={
					sliding
						? ({
								"--mt-slide": `-${overflow}px`,
								"--mt-slide-time": `${Math.max(overflow / TITLE_SLIDE_SPEED, TITLE_SLIDE_MIN_SECONDS)}s`
							} as React.CSSProperties)
						: undefined
				}
			>
				{title}
			</span>
		</span>
	);
}

// The graph-paper scope backdrop, the same one the Profile and Windows tabs draw (a grid, an axis
// with ticks, a scope trace and a slow scan line). Its look is in DashboardProfile.css; .mt-root
// carries the "dash-pf" class so it gets the same variables. The trace is drawn once.
const MEDIA_TRACE = scopeTrace("media");
function ScopeBackdrop({ trace }: { trace: string }) {
	return (
		<div className="dash-pf-bg" aria-hidden>
			<span className="dash-pf-axis" />
			<svg className="dash-pf-scope" viewBox="0 0 600 100" preserveAspectRatio="none">
				<polyline className="ghost-a" points={trace} />
				<polyline className="ghost-b" points={trace} />
				<polyline className="main" points={trace} />
			</svg>
			<span className="dash-pf-sweep" />
		</div>
	);
}

export function MediaTab({
	media,
	onPlayPause,
	onPrevious,
	onNext,
	slotImage = null,
	onPickSlot,
	onClearSlot
}: {
	media: MediaTabInfo;
	onPlayPause: () => void;
	onPrevious: () => void;
	onNext: () => void;
	// Gif or image beside the cover (a data URI), plus the buttons that change it.
	slotImage?: string | null;
	onPickSlot?: () => void;
	onClearSlot?: () => void;
}) {
	const { positionMs, durationMs: reportedDuration, positionUpdatedAt, isPlaying, seekEnabled } = media;
	const retroTheme = useRetroTheme();
	const reduceMotion = useReducedMotion();
	// Smooth open (setting "bloom-media-smooth-open", mirrored by App.tsx on the root element): the
	// backdrop and waveform are mounted 300 ms after the tab appears, so building them does not
	// compete with the notch's open animation. When the setting is off they mount right away.
	const [decorReady, setDecorReady] = useState(
		() => document.documentElement.dataset.mtDeferDecor === "off"
	);
	useEffect(() => {
		if (decorReady) return;
		const id = window.setTimeout(() => setDecorReady(true), 300);
		return () => window.clearTimeout(id);
	}, [decorReady]);
	// The disk's angle. While the music plays it turns; when it pauses it springs back to rest. It
	// starts from where the disk was when the tab last went away (savedDiskAngle), and this runs
	// from an effect so it also works when the tab opens while the music is already playing, or was
	// paused from the player while the tab was away (then the disk springs back as the tab opens).
	// Which disk to show (Settings > Notch > Media Tab Disk): 1 is the clear black one, 2 the yellow one.
	const diskVariant = useDiskVariant("media");
	const diskAngle = useMotionValue(savedDiskAngle);
	const shadowMaskId = `mt-shadow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
	// The hard shadow behind the disk on hover (MediaTab.css) always falls down and to the right,
	// although the disk turns. The shadow is drawn inside the turning wrapper, so its offset is turned
	// back by the disk's angle here and handed to the stylesheet as --mt-sx / --mt-sy. The distance
	// itself is --mt-disk-shadow-x/-y in the stylesheet (this only turns whatever it is).
	const shadowX = useTransform(diskAngle, (a) => {
		const r = (a * Math.PI) / 180;
		return `calc(var(--mt-disk-shadow-x, 5px) * ${Math.cos(r).toFixed(4)} + var(--mt-disk-shadow-y, 5px) * ${Math.sin(r).toFixed(4)})`;
	});
	const shadowY = useTransform(diskAngle, (a) => {
		const r = (a * Math.PI) / 180;
		return `calc(var(--mt-disk-shadow-y, 5px) * ${Math.cos(r).toFixed(4)} - var(--mt-disk-shadow-x, 5px) * ${Math.sin(r).toFixed(4)})`;
	});
	// Only a start while the tab is open gets the spin-up; opening the tab on music that is already
	// playing just carries on at the normal speed.
	const wasPlayingRef = useRef(isPlaying);
	useEffect(() => {
		const starting = isPlaying && !wasPlayingRef.current;
		wasPlayingRef.current = isPlaying;
		if (isPlaying && !reduceMotion) {
			let ramp: ReturnType<typeof animateValue> | null = null;
			let turning: ReturnType<typeof animateValue> | null = null;
			const steady = () => {
				// Carry on from the current angle (wrapped into one turn, so it looks the same): no jump.
				const from = DISK_REST_DEG + ((((diskAngle.get() - DISK_REST_DEG) % 360) + 360) % 360);
				diskAngle.set(from);
				turning = animateValue(diskAngle, from + 360, {
					duration: DISK_TURN_SECONDS,
					ease: diskStep,
					repeat: Infinity
				});
			};
			if (starting) {
				const from = diskAngle.get();
				ramp = animateValue(diskAngle, from + DISK_SPINUP_TOTAL_DEG, {
					duration: DISK_SPINUP_SECONDS,
					ease: diskSpinUpEase,
					onComplete: steady
				});
			} else {
				steady();
			}
			return () => {
				ramp?.stop();
				turning?.stop();
			};
		}
		const back = animateValue(diskAngle, DISK_REST_DEG, DISK_SPIN_BACK);
		return () => back.stop();
	}, [isPlaying, reduceMotion, diskAngle]);
	// Remember the angle when the tab goes away.
	useEffect(
		() => () => {
			savedDiskAngle = diskAngle.get();
		},
		[diskAngle]
	);


	// Without a picture there is no third column, so the cover and the info are centred as one
	// group and scaled to fill the tab (see MediaFit.css). `fit` is null until it is measured.
	const stageRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<number | null>(null);
	useEffect(() => {
		const stage = stageRef.current;
		const box = stage?.parentElement;
		if (!stage || !box || slotImage) return;
		const measure = () => {
			const scale = Math.min(box.clientWidth / SOLO_FIT_W, box.clientHeight / SOLO_FIT_H);
			setFit(Math.max(SOLO_FIT_MIN, Math.min(SOLO_FIT_MAX, scale)));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		return () => observer.disconnect();
	}, [slotImage, media.hasMedia, retroTheme]);

	// Browsers (Zen, Firefox, Chrome) sometimes report a duration of 0 for a moment, or never
	// do. Remember the last real duration of the same track so the bar does not blink out.
	const trackKey = `${media.title}|${media.artist}`;
	const lastDurationRef = useRef({ key: "", ms: 0 });
	if (reportedDuration > 0) lastDurationRef.current = { key: trackKey, ms: reportedDuration };
	const durationMs =
		reportedDuration > 0
			? reportedDuration
			: lastDurationRef.current.key === trackKey
				? lastDurationRef.current.ms
				: 0;

	// Last position reported by the backend and when it arrived; the display is extrapolated.
	const backendPosRef = useRef(positionMs);
	const backendTimeRef = useRef(positionUpdatedAt || Date.now());
	const seekingRef = useRef(false);
	const [copied, setCopied] = useState(false);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		},
		[]
	);
	const [displayPosition, setDisplayPosition] = useState(() => {
		const elapsed = Date.now() - (positionUpdatedAt || Date.now());
		return Math.min(positionMs + (isPlaying ? elapsed : 0), durationMs || Infinity);
	});

	useEffect(() => {
		if (!seekingRef.current) {
			backendPosRef.current = positionMs;
			backendTimeRef.current = positionUpdatedAt || Date.now();
		}
	}, [positionMs, positionUpdatedAt]);

	useEffect(() => {
		const tick = () => {
			if (seekingRef.current) return;
			const elapsed = isPlaying ? Date.now() - backendTimeRef.current : 0;
			setDisplayPosition(Math.min(backendPosRef.current + elapsed, durationMs || Infinity));
		};
		tick();
		const id = setInterval(tick, 250);
		return () => clearInterval(id);
	}, [isPlaying, durationMs]);

	const handleSeekStart = useCallback(() => {
		seekingRef.current = true;
	}, []);
	const handleSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		setDisplayPosition(Number(e.target.value));
	}, []);
	const handleSeekEnd = useCallback(() => {
		seekingRef.current = false;
		backendPosRef.current = displayPosition;
		backendTimeRef.current = Date.now();
		invoke("media_seek", { positionMs: displayPosition }).catch(() => {});
	}, [displayPosition]);

	const copyTrack = () => {
		const text = [media.title, media.artist].filter(Boolean).join(" - ");
		navigator.clipboard
			?.writeText(text)
			.then(() => {
				setCopied(true);
				if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
				copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
			})
			.catch(() => {});
	};

	// Keeps the tab's animations where they were while the pill is collapsed (see above).
	const rootRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		for (const anim of root.getAnimations({ subtree: true })) {
			const key = animationKey(anim);
			const saved = key ? savedAnimationTime.get(key) : undefined;
			if (saved !== undefined) anim.currentTime = saved;
		}
		return () => {
			for (const anim of root.getAnimations({ subtree: true })) {
				const key = animationKey(anim);
				const time = anim.currentTime;
				if (key && typeof time === "number") savedAnimationTime.set(key, time);
			}
		};
	}, [media.hasMedia]);

	// Sound output panel, opened by pressing the cover. Same commands as the control center.
	const [outOpen, setOutOpen] = useState(false);
	const [outputs, setOutputs] = useState<AudioOutput[]>([]);

	const refreshOutputs = useCallback(() => {
		invoke<AudioOutput[]>("list_audio_outputs")
			.then(setOutputs)
			.catch((e) => console.error("Failed to list audio outputs:", e));
	}, []);

	const toggleOutputs = () => {
		if (!outOpen) refreshOutputs();
		setOutOpen(!outOpen);
	};

	const pickOutput = useCallback(
		(id: string) => {
			// Move the check straight away, then re-read what Windows actually switched to.
			setOutputs((list) => list.map((d) => ({ ...d, isDefault: d.id === id })));
			invoke("set_audio_output", { id })
				.catch((e) => console.error("Failed to switch audio output:", e))
				.finally(() => setTimeout(refreshOutputs, 400));
		},
		[refreshOutputs]
	);

	// Nothing playing means no cover to press, so do not leave the panel open behind it.
	useEffect(() => {
		if (!media.hasMedia) setOutOpen(false);
	}, [media.hasMedia]);

	// Scrolling over the cover changes the system volume. The level is shown on the cover (a ring
	// that fills and the percentage) for a moment after the last scroll.
	const artRef = useRef<HTMLDivElement | null>(null);
	const [volume, setVolume] = useState(0.5);
	const [volMuted, setVolMuted] = useState(false);
	const [volShow, setVolShow] = useState(false);
	const volumeRef = useRef(0.5);
	const lastWheelRef = useRef(0);
	const volHideTimerRef = useRef(0);
	const volSendTimerRef = useRef(0);

	useEffect(() => {
		invoke<{ volume: number; is_muted: boolean }>("get_volume_state")
			.then((s) => {
				volumeRef.current = s.volume;
				setVolume(s.volume);
				setVolMuted(s.is_muted);
			})
			.catch(() => {});
		const unlisten = listen<{ volume: number; is_muted: boolean }>("volume-change", (event) => {
			// Ignore the echo of our own changes while the wheel is still turning.
			if (performance.now() - lastWheelRef.current < 400) return;
			volumeRef.current = event.payload.volume;
			setVolume(event.payload.volume);
			setVolMuted(event.payload.is_muted);
		});
		return () => {
			unlisten.then((fn) => fn());
			window.clearTimeout(volHideTimerRef.current);
			window.clearTimeout(volSendTimerRef.current);
		};
	}, []);

	useEffect(() => {
		const el = artRef.current;
		if (!el) return;
		// A native listener, so it can stop the page (and the tab switching) from also
		// reacting to the wheel.
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			// A mouse notch (100) moves 5%; a touchpad moves in smaller, smoother steps.
			const step = Math.max(-0.06, Math.min(0.06, -e.deltaY * 0.0005));
			const next = Math.max(0, Math.min(1, volumeRef.current + step));
			volumeRef.current = next;
			lastWheelRef.current = performance.now();
			setVolume(next);
			setVolMuted(next === 0);
			setVolShow(true);
			window.clearTimeout(volHideTimerRef.current);
			volHideTimerRef.current = window.setTimeout(() => setVolShow(false), 1300);
			if (!volSendTimerRef.current) {
				volSendTimerRef.current = window.setTimeout(() => {
					volSendTimerRef.current = 0;
					invoke("set_volume", { volume: volumeRef.current }).catch(() => {});
				}, 40);
			}
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [media.hasMedia]);

	// The master slider in the sound output panel. Same path as the wheel above, so the cover's ring
	// and the system volume follow it.
	const setMasterVolume = useCallback((next: number) => {
		volumeRef.current = next;
		lastWheelRef.current = performance.now();
		setVolume(next);
		setVolMuted(next === 0);
		if (!volSendTimerRef.current) {
			volSendTimerRef.current = window.setTimeout(() => {
				volSendTimerRef.current = 0;
				invoke("set_volume", { volume: volumeRef.current }).catch(() => {});
			}, 40);
		}
	}, []);

	// Hover veil. While the cover is hovered (or the volume is being changed) everything goes dark except
	// a soft round window around the disk. The old veil lived inside this tab, so the tab's own edge cut
	// it off with a hard rectangle and left the clock, tabs and corners bright. This one is drawn on the
	// notch itself (the outermost rounded box around the tab), so it covers the whole pill, rounded
	// corners included. If no such box is found the old in-tab veil (.mt-spot) is used.
	const [artHot, setArtHot] = useState(false);
	// Leaving the cover ends the hover and hides the volume level at once, instead of waiting out the
	// 1.3 s timer that the wheel starts (that timer is only for when the pointer stays on the cover).
	const hideArtHover = () => {
		setArtHot(false);
		window.clearTimeout(volHideTimerRef.current);
		setVolShow(false);
	};
	const veilOn = artHot || volShow;
	const [veil, setVeil] = useState<{ host: HTMLElement; x: number; y: number } | null>(null);
	const [veilHost, setVeilHost] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (!veilOn) {
			setVeil(null);
			return;
		}
		const art = artRef.current;
		const root = rootRef.current;
		if (!art || !root) return;
		let host: HTMLElement | null = null;
		for (
			let el = root.parentElement;
			el && el !== document.body && el !== document.documentElement;
			el = el.parentElement
		) {
			if (parseFloat(getComputedStyle(el).borderTopLeftRadius) >= 10 && el.offsetWidth >= 300) host = el;
		}
		if (!host) {
			setVeil(null);
			return;
		}
		// The veil is placed inside the host, so the host has to be the thing it is placed against.
		if (getComputedStyle(host).position === "static") host.style.position = "relative";
		// Where the disk is inside the host. The notch can be scaled, so measure as a fraction of the
		// host's drawn size and convert to the host's own pixels.
		const h = host.getBoundingClientRect();
		const a = art.getBoundingClientRect();
		const k = host.offsetWidth / (h.width || 1);
		setVeilHost(host);
		setVeil({
			host,
			x: (a.left + a.width / 2 - h.left) * k,
			y: (a.top + a.height / 2 - h.top) * k
		});
	}, [veilOn]);

	// The retro skin is a different instrument, not a reskin, so it gets its own
	// component. Every hook above still runs, so the hook order is identical.
	if (retroTheme) {
		return (
			<MediaScope
				media={media}
				onPlayPause={onPlayPause}
				onPrevious={onPrevious}
				onNext={onNext}
				slotImage={slotImage}
				onPickSlot={onPickSlot}
				onClearSlot={onClearSlot}
			/>
		);
	}

	if (!media.hasMedia) {
		return (
			<div className="mt-root mt-empty">
				<MusicNoteIcon size={28} />
				<span>Nothing playing</span>
			</div>
		);
	}

	const progress = durationMs > 0 ? Math.min(100, (displayPosition / durationMs) * 100) : 0;
	const sourceName = friendlySource(media.source);

	return (
		<div className={`mt-root dash-pf${veilHost ? " veiled" : ""}`} ref={rootRef}>
{decorReady && <ScopeBackdrop trace={MEDIA_TRACE} />}
			{decorReady && <ScopeWave isPlaying={isPlaying} />}
			<div
				ref={stageRef}
				className={`mt-stage${slotImage ? "" : " solo"} has-rings`}
				style={
					slotImage
						? undefined
						: ({
								"--mt-fit": fit ?? 1,
								visibility: fit === null ? "hidden" : undefined
							} as React.CSSProperties)
				}
			>
			<div className={`mt-ring ${isPlaying ? "playing" : ""}`}>
				<div
					ref={artRef}
					className={`mt-art ${volShow ? "vol" : ""}`}
					role="button"
					tabIndex={0}
					aria-label="Sound output"
					onMouseEnter={() => setArtHot(true)}
					onMouseLeave={hideArtHover}
					onFocus={() => setArtHot(true)}
					onBlur={hideArtHover}
					onClick={toggleOutputs}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							toggleOutputs();
						}
					}}
				>
					{/* The disk turns while the music plays and spins back to its resting angle with a
					    bounce when it pauses, like the cover on the dashboard card (diskAngle above). */}
					<motion.span
						className="mt-disk"
						style={{ rotate: diskAngle, "--mt-sx": shadowX, "--mt-sy": shadowY } as any}
					>
						{diskVariant === 2 ? <Floppy /> : <DashDiskArt art={media.art} />}
						{/* A blurred copy of the disk behind it: the glow, which follows the disk's real shape
						    (MediaDisk.css). */}
						<span className="mt-disk-glow" aria-hidden>
							{diskVariant === 2 ? <Floppy /> : <DashDiskArt art={media.art} />}
						</span>
						{/* The hard shadow shown on hover: a solid copy of the disk's outline, offset down and right
						    by --mt-sx / --mt-sy (MediaTab.css), with the disk's own outline cut out of it, so
						    only the part that sticks out past the edge shows and the see-through disk stays clear. */}
						<span className={`mt-disk-shadow ${diskVariant === 2 ? "floppy" : "case"}`} aria-hidden>
							<svg viewBox="0 0 100 100" overflow="visible">
								<defs>
									<mask id={shadowMaskId} maskUnits="userSpaceOnUse" x="-30" y="-30" width="160" height="160">
										<rect x="-30" y="-30" width="160" height="160" fill="#fff" />
										{diskVariant === 2 ? (
											<rect x="0" y="0.9" width="100" height="98.3" rx="3" fill="#000" />
										) : (
											<path d="M10 1.5 H93.5 Q99 1.5 99 7 V93 Q99 99 93.5 99 H6.5 Q1 99 1 93.5 V10Z" fill="#000" />
										)}
									</mask>
								</defs>
								<g mask={`url(#${shadowMaskId})`}>
									{diskVariant === 2 ? (
										<rect className="mt-shadow-shape" x="0" y="0.9" width="100" height="98.3" rx="3" />
									) : (
										<path className="mt-shadow-shape" d="M10 1.5 H93.5 Q99 1.5 99 7 V93 Q99 99 93.5 99 H6.5 Q1 99 1 93.5 V10Z" />
									)}
								</g>
							</svg>
						</span>
					</motion.span>
					{/* Flashlight: on hover everything else in the tab goes dark and only the middle of the
					    cover, where the OUTPUT hint shows, stays lit (MediaDisk.css). */}
					<span className="mt-spot" aria-hidden />
					{/* Volume ring: fills up while you scroll over the cover. */}
					<svg className="mt-vol-arc" viewBox="0 0 90 90" aria-hidden>
						<circle className="mt-vol-arc-track" cx="45" cy="45" r="41" />
						<circle
							className="mt-vol-arc-fill"
							cx="45"
							cy="45"
							r="41"
							transform="rotate(-90 45 45)"
							strokeDasharray={VOL_ARC}
							strokeDashoffset={VOL_ARC * (1 - (volMuted ? 0 : volume))}
						/>
					</svg>
					{/* Shown on hover so it is clear the cover can be pressed (and scrolled). */}
					<span className="mt-art-hint">
						{volShow && !veilHost && (
							<span className="mt-art-hint-label">
								{`${Math.round((volMuted ? 0 : volume) * 100)}%`}
							</span>
						)}
					</span>
				</div>
			</div>

			<div className="mt-info">
				{/* Stack like the loading-screen reference: a small line (artist), the big line
				    (title), the bar with its end rings, then the controls underneath. */}
				<div className="mt-meta">
					<span
						className="mt-artist"
						title={[media.artist, media.album].filter(Boolean).join(" \u00b7 ")}
					>
						{media.artist || "Unknown artist"}
						{media.album && <span className="mt-album-inline">{" \u00b7 "}{media.album}</span>}
					</span>
					{durationMs > 0 && (
						<span className="mt-times">
							<span className="mt-time-now">{formatTime(displayPosition)}</span> /{" "}
							{formatTime(durationMs)}
						</span>
					)}
				</div>
				<MediaTitle title={media.title || "Unknown title"} playing={isPlaying} />

				<div className="mt-xbar">
					<X className="mt-x faint" size={7} strokeWidth={3} />
					<X className="mt-x" size={9} strokeWidth={3} />
					<div className="mt-line">
						<div className="mt-line-base" />
						<div className="mt-line-fill" style={{ width: `${progress}%` }} />
						<div
							className={`mt-head ${isPlaying ? "playing" : ""}`}
							style={{ left: `${progress}%` }}
						>
							<i className="mt-head-dot" />
							<X className="mt-head-x" size={9} strokeWidth={3.2} />
						</div>
						{seekEnabled && durationMs > 0 && (
							<input
								type="range"
								className="mt-seek"
								min={0}
								max={durationMs}
								step={100}
								value={displayPosition}
								onMouseDown={handleSeekStart}
								onTouchStart={handleSeekStart}
								onChange={handleSeekChange}
								onMouseUp={handleSeekEnd}
								onTouchEnd={handleSeekEnd}
								onClick={(e) => e.stopPropagation()}
							/>
						)}
					</div>
					<span className={`mt-end ${isPlaying ? "playing" : ""}`}>
						{/* Loading-screen rings centred on the end of the bar: a thick soft ring and a
						    big thin circle whose right edge touches it. */}
						<span className="mt-end-art" aria-hidden>
							<span className="mt-ring-thick" />
							<svg className="mt-ring-thin" viewBox="0 0 190 190">
								<circle cx="95" cy="95" r="94" />
							</svg>
							{/* The circle with its x rides the thin circle; the x turns counterclockwise (MediaFx.css). */}
							<span className="mt-orbit">
								<span className="mt-orbiter">
									<X size={9} strokeWidth={3} />
								</span>
							</span>
						</span>
						{/* The burning cube sits at the end of the bar, in the middle of the rings, in its own layer so it
						    is drawn on top of the bar. */}
						<span className="mt-core">
							{/* The first flame of the reference gif, 8 frames looped (cubeFlame.ts, CubeFlame.css). */}
							<svg className="mt-cube-flame" viewBox={CUBE_FLAME_VIEWBOX} aria-hidden>
								{CUBE_FLAME_FRAMES.map((d, i) => (
									<path
										key={i}
										className="mt-cf-frame"
										style={{ animationDelay: `${i * CUBE_FLAME_FRAME_SECONDS}s` }}
										d={d}
									/>
								))}
							</svg>
							<i className="mt-square" />
						</span>
					</span>
					<X className="mt-x faint" size={7} strokeWidth={3} />
				</div>

				<div className="mt-bottom">
					<div className="mt-controls">
						<button className="mt-btn" onClick={onPrevious} title="Previous">
							<SkipBackIcon size={18} />
						</button>
						<button
							className="mt-btn mt-btn-main"
							onClick={onPlayPause}
							title={isPlaying ? "Pause" : "Play"}
						>
							{isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
						</button>
						<button className="mt-btn" onClick={onNext} title="Next">
							<SkipForwardIcon size={18} />
						</button>
					</div>

					<div className="mt-actions">
						<button className="mt-chip" onClick={copyTrack} title="Copy track name">
							{copied ? <Check size={13} /> : <Copy size={13} />}
						</button>
						{sourceName && (
							<span className="mt-source" title={media.source}>
								<i className="mt-source-dot" />
								{sourceName}
							</span>
						)}
					</div>
				</div>
			</div>

			</div>

			{/* Gif/image beside the cover. With a picture: replace and remove buttons appear while
			    the pointer is over it. Without one there is no column at all: the cover and the info
			    are scaled up to fill the tab, and a small button in the corner adds a picture. */}
			{slotImage ? (
				<div className="mt-slot has-image">
					<img src={slotImage} alt="" draggable={false} />
					<div className="mt-slot-tools">
						<button className="mt-slot-btn" onClick={onPickSlot} title="Change picture">
							<RefreshCw size={11} />
						</button>
						<button className="mt-slot-btn" onClick={onClearSlot} title="Remove picture">
							<X size={12} />
						</button>
					</div>
				</div>
			) : (
				onPickSlot && (
					<button className="mt-chip mt-add-pic" onClick={onPickSlot} title="Add a gif or image">
						<ImagePlus size={13} />
					</button>
				)
			)}

			{/* The hover veil, drawn on the notch (see above); it fades in and out. */}
			{(veil?.host ?? veilHost) &&
				createPortal(
					<AnimatePresence>
						{veil && (
							<motion.div
								key="veil"
								className="mt-veil"
								aria-hidden
								style={{ "--mt-veil-x": `${veil.x}px`, "--mt-veil-y": `${veil.y}px` } as CSSProperties}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.3, ease: "easeOut" }}
							/>
						)}
					</AnimatePresence>,
					(veil?.host ?? veilHost) as HTMLElement
				)}

			{/* "[ MEMORIES OUTPUT ]" in the middle of the dark area to the right of the disk while it is
			    hovered, sliding in from the left. While the volume is being changed it becomes the
			    percentage: it is swapped at once with a flip, the same one the Pomodoro timer in the
			    notch uses (rotateX, no sliding). It is drawn on the notch, above the veil
			    (MediaDisk.css), so the veil does not dim it, and it sits beside the disk because on
			    the bright disk it could not be read. */}
			{(veil?.host ?? veilHost) &&
				createPortal(
					<AnimatePresence>
						{veil && !outOpen && (
							<motion.span
								key="out-label"
								className="mt-veil-out"
								style={
									{
										// The label is centred (translate) in the dark area: halfway between the
										// disk's right edge and the right edge of the notch. --mt-out-dx moves the
										// centre from there, --mt-out-dy moves it up or down.
										left: `calc(${veil.x}px + ${(DISK_HALF + veil.host.offsetWidth - veil.x) / 2}px + var(--mt-out-dx, 0px))`,
										top: `calc(${veil.y}px + var(--mt-out-dy, 0px))`,
										translate: "-50% 0",
										perspective: 300
									} as CSSProperties
								}
								initial={{ opacity: 0, x: -26 }}
								animate={{ opacity: 1, x: 0 }}
								exit={{ opacity: 0, x: -12 }}
								transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
								aria-hidden
							>
								{/* Invisible copy of the label: it keeps the box as wide as the label, so the
								    percentage below sits in the middle of that width. */}
								<span className="mt-veil-out-text mt-veil-out-ghost" aria-hidden>
									[ MEMORIES OUTPUT ]
								</span>
								{/* The old text flips away as the new one flips in, one over the other (they share
								    a grid cell). The percentage itself changes in place while you scroll. */}
								<AnimatePresence initial={false}>
									<motion.span
										key={volShow ? "level" : "label"}
										className={volShow ? "mt-veil-out-text level" : "mt-veil-out-text"}
										initial={{ rotateX: -90, opacity: 0 }}
										animate={{ rotateX: 0, opacity: 1 }}
										exit={{ rotateX: 90, opacity: 0 }}
										transition={{ type: "spring", stiffness: 600, damping: 30 }}
									>
										{volShow
											? `[ ${Math.round((volMuted ? 0 : volume) * 100)}% ]`
											: "[ MEMORIES OUTPUT ]"}
									</motion.span>
								</AnimatePresence>
							</motion.span>
						)}
					</AnimatePresence>,
					(veil?.host ?? veilHost) as HTMLElement
				)}

			<AnimatePresence>
				{outOpen && (
					<OutputPanel
						key="output"
						outputs={outputs}
						onPick={pickOutput}
						onBack={() => setOutOpen(false)}
						masterVolume={volume}
						masterMuted={volMuted}
						onMasterChange={setMasterVolume}
					/>
				)}
			</AnimatePresence>
		</div>
	);
}
