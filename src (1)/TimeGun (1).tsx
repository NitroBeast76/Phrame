import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ClipboardEvent as ReactClipboardEvent,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent
} from "react";
import { Minus, Pause, Play, Plus, RotateCcw, SkipForward } from "lucide-react";
import {
	GUN_DRUM_D,
	GUN_HAMMER_D,
	GUN_STATIC_D,
	GUN_TRIGGER_D,
	GUN_VIEWBOX
} from "./timeGunArt";
import { DIGIT_BOX, DIGIT_PATHS, DIGIT_TICKS } from "./timeGunDigits";
import { GUN_FILLS, GUN_HAMMER_FILLS, GUN_TRIGGER_FILL } from "./timeGunFill";
import { SPARK_BURST } from "./sparkBurst";
// The cyan cube: the same markup and styles as the Media tab (MediaFx.css).
import "./MediaFx.css";
import "./TimeGun.css";
import "./TimeGunQuote.css";
import TimeGunBackdrop from "./TimeGunBackdrop";
// Loaded after TimeGun.css on purpose: it restyles the spark, so it has to win over the old spark rules there.
import "./sparkBurst.css";
// Darkens the notch's own frame around the gun area, so no lighter edge shows round it (see tgFrame.css).
import "./tgFrame.css";
import "./TimeGunPopup.css";
import { playCock, playHit, preloadTimeGunSounds, startFire, stopFire } from "./timeGunSound";

export type PomodoroPhase = "focus" | "short" | "long";

export interface PomodoroDurations {
	focus: number;
	short: number;
	long: number;
}

export const POMO_ROUNDS = 4;
export const POMO_DEFAULT_DURATIONS: PomodoroDurations = { focus: 25, short: 5, long: 15 };
export const POMO_QUOTE = "Go create the ending you want.";

/** Length of a phase in milliseconds (durations are stored in minutes, and may carry whole seconds: 1.5 is 1:30). */
export const phaseMs = (phase: PomodoroPhase, durations: PomodoroDurations): number =>
	Math.round(durations[phase] * 60_000);

const PHASE_LABEL: Record<PomodoroPhase, string> = {
	focus: "Focus",
	short: "Short break",
	long: "Long break"
};

// The gun is drawn in a 585x398 box and zoomed in so it fills the panel: it starts a little
// in from the left, its barrel sits just under the top edge, and the hammer and the lower hand
// run off the right and bottom edges. Raise ZOOM for a closer crop.
const ZOOM = 1.15;
const SCALE = ZOOM;
const GUN_W = Math.round(GUN_VIEWBOX.w * ZOOM);
const GUN_H = Math.round(GUN_VIEWBOX.h * ZOOM);
const BARREL_TOP = 85; // top of the barrel inside the box, in art units
const GUN_LEFT = 10;
// The reference frame has the gun pointing down by about 0.7 degrees (measured over the long horizontal edges),
// so the whole gun is turned back by that much to level the barrel. Positive turns clockwise (muzzle up).
const GUN_TILT_DEGREES = 0.7;
// Space kept above the barrel, so the flame has room to rise. Set it back to 8 for a tighter crop (the flame then gets clipped).
const TOP_ROOM = 40;
const GUN_TOP = Math.round(TOP_ROOM - BARREL_TOP * ZOOM);
// The side column (phase, progress, trigger button, durations) is hidden for now.
const SHOW_CONTROLS = false;

// Focus mode: pressing the chamber zooms the gun in on it and pushes it to the left, while the time layout slides in from the
// right edge. The layout takes PANEL_FRAC of the panel (kept between PANEL_MIN and PANEL_MAX pixels), the gun gets the rest,
// and the chamber is zoomed to fill that rest, never past FOCUS_ZOOM_MAX. FOCUS_MS must match --tg-focus-ms in TimeGun.css.
const FOCUS_MS = 560;
const PANEL_FRAC = 0.48;
const PANEL_MIN = 236;
const PANEL_MAX = 300;
const FOCUS_MARGIN = 40; // free space kept either side of the zoomed chamber, in pixels
const FOCUS_ZOOM_MIN = 0.9;
const FOCUS_ZOOM_MAX = 1.7;
const STAGE_DEFAULT = { w: 600, h: 264 }; // the notch's time panel, until the real size is measured
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The four cells of the cylinder (columns) and the rows of digits they show, in art units.
const COLUMNS = [
	{ x0: 220.5, x1: 249.4 },
	{ x0: 250.8, x1: 280.1 },
	{ x0: 282, x1: 311 },
	{ x0: 312, x1: 341.5 }
];
const ROW_CENTER = 172.5;
const ROW_PITCH = 26.5;
const WINDOW_TOP = 135;
const WINDOW_BOTTOM = 210;
// Digits are drawn from the custom glyphs in timeGunDigits.ts (centre-line paths, 10 x 14).
const DIGIT_SCALE = 1;
// The yellow drum behind the reels, in art units.
const DRUM = { x: 220.5, y: 128, w: 119, h: 91.5, r: 3 };
const STRIP = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Quick picks offered in the time panel (the timer accepts 1 to 99; any value can be typed).
const TIME_PRESETS = [5, 10, 15, 20, 25, 30, 45, 60];

// One digit glyph: a wide dark stroke with a thin light stroke on top, so it reads as outlined lettering.
function Glyph({ ch, cx, cy }: { ch: string; cx: number; cy: number }) {
	const d = DIGIT_PATHS[ch];
	const tick = DIGIT_TICKS[ch];
	const x = cx - (DIGIT_BOX.w * DIGIT_SCALE) / 2;
	const y = cy - (DIGIT_BOX.h * DIGIT_SCALE) / 2;
	return (
		<g transform={`translate(${x} ${y}) scale(${DIGIT_SCALE})`}>
			<path className="tg-glyph-out" d={d} />
			<path className="tg-glyph-in" d={d} />
			{tick && (
				<>
					<path className="tg-tick-out" d={tick} />
					<path className="tg-tick-in" d={tick} />
				</>
			)}
		</g>
	);
}

// The hammer rests as drawn (cocked). Pulling the trigger drops it forward, about its lower-left base,
// onto the cube, and the cube catches. STRIKE_DEGREES is the angle where the hammer first touches the cube.
const HAMMER_PIVOT = { x: 440, y: 177.8 };
const STRIKE_DEGREES = -37;
// The trigger turns about the pin (hidden up in the frame) and stays pulled while counting.
const TRIGGER_PIVOT = { x: 322, y: 244 };
const PULL_DEGREES = -16;
// The hammer starts to fall a beat after the trigger moves and snaps onto the cube (see .tg-hammer.fired in the CSS),
// then the cube catches. Keep these in step with that rule.
const HAMMER_DELAY_MS = 40;
// Right-click on the trigger while the gun is stopped is a dry fire, like a round of Russian roulette: the trigger squeezes and
// the hammer drops on an empty chamber, then both spring straight back (DRY_HOLD_MS is how long they stay at the end of their travel;
// the hammer needs about 120 ms to get there). Nothing catches: no spark, no fire, no hit sound. The cylinder spins to a random time,
// to the second (any number of seconds from ROULETTE_MIN_SECONDS to ROULETTE_MAX_SECONDS, so 17:42 is as likely as 17:00), which
// becomes the timer. While the timer is running, right-click on the trigger stops it and puts the full time back instead.
const DRY_HOLD_MS = 130;
const ROULETTE_MIN_SECONDS = 60; // 1:00
const ROULETTE_MAX_SECONDS = 60 * 60; // 60:00

/** A random number of seconds in the roulette range, never the one that is set already (so the cylinder always moves). */
const rollSeconds = (current: number): number => {
	const span = ROULETTE_MAX_SECONDS - ROULETTE_MIN_SECONDS + 1;
	const skip = current >= ROULETTE_MIN_SECONDS && current <= ROULETTE_MAX_SECONDS;
	const r = ROULETTE_MIN_SECONDS + Math.floor(Math.random() * (skip ? span - 1 : span));
	return skip && r >= current ? r + 1 : r;
};
// The cube is the Media tab's flat cyan square, sitting on the ledge left of the hammer, behind the gun.
// It runs a few units down behind the ledge, so there is never a gap under it.
const CUBE = { x: 373.35, y: 120.5, size: 53, tuck: 5 };
// Where the hammer meets the cube. Measured from a screen recording: the hammer's left edge meets the cube's right edge at
// x = 423.6, and the middle of that edge is y = 147. The flash is centred here. The spark (sparkBurst.ts, drawn around its
// own 0,0) starts on the cube's right edge at the same height. It is hand-made after the animation reference and flips
// between a few shapes, one every SPARK_STEP seconds.
const IMPACT = { x: 423.6, y: 147 };
// The hit: the spark, the flash and the cyan glow of the cube all start together, as soon as the hammer is on the cube.
const SPARK_MS = HAMMER_DELAY_MS + 35;
const SPARK_STEP = 1 / 12; // 12 frames per second
// The flash at the moment of impact: one still lens-flare frame (white with a cyan edge) shown for FLARE_FRAMES spark frames, then gone.
// It does not move or grow. It is centred on IMPACT.
const FLARE_FRAMES = 1; // 1 or 2
const FLARE_SECONDS = SPARK_STEP * FLARE_FRAMES;
// How big the flare is (1 = the drawing as it is below).
const FLARE_SCALE = 2.4;
// How soft the flare is: the blur, in the flare's own units (they are made FLARE_SCALE times bigger on screen). 0 = sharp.
const FLARE_BLUR = 1.6;
// The vignette over the gun, the Media tab's flashlight but always on: a dark veil with a soft round hole on the chamber. Sizes are screen pixels. Smaller CLEAR = a smaller focus area; DARK 0 to 1 is how dark the rest gets.
const VEIL = { clear: 60, soft: 140, dark: 0.78 };
// Eased falloff: the gradients follow a smoothstep curve through these points, so there is no visible rim where the light ends.
const EASE_T = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const smooth = (t: number) => t * t * (3 - 2 * t);
// The cube is a light too: once it catches (the hit) it gets its own lit patch (in gun units) so it stays bright. Before that it is dimmed like the rest.
const VEIL_CUBE = { clear: 40, soft: 70 };
// The spark plays on and on while the timer runs (see SparkLoop below): how big it is (1 = as drawn in sparkBurst.ts).
const SPARK_SIZE = 0.6;

// Sounds: the hammer landing on the cube, the hammer cocking back when the timer stops, and the fire crackle that fades in
// once the cube is burning and out when the timer stops or the tab is left (the fades are in seconds). Their volumes are
// set in Settings > Notch (see timeGunSound.ts). They are played from preloaded buffers. The hit sound is started
// HIT_SOUND_LEAD_MS before the flash is drawn, to cover the output delay of the audio device (and of the limiter every
// sound goes through), so the thud and the flash arrive together. Raise it if the sound still comes late, lower it if it
// comes early.
const FIRE_FADE_IN = 1.4;
const FIRE_FADE_OUT = 0.9;
const HIT_SOUND_LEAD_MS = 26;
// The blue halo behind the cube once it is lit: its diameter in gun units.
const GLOW_SIZE = 260;

const toStage = (p: { x: number; y: number }) => ({
	left: GUN_LEFT + (p.x - GUN_VIEWBOX.x) * SCALE,
	top: GUN_TOP + (p.y - GUN_VIEWBOX.y) * SCALE
});

interface TimeGunProps {
	phase: PomodoroPhase;
	running: boolean;
	remainingMs: number;
	totalMs: number;
	/** Focus rounds finished in the current cycle (0 to POMO_ROUNDS). */
	rounds: number;
	durations: PomodoroDurations;
	/** No longer used: the quote now stays up while the timer runs. Kept so the caller does not need changing. */
	quoteSignal: number;
	onToggle: () => void;
	onSkip: () => void;
	onReset: () => void;
	onDuration: (phase: PomodoroPhase, deltaMinutes: number) => void;
}

// The time popup: a translucent "memory slot" that slides in on the left of the gun. There is no readout in it: the time is
// typed the way the old pomodoro timer took it, minutes and seconds with the digits filling in from the right (130 is 1:30,
// 2500 is 25:00, 45 is 0:45), and the cylinder itself rolls to the typed digits as you go (TimeGun shows the draft on the
// reels while this is open). Enter loads the time, Escape throws it away, up/down step a minute, and a time outside
// 0:01 to 99:59 shows up as a BUG.
const MAX_SECONDS = 99 * 60 + 59;

/** The digits typed so far (up to four, newest on the right) as a number of seconds, the way the old timer read them. */
const draftToSeconds = (draft: string): number => {
	if (!draft) return 0;
	const secs = Number.parseInt(draft.slice(-2) || "0", 10);
	const mins = Number.parseInt(draft.slice(0, -2) || "0", 10);
	return mins * 60 + secs;
};

/** A number of seconds as the digits that would be typed for it (1:30 is "130", 25:00 is "2500"). */
const secondsToDraft = (total: number): string => {
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `${mins}${String(secs).padStart(2, "0")}`.replace(/^0+(?=\d)/, "");
};

const clock = (total: number): string =>
	`${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

/** The minutes as a three-digit counter against the longest time, e.g. "017/099" (like the folder position in the Wallpaper panel). The "/099" drops away in a narrow popup. */
function MinuteCounter({ total, valid }: { total: number; valid: boolean }) {
	const pad = (n: number) => String(n).padStart(3, "0");
	return (
		<>
			{valid ? pad(Math.floor(total / 60)) : "---"}
			<em>/{pad(Math.floor(MAX_SECONDS / 60))}</em>
		</>
	);
}

// A tiny floppy disk for the popup's header.
function FloppyGlyph() {
	return (
		<svg className="tg-pk-glyph" viewBox="0 0 16 16" aria-hidden>
			<path d="M2 1.5h10.2L14.5 3.8V14.5h-12.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
			<path d="M4.6 1.8h5.6v3.6H4.6Z" fill="currentColor" />
			<path d="M4.4 9h7.2v5.3H4.4Z" fill="none" stroke="currentColor" strokeWidth="1.1" />
		</svg>
	);
}

function TimePicker({
	draft,
	onDraft,
	onSubmit,
	onCancel,
	onPick,
	width,
	open,
	nowSeconds
}: {
	draft: string;
	onDraft: (draft: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
	onPick: (minutes: number) => void;
	width: number;
	/** False while the layout is sliding back out: it stays mounted for the exit, but takes no input. */
	open: boolean;
	/** The time that is loaded right now, shown next to the typed one like the old / new value in a shop's tune-up list. */
	nowSeconds: number;
}) {
	const inputRef = useRef<HTMLInputElement | null>(null);
	// Right after opening, the shown time counts as selected: the first digit replaces it, later digits fill in from the right.
	const fresh = useRef(true);
	useEffect(() => {
		inputRef.current?.focus({ preventScroll: true }); // never scroll the clipped stage to the field
	}, []);
	const total = draftToSeconds(draft);
	const valid = total >= 1 && total <= MAX_SECONDS;
	const typed = (digit: string) => {
		const base = fresh.current ? "" : draft;
		fresh.current = false;
		onDraft((base + digit).slice(-4));
	};
	const erase = () => {
		const base = fresh.current ? "" : draft;
		fresh.current = false;
		onDraft(base.slice(0, -1));
	};
	const step = (seconds: number) => {
		fresh.current = false;
		onDraft(secondsToDraft(Math.min(MAX_SECONDS, Math.max(1, total + seconds))));
	};
	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		// Typing stays here, away from the app's own shortcuts.
		e.stopPropagation();
		if (!open) return;
		if (/^\d$/.test(e.key)) {
			e.preventDefault();
			typed(e.key);
		} else if (e.key === "Backspace") {
			e.preventDefault();
			erase();
		} else if (e.key === "Delete") {
			e.preventDefault();
			fresh.current = false;
			onDraft("");
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (valid) onSubmit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			onCancel();
		} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault();
			step((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 300 : 60));
		}
	};
	return (
		<div
			className={`tg-picker${open ? " in" : " out"}`}
			role="dialog"
			aria-label="Set the timer"
			style={{ width }}
			onContextMenu={(e) => e.stopPropagation()}
		>
			<div
				className={`tg-pk-card${valid ? "" : " bug"}`}
				// A press on the panel itself (not a button) keeps the typing going.
				onPointerDown={(e) => {
					if (!(e.target instanceof Element) || !e.target.closest("button")) {
						e.preventDefault();
						inputRef.current?.focus({ preventScroll: true }); // never scroll the clipped stage to the field
					}
				}}
			>
				<div className="tg-pk-head">
					<span className="tg-pk-drive">
						<i className="tg-pk-dot" aria-hidden />
						<FloppyGlyph />
					</span>
					<span className="tg-pk-title">SET TIME</span>
					<span className="tg-pk-tag">
						<MinuteCounter total={total} valid={valid} />
					</span>
				</div>

				{/* The selected row, like the lit row of a shop's tune-up list: what it is, then old and new value. */}
				<div className="tg-pk-sel">
					<div className="tg-pk-sel-main">
						<span className="tg-pk-sel-title">Focus time</span>
						<span className="tg-pk-sel-sub">
							{valid ? (
								<>
									<b>TYPE</b> a time: 130 is 1:30
								</>
							) : (
								<>
									<b>BUG</b> keep it between 0:01 and 99:59
								</>
							)}
						</span>
					</div>
					<div className="tg-pk-cmp" aria-hidden>
						<span className="tg-pk-now">
							<i>NOW</i> {clock(nowSeconds)}
						</span>
						<span className="tg-pk-new">{valid ? clock(total) : "BUG"}</span>
					</div>
				</div>

				<div className="tg-pk-quick">
					<div className="tg-pk-quick-head">
						<span>Quick load</span>
						<span>minutes</span>
					</div>
					<div className="tg-pk-chips" role="group" aria-label="Quick picks in minutes">
						{TIME_PRESETS.map((m) => (
							<button
								key={m}
								type="button"
								className={`tg-pk-chip${m * 60 === total ? " active" : ""}`}
								onClick={() => onPick(m)}
							>
								{m}
							</button>
						))}
					</div>
				</div>

				<div className="tg-pk-actions">
					<button type="button" className="tg-pk-esc" onClick={onCancel}>
						ESC
					</button>
					<button type="button" className="tg-pk-load" disabled={!valid} onClick={() => valid && onSubmit()}>
						{valid ? `LOAD ${clock(total)}` : "CORRUPTED"}
					</button>
				</div>
				<input
					ref={inputRef}
					className="tg-pk-input"
					type="text"
					inputMode="numeric"
					autoComplete="off"
					spellCheck={false}
					value={draft}
					aria-label="Time, minutes and seconds"
					onKeyDown={onKeyDown}
					onChange={(e) => {
						if (!open) return;
						// Soft keyboards that send no key codes land here.
						const d = e.target.value.replace(/\D/g, "");
						if (d.length > draft.length) typed(d.slice(-1));
						else onDraft(d.slice(-4));
					}}
					onPaste={(e: ReactClipboardEvent<HTMLInputElement>) => {
						e.preventDefault();
						if (!open) return;
						fresh.current = false;
						onDraft(e.clipboardData.getData("text").replace(/\D/g, "").slice(-4));
					}}
				/>
			</div>
		</div>
	);
}

/**
 * The hit spark, played over and over for as long as the timer runs. It sits above the hammer but behind the cube: it starts
 * on the cube's right edge and the cube's own square is cut out of it, so the cube covers its left half. It is its own tiny
 * component so that flipping a frame twelve times a second redraws only this, not the whole gun. It pauses (no timer at
 * all) while the browser tab is hidden or the gun is not on screen, to save work.
 */
function SparkLoop() {
	const [frame, setFrame] = useState(0);
	const [tabVisible, setTabVisible] = useState(() => document.visibilityState !== "hidden");
	const [onScreen, setOnScreen] = useState(true);
	const ref = useRef<SVGGElement | null>(null);
	useEffect(() => {
		const onVisibility = () => setTabVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			const last = entries[entries.length - 1];
			if (last) setOnScreen(last.isIntersecting);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (!tabVisible || !onScreen) return;
		const timer = window.setInterval(() => setFrame((n) => (n + 1) % SPARK_BURST.length), SPARK_STEP * 1000);
		return () => window.clearInterval(timer);
	}, [tabVisible, onScreen]);
	const f = SPARK_BURST[frame];
	const all = `${f.shards} ${f.hair} ${f.stars}`;
	const cubeLeft = CUBE.x;
	const cubeRight = CUBE.x + CUBE.size;
	const cubeTop = CUBE.y;
	const cubeBottom = CUBE.y + CUBE.size;
	return (
		<g clipPath="url(#tg-spark-behind-cube)" pointerEvents="none">
			<defs>
				{/* Everything except the cube's square, so the cube stays in front of the spark. */}
				<clipPath id="tg-spark-behind-cube">
					<path
						clipRule="evenodd"
						d={`M-3000 -3000H3000V3000H-3000Z M${cubeLeft} ${cubeTop}H${cubeRight}V${cubeBottom}H${cubeLeft}Z`}
					/>
				</clipPath>
			</defs>
			<g ref={ref} className="tg-burn" transform={`translate(${cubeRight} ${IMPACT.y}) scale(${SPARK_SIZE})`}>
				{/* The cyan edge first, then the white over it, so only the outside edge shows. */}
				<path className="tg-bs-edge" d={all} />
				<path className="tg-bs-fill" d={all} />
				<path className="tg-bs-core" d={f.core} />
			</g>
		</g>
	);
}

export default function TimeGun({
	phase,
	running,
	remainingMs,
	totalMs,
	rounds,
	durations,
	onToggle,
	onSkip,
	onReset,
	onDuration
}: TimeGunProps) {
	const uid = useId().replace(/:/g, "");
	// Pressing the chamber opens the time popup on the left. The digits typed there (filling in from the right) are the draft,
	// and while the popup is open the reels roll to the draft, so the chamber flips as you type.
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickDraft, setPickDraft] = useState("");
	const pickSeconds = draftToSeconds(pickDraft);
	const pickValid = pickSeconds >= 1 && pickSeconds <= MAX_SECONDS;
	// The layout stays mounted while it slides back out, and is a fresh one (typing starts over) every time it opens.
	const [pickerKey, setPickerKey] = useState(0);
	const [panelMounted, setPanelMounted] = useState(false);
	useEffect(() => {
		if (pickerOpen) {
			setPanelMounted(true);
			return;
		}
		const timer = window.setTimeout(() => setPanelMounted(false), FOCUS_MS + 40);
		return () => window.clearTimeout(timer);
	}, [pickerOpen]);
	// The stage is measured, so the zoom and the width of the layout fit whatever width the notch really has.
	const stageRef = useRef<HTMLDivElement | null>(null);
	const [stage, setStage] = useState(STAGE_DEFAULT);
	useLayoutEffect(() => {
		const el = stageRef.current;
		if (!el) return;
		const measure = () =>
			setStage((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	// The reels read 00:00 until a time is picked (or a session is already under way).
	const [armed, setArmed] = useState(
		() => running || remainingMs !== totalMs || durations.focus !== POMO_DEFAULT_DURATIONS.focus
	);
	useEffect(() => {
		if (running) setArmed(true);
	}, [running]);
	// The cube catches a moment after the trigger is pulled, when the hammer lands on it. Pausing leaves it glowing (the hammer
	// cocks back as usual); it only goes out once the timer is back at its full time (reset, a new time, the next phase).
	const [lit, setLit] = useState(() => running || remainingMs < totalMs);
	// The hit spark loop, only while the timer is really running (a paused gun has its hammer cocked back, so nothing sparks).
	const [burning, setBurning] = useState(running);
	const [hits, setHits] = useState(0);
	const [sparking, setSparking] = useState(false);
	// Coming back to the tab while the timer is already running: the hammer is already down, so the spark is not
	// played again. It only plays when the trigger is pulled.
	const alreadyRunning = useRef(running);
	const wasRunning = useRef(running);
	// Fetch and decode the sounds as soon as the gun is on screen, so nothing is loaded at the moment of the hit.
	useEffect(() => {
		preloadTimeGunSounds();
	}, []);
	// Stopped after running: the hammer cocks back. This runs before the frame is drawn (a layout effect), so the click
	// and the hammer's swing start together instead of the click following a frame late.
	useLayoutEffect(() => {
		if (!running && wasRunning.current) playCock();
	}, [running]);
	useEffect(() => {
		if (!running) {
			wasRunning.current = false;
			alreadyRunning.current = false;
			setBurning(false);
			setSparking(false);
			return;
		}
		wasRunning.current = true;
		if (alreadyRunning.current) {
			// Back on the tab with the timer already counting: the fire is already burning, so it fades straight in.
			startFire(FIRE_FADE_IN);
			return () => stopFire(FIRE_FADE_OUT);
		}
		const sparkTimer = window.setTimeout(() => {
			setLit(true);
			setBurning(true);
			setSparking(true);
			setHits((h) => h + 1);
			// The cube has caught: the fire starts to crackle.
			startFire(FIRE_FADE_IN);
		}, SPARK_MS);
		const hitSoundTimer = window.setTimeout(() => playHit(), Math.max(0, SPARK_MS - HIT_SOUND_LEAD_MS));
		return () => {
			window.clearTimeout(sparkTimer);
			window.clearTimeout(hitSoundTimer);
			// Stopped, or the tab was left: the crackle fades out (the fade carries on after this component is gone).
			stopFire(FIRE_FADE_OUT);
		};
	}, [running]);
	// The cube glows while the timer runs, and stays glowing while it is paused part-way (time is gone from the full length).
	const glowing = lit && (running || remainingMs < totalMs);
	useEffect(() => {
		if (!running && remainingMs >= totalMs) setLit(false);
	}, [running, remainingMs, totalMs]);
	const secs = armed || running ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0;
	const minutes = Math.min(99, Math.floor(secs / 60));
	const seconds = secs % 60;
	// While a time is being typed the reels show the typed digits as they are (four, newest on the right).
	const digits = pickerOpen
		? pickDraft.padStart(4, "0").split("").map(Number)
		: [Math.floor(minutes / 10), minutes % 10, Math.floor(seconds / 10), seconds % 10];
	const elapsed = totalMs > 0 ? Math.min(1, Math.max(0, 1 - remainingMs / totalMs)) : 0;

	// A press outside the popup (or on the chamber, which toggles it) keeps what was typed, like the old timer did: if it is a
	// good time and not the one already set, it is loaded. Escape (inside the popup) throws the draft away instead.
	const closeKeeping = () => {
		if (pickValid && (pickSeconds !== Math.round(durations.focus * 60) || !armed)) pickTime(pickSeconds);
		else setPickerOpen(false);
	};
	const closeKeepingRef = useRef(closeKeeping);
	closeKeepingRef.current = closeKeeping;
	useEffect(() => {
		if (!pickerOpen) return;
		const onDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element) || !e.target.closest(".tg-picker, .tg-chamber")) closeKeepingRef.current();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setPickerOpen(false);
		};
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("keydown", onKey);
		};
	}, [pickerOpen]);

	// The time can only be changed while the gun is stopped, like the old timer's clock.
	const openPicker = () => {
		if (running) return;
		setPickDraft(secondsToDraft(Math.round(durations.focus * 60)));
		setPickerKey((k) => k + 1);
		setPickerOpen(true);
	};


	// Right-click on the gun (the browser's own menu never shows) only does something on the trigger:
	//  - running: stops the timer and puts the full time back on the reels. The trigger and the hammer are linked, so both spring
	//    back together as the timer stops (the same swing and click as always).
	//  - stopped: the dry fire above, and the cylinder spins to a random time that becomes the timer.
	const [dry, setDry] = useState(false);
	const dryTimer = useRef(0);
	useEffect(() => () => window.clearTimeout(dryTimer.current), []);
	const clickGun = () => {
		window.clearTimeout(dryTimer.current);
		playCock();
		setDry(true);
		dryTimer.current = window.setTimeout(() => setDry(false), DRY_HOLD_MS);
	};
	const handleContext = (e: MouseEvent) => {
		e.preventDefault();
		const target = e.target instanceof Element ? e.target : null;
		if (!target?.closest(".tg-trigger")) return;
		if (running) {
			setPickerOpen(false);
			onReset();
			return;
		}
		clickGun();
		pickTime(rollSeconds(Math.round(durations.focus * 60)));
	};

	// Picking a time sets the focus length (in seconds here, stored as minutes) and starts over from it, stopped, ready for the trigger.
	const pickTime = (seconds: number) => {
		onDuration("focus", seconds / 60 - durations.focus);
		onReset();
		setArmed(true);
		setPickerOpen(false);
	};

	const rigAt = toStage({ x: DRUM.x + DRUM.w / 2, y: DRUM.y + DRUM.h / 2 });
	// The camera. Closed: as drawn. Open: the chamber's middle goes to the middle of the space left of the layout (a touch
	// low, since the chamber sits above the middle of the art), zoomed in on, with the rest of the gun carried along.
	const panelW = Math.round(clamp(stage.w * PANEL_FRAC, PANEL_MIN, PANEL_MAX));
	const leftW = stage.w - panelW;
	const focusScale = clamp((leftW - FOCUS_MARGIN) / (DRUM.w * SCALE), FOCUS_ZOOM_MIN, FOCUS_ZOOM_MAX);
	const camStyle: CSSProperties = {
		transformOrigin: `${rigAt.left}px ${rigAt.top}px`,
		transform: pickerOpen
			? `translate(${leftW / 2 - rigAt.left}px, ${stage.h / 2 + 4 - rigAt.top}px) scale(${focusScale})`
			: "translate(0px, 0px) scale(1)"
	};
	const squareAt = toStage({ x: CUBE.x, y: CUBE.y });
	const glowAt = toStage({ x: CUBE.x + CUBE.size / 2, y: CUBE.y + CUBE.size / 2 });
	const pivot = `${HAMMER_PIVOT.x}px, ${HAMMER_PIVOT.y}px`;
	const unpivot = `${-HAMMER_PIVOT.x}px, ${-HAMMER_PIVOT.y}px`;
	const tpivot = `${TRIGGER_PIVOT.x}px, ${TRIGGER_PIVOT.y}px`;
	const tunpivot = `${-TRIGGER_PIVOT.x}px, ${-TRIGGER_PIVOT.y}px`;

	return (
		<div className="tg-root" style={{ "--tg-zoom": ZOOM / 0.6 } as CSSProperties} onContextMenu={handleContext}>
			<div className="tg-stage" ref={stageRef}>
				{/* The disk and memory scene behind the gun. It follows the camera part of the way when the chamber is zoomed in on, and shakes when the hammer lands. */}
				<TimeGunBackdrop
					running={running}
					hit={hits}
					origin={rigAt}
					camera={pickerOpen ? { x: leftW / 2 - rigAt.left, y: stage.h / 2 + 4 - rigAt.top, scale: focusScale } : null}
				/>
				<div className="tg-cam" style={camStyle}>
				{/* Everything that belongs to the gun turns together, about the middle of the cylinder. The quote stays level. */}
				<div
					className="tg-rig"
					style={{ transformOrigin: `${rigAt.left}px ${rigAt.top}px`, transform: `rotate(${GUN_TILT_DEGREES}deg)` }}
				>
				{/* The cube sits behind the gun layer (the ledge and the cylinder cover its edges). */}
				<i
					className={`tg-glow${glowing ? " lit" : ""}`}
					style={{ left: glowAt.left, top: glowAt.top, width: GLOW_SIZE * SCALE, height: GLOW_SIZE * SCALE }}
				/>
				<i
					className={`tg-square${glowing ? " lit" : ""}`}
					style={{
						left: squareAt.left,
						top: squareAt.top,
						width: CUBE.size * SCALE,
						height: (CUBE.size + CUBE.tuck) * SCALE
					}}
				/>

				<svg
					className="tg-gun"
					viewBox={`0 0 ${GUN_VIEWBOX.w} ${GUN_VIEWBOX.h}`}
					width={GUN_W}
					height={GUN_H}
					style={{ left: GUN_LEFT, top: GUN_TOP }}
				>
					<defs>
						{/* The drum is cut to the cylinder window, so the yellow can never spill past the ink. */}
						<clipPath id={`${uid}-drumclip`}>
							<path d={GUN_DRUM_D} />
						</clipPath>
						{COLUMNS.map((c, i) => (
							<clipPath key={i} id={`${uid}-col${i}`}>
								<rect x={c.x0} y={WINDOW_TOP} width={c.x1 - c.x0} height={WINDOW_BOTTOM - WINDOW_TOP} />
							</clipPath>
						))}
						<linearGradient
							id={`${uid}-drum`}
							gradientUnits="userSpaceOnUse"
							x1="0"
							y1={DRUM.y}
							x2="0"
							y2={DRUM.y + DRUM.h}
						>
							<stop offset="0" stopColor="var(--tg-drum-edge)" />
							<stop offset="0.14" stopColor="var(--tg-drum-mid)" />
							<stop offset="0.32" stopColor="var(--tg-drum)" />
							<stop offset="0.68" stopColor="var(--tg-drum)" />
							<stop offset="0.86" stopColor="var(--tg-drum-mid)" />
							<stop offset="1" stopColor="var(--tg-drum-edge)" />
						</linearGradient>
						<linearGradient
							id={`${uid}-fade`}
							gradientUnits="userSpaceOnUse"
							x1="0"
							y1={WINDOW_TOP}
							x2="0"
							y2={WINDOW_BOTTOM}
						>
							<stop offset="0" stopColor="#fff" stopOpacity="0.3" />
							<stop offset="0.4" stopColor="#fff" stopOpacity="1" />
							<stop offset="0.6" stopColor="#fff" stopOpacity="1" />
							<stop offset="1" stopColor="#fff" stopOpacity="0.3" />
						</linearGradient>
						<mask
							id={`${uid}-mask`}
							maskUnits="userSpaceOnUse"
							x="200"
							y={WINDOW_TOP}
							width="160"
							height={WINDOW_BOTTOM - WINDOW_TOP}
						>
							<rect x="200" y={WINDOW_TOP} width="160" height={WINDOW_BOTTOM - WINDOW_TOP} fill={`url(#${uid}-fade)`} />
						</mask>
					</defs>

					{/* Everything is drawn in the art's own coordinates, shifted so the crop starts at 0,0. */}
					<g transform={`translate(${-GUN_VIEWBOX.x} ${-GUN_VIEWBOX.y})`}>
						{/* The trigger sits behind the frame so its top end stays hidden as it turns. */}
						<g
							className={`tg-trigger-piece${running || dry ? " pulled" : ""}`}
							style={{
								transformOrigin: "0 0",
								transform: `translate(${tpivot}) rotate(${running || dry ? PULL_DEGREES : 0}deg) translate(${tunpivot})`
							}}
						>
							<path className="tg-f-frameAccent" d={GUN_TRIGGER_FILL} fillRule="evenodd" />
							<g className="tg-line">
								<path d={GUN_TRIGGER_D} fillRule="evenodd" />
							</g>
						</g>

						{/* Flat colour under the line art. */}
						<g className="tg-fills">
							{Object.entries(GUN_FILLS).map(([name, d]) => (
								<path key={name} className={`tg-f-${name}`} d={d} fillRule="evenodd" />
							))}
							<rect
								className="tg-drum"
								x={DRUM.x - 6}
								y={DRUM.y - 6}
								width={DRUM.w + 12}
								height={DRUM.h + 12}
								fill={`url(#${uid}-drum)`}
								clipPath={`url(#${uid}-drumclip)`}
							/>
						</g>

						<g className="tg-line">
							<path d={GUN_STATIC_D} fillRule="evenodd" />
						</g>

						{/* The cylinder: four reels that roll to the remaining minutes and seconds. */}
						<g className={`tg-reels${running ? " running" : ""}${pickerOpen ? " editing" : ""}`} mask={`url(#${uid}-mask)`}>
							{COLUMNS.map((c, i) => (
								<g key={i} clipPath={`url(#${uid}-col${i})`}>
									<g className="tg-strip" style={{ transform: `translateY(${-digits[i] * ROW_PITCH}px)` }}>
										{STRIP.map((row) => (
											<Glyph key={row} ch={String((row + 10) % 10)} cx={(c.x0 + c.x1) / 2} cy={ROW_CENTER + row * ROW_PITCH} />
										))}
									</g>
								</g>
							))}
						</g>
						<circle className="tg-colon" cx="281" cy="166" r="1.9" />
						<circle className="tg-colon" cx="281" cy="179" r="1.9" />

						{/* The hammer and its pivot hole; it cocks back while the timer counts. */}
						<g
							className={`tg-hammer${running || dry ? " fired" : ""}`}
							style={{
								transformOrigin: "0 0",
								transform: `translate(${pivot}) rotate(${running || dry ? STRIKE_DEGREES : 0}deg) translate(${unpivot})`
							}}
						>
							{/* Inside the hammer's own swing, a second layer rebounds off the cube when it lands (see tg-hammer-rebound in the
							    CSS). Keyed on the hit count so every hit plays it again. */}
							<g
								key={hits}
								className={hits ? "tg-hammer-rebound" : undefined}
								style={{ transformOrigin: "0 0", "--tg-hp": pivot, "--tg-hp-neg": unpivot } as CSSProperties}
							>
								<g className="tg-hammer-fills">
									<path className="tg-hf-head" d={GUN_HAMMER_FILLS.head} />
									<path className="tg-hf-base" d={GUN_HAMMER_FILLS.base} />
								</g>
								<g className="tg-line">
									<path d={GUN_HAMMER_D} fillRule="evenodd" />
								</g>
							</g>
						</g>

						{/* The vignette: a dark veil over the gun and the cube, with a soft lit circle on the chamber (the focus). The cube
						    only gets a lit patch once it has caught. The flash and the spark are drawn after it, so they stay bright. */}
						{(() => {
							const cx = DRUM.x + DRUM.w / 2;
							const cy = DRUM.y + DRUM.h / 2;
							const R = (VEIL.clear + VEIL.soft) / SCALE;
							const cubeX = CUBE.x + CUBE.size / 2;
							const cubeY = CUBE.y + CUBE.size / 2;
							const cubeR = VEIL_CUBE.clear + VEIL_CUBE.soft;
							return (
								<g pointerEvents="none">
									<defs>
										<radialGradient id="tg-veil-dark" gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={R}>
											{EASE_T.map((t) => (
												<stop key={t} offset={(VEIL.clear + VEIL.soft * t) / SCALE / R} stopColor="#000" stopOpacity={VEIL.dark * smooth(t)} />
											))}
										</radialGradient>
										<radialGradient id="tg-veil-hole" gradientUnits="userSpaceOnUse" cx={cubeX} cy={cubeY} r={cubeR}>
											<stop offset="0" stopColor="#000" />
											{EASE_T.map((t) => (
												<stop key={t} offset={(VEIL_CUBE.clear + VEIL_CUBE.soft * t) / cubeR} stopColor={`rgb(${Math.round(255 * smooth(t))},${Math.round(255 * smooth(t))},${Math.round(255 * smooth(t))})`} />
											))}
										</radialGradient>
										<mask id="tg-veil-mask" maskUnits="userSpaceOnUse" x={-1500} y={-1500} width={3000} height={3000}>
											<rect x={-1500} y={-1500} width={3000} height={3000} fill="#fff" />
											{glowing && <circle cx={cubeX} cy={cubeY} r={cubeR} fill="url(#tg-veil-hole)" />}
										</mask>
									</defs>
									<rect x={-1500} y={-1500} width={3000} height={3000} fill="url(#tg-veil-dark)" mask="url(#tg-veil-mask)" />
								</g>
							);
						})()}

						{/* The traced spark where the hammer lands on the cube. It flies up and away from the hammer. */}
						{sparking && (
							<g transform={`translate(${IMPACT.x} ${IMPACT.y}) scale(${FLARE_SCALE})`} pointerEvents="none">
								<defs>
									<radialGradient id="tg-flare-halo">
										<stop offset="0" stopColor="#ffffff" stopOpacity="1" />
										<stop offset="0.12" stopColor="#ffffff" stopOpacity="0.85" />
										<stop offset="0.4" stopColor="#4de6ff" stopOpacity="0.4" />
										<stop offset="1" stopColor="#4de6ff" stopOpacity="0" />
									</radialGradient>
									<radialGradient id="tg-flare-bigglow">
										<stop offset="0" stopColor="#ffffff" stopOpacity="0.6" />
										<stop offset="0.2" stopColor="#ffffff" stopOpacity="0.35" />
										<stop offset="0.5" stopColor="#4de6ff" stopOpacity="0.25" />
										<stop offset="1" stopColor="#4de6ff" stopOpacity="0" />
									</radialGradient>
									<radialGradient id="tg-flare-wide">
										<stop offset="0" stopColor="#4de6ff" stopOpacity="0.3" />
										<stop offset="1" stopColor="#4de6ff" stopOpacity="0" />
									</radialGradient>
									<radialGradient id="tg-flare-ghost">
										<stop offset="0" stopColor="#ffffff" stopOpacity="0.15" />
										<stop offset="0.7" stopColor="#bff6ff" stopOpacity="0.5" />
										<stop offset="1" stopColor="#4de6ff" stopOpacity="0" />
									</radialGradient>
									<filter id="tg-flare-blur" x="-30%" y="-30%" width="160%" height="160%">
										<feGaussianBlur stdDeviation={FLARE_BLUR} />
									</filter>
									<linearGradient id="tg-flare-streak" x1="0" x2="1" y1="0" y2="0">
										<stop offset="0" stopColor="#4de6ff" stopOpacity="0" />
										<stop offset="0.5" stopColor="#ffffff" stopOpacity="1" />
										<stop offset="1" stopColor="#4de6ff" stopOpacity="0" />
									</linearGradient>
								</defs>
								{/* One still frame of a lens flare (no movement): soft halo, long thin streak across, a short cross streak,
								    a faint big ring, and soft ghost discs trailing along the diagonal. It is simply on, then off. */}
								<g key={hits} className="tg-flare" style={{ animationDuration: `${FLARE_SECONDS}s` }}>
									<ellipse rx="66" ry="36" fill="url(#tg-flare-wide)" />
									<circle cx="-12" cy="10" r="34" fill="none" stroke="#4de6ff" strokeOpacity="0.3" strokeWidth="1.2" />
									<rect x="-100" y="-1.6" width="200" height="3.2" rx="1.6" fill="url(#tg-flare-streak)" opacity="0.9" />
									<rect x="-45" y="-0.7" width="90" height="1.4" rx="0.7" fill="#ffffff" opacity="0.9" />
									<rect x="-24" y="-0.9" width="48" height="1.8" rx="0.9" fill="url(#tg-flare-streak)" transform="rotate(90)" />
									<rect x="-46" y="-3.5" width="92" height="7" rx="3.5" fill="url(#tg-flare-streak)" opacity="0.55" transform="rotate(-45)" />
									<circle r="30" fill="url(#tg-flare-halo)" />
									<circle r="4.5" fill="#ffffff" />
									<circle cx="24" cy="-24" r="6" fill="url(#tg-flare-ghost)" />
									<circle cx="40" cy="-40" r="9" fill="url(#tg-flare-ghost)" opacity="0.8" />
									<circle cx="58" cy="-58" r="5" fill="url(#tg-flare-ghost)" opacity="0.7" />
									<circle cx="-16" cy="16" r="6" fill="url(#tg-flare-ghost)" opacity="0.8" />
									<circle cx="-30" cy="30" r="4" fill="url(#tg-flare-ghost)" opacity="0.7" />
									{/* The big soft glow over everything else. */}
									<circle r="95" fill="url(#tg-flare-bigglow)" />
								</g>
							</g>
						)}

						{/* The spark keeps playing while the timer runs (from the hit until it stops or pauses). */}
						{burning && <SparkLoop />}

						{/* Press the chamber to pick the time. */}
						<rect
							className={`tg-chamber${pickerOpen ? " open" : ""}`}
							x={DRUM.x}
							y={DRUM.y}
							width={DRUM.w}
							height={DRUM.h}
							rx={DRUM.r}
							onClick={() => (pickerOpen ? closeKeeping() : openPicker())}
						/>

						{/* Click the trigger guard to start or pause; right-click stops and resets while running, and (stopped) dry-fires and rolls a random time. */}
						<rect
							className="tg-trigger"
							x="232"
							y="240"
							width="110"
							height="74"
							rx="14"
							onClick={() => (armed ? onToggle() : openPicker())}
						/>
					</g>
				</svg>


				</div>

				</div>

				{/* The time layout slides in from the right while the camera pushes the gun left. It stays mounted for the slide out. */}
				{(pickerOpen || panelMounted) && (
					<TimePicker
						key={pickerKey}
						open={pickerOpen}
						draft={pickDraft}
						onDraft={setPickDraft}
						onSubmit={() => pickValid && pickTime(pickSeconds)}
						onCancel={() => setPickerOpen(false)}
						onPick={(minutes) => pickTime(minutes * 60)}
						width={panelW}
						nowSeconds={Math.round(durations.focus * 60)}
					/>
				)}

				{/* The quote stays up while the timer runs: it fades in when the trigger is pulled and out when the timer pauses or stops. */}
				<div className={`tg-quote${running && !pickerOpen ? " on" : ""}`} aria-hidden={!running || pickerOpen}>
					{POMO_QUOTE}
				</div>
			</div>

			{SHOW_CONTROLS && (
			<div className="tg-side">
				<div className="tg-phase">
					<span className="tg-phase-name">{PHASE_LABEL[phase]}</span>
					<span className="tg-phase-state">{running ? "Counting" : "Ready"}</span>
				</div>
				<div className="tg-progress" aria-hidden>
					<div className="tg-progress-fill" style={{ width: `${elapsed * 100}%` }} />
				</div>
				<div className="tg-rounds">
					{Array.from({ length: POMO_ROUNDS }, (_, i) => (
						<i key={i} className={`tg-round${i < rounds ? " spent" : ""}`} />
					))}
				</div>

				<button className="tg-fire" onClick={onToggle}>
					{running ? <Pause size={14} /> : <Play size={14} />}
					<span>{running ? "Pause" : "Pull the trigger"}</span>
				</button>
				<div className="tg-actions">
					<button className="tg-icon" onClick={onSkip} aria-label="Skip to the next phase">
						<SkipForward size={14} />
					</button>
					<button className="tg-icon" onClick={onReset} aria-label="Reset the cycle">
						<RotateCcw size={14} />
					</button>
				</div>

				<div className="tg-durations">
					{(["focus", "short", "long"] as const).map((p) => (
						<div key={p} className="tg-dur">
							<span className="tg-dur-label">{p === "focus" ? "Focus" : p === "short" ? "Break" : "Long"}</span>
							<button
								className="tg-step"
								onClick={() => onDuration(p, -1)}
								disabled={durations[p] <= 1}
								aria-label="One minute less"
							>
								<Minus size={11} />
							</button>
							<span className="tg-dur-value">{durations[p]}m</span>
							<button
								className="tg-step"
								onClick={() => onDuration(p, 1)}
								disabled={durations[p] >= 99}
								aria-label="One minute more"
							>
								<Plus size={11} />
							</button>
						</div>
					))}
				</div>
			</div>
			)}
		</div>
	);
}
