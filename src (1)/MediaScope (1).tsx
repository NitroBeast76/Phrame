/**
 * The retro media tab: a bench oscilloscope, drawn in the same paper-and-ink
 * language as the other retro tabs.
 *
 * The faceplate is a flat card (2px ink outline, hard offset shadow) like the
 * dashboard and performance cards, so the tab sits with its neighbours. What
 * makes it a scope: a thick pale bezel around a phosphor screen, and real
 * skirted knobs with a printed scale -- the controls turn when you use them.
 *
 * Colours come from the --retro-* variables (paper, ink, accent: pywal, via
 * theme.ts) and the --scope-* variables (screen well, phosphor, lamp). The
 * phosphor stays green on purpose; everything else follows the wallpaper.
 *
 * Every feature of the previous scope is kept: play/pause, previous, next,
 * seek, wheel-over-the-screen volume, the sound-output picker, copy, the source
 * tag and the picture slot. New: the volume is also a knob you can drag, wheel
 * or move with the arrow keys.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	Check,
	ChevronLeft,
	Copy,
	ImagePlus,
	RefreshCw,
	Volume1,
	Volume2,
	VolumeX,
	X
} from "lucide-react";
import { MusicNoteIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "./icons";
import type { MediaTabInfo } from "./MediaTab";
import "./MediaScope.css";

interface AudioOutput {
	id: string;
	name: string;
	isDefault: boolean;
}

// The sweep: how many samples across the screen, and how fast the trace chases
// a new level (quick rise, slow phosphor-like fall).
const POINTS = 150;
const RISE_MS = 60;
const FALL_MS = 320;
const IDLE = 0.06;

// Keys that move the seek slider, so a keyboard seek is sent too (not only a mouse drag).
const SEEK_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

const formatTime = (ms: number): string => {
	if (ms <= 0) return "0:00";
	const total = Math.floor(ms / 1000);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

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
	f0dc299d809b97: "Zen",
	"308046b0af4a39cb": "Firefox",
	zen: "Zen"
};

const friendlySource = (id: string): string => {
	if (!id) return "";
	const tail = id.includes("!") ? id.split("!").pop() || id : id;
	const key = tail.replace(/\.exe$/i, "").toLowerCase();
	const known = Object.keys(SOURCE_NAMES).find((k) => key.includes(k));
	if (known) return SOURCE_NAMES[known];
	if (/^[0-9a-f]{12,}$/.test(key)) return "";
	const last = key.split(".").pop() || key;
	return last.charAt(0).toUpperCase() + last.slice(1);
};

/**
 * The screen: a graticule, a phosphor trace, and the small readouts a real scope
 * prints on its glass (channel and timebase, record status, a peak marker).
 *
 * Drawn on a canvas because the sweep is one continuous path with a glow under
 * it. Reads the same "audio-visualization" event as the cover bars, so no new
 * backend work is needed.
 */
function ScreenTrace({ isPlaying }: { isPlaying: boolean }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		let w = 1;
		let h = 1;
		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			const r = canvas.getBoundingClientRect();
			w = Math.max(1, Math.round(r.width));
			h = Math.max(1, Math.round(r.height));
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(canvas);

		const css = getComputedStyle(canvas);
		const phos = css.getPropertyValue("--scope-phos").trim() || "#7ed6b4";
		const screen = css.getPropertyValue("--scope-screen").trim() || "#0d1f1a";
		const lamp = css.getPropertyValue("--scope-lamp").trim() || "#c0392b";
		const family = css.fontFamily || "monospace";

		const levels = new Array<number>(POINTS).fill(IDLE);
		let bands: number[] = [];
		let unlisten: Promise<() => void> | null = null;
		if (isPlaying) {
			unlisten = listen<{ frequencies: number[] }>("audio-visualization", (e) => {
				bands = e.payload.frequencies;
			});
		}

		// The held peak: it jumps up with the loudest point and drifts back down.
		let peak = 0;
		let peakIdx = Math.floor(POINTS / 2);

		let frame = 0;
		let last = performance.now();
		const loop = (now: number) => {
			const dt = Math.min(now - last, 50);
			last = now;
			const t = now / 1000;

			let maxV = 0;
			let maxI = 0;
			for (let i = 0; i < POINTS; i++) {
				// Mirror the spectrum about the centre so the sweep reads as one
				// waveform rather than noise.
				const x01 = i / (POINTS - 1);
				const m = x01 < 0.5 ? x01 * 2 : (1 - x01) * 2;
				let target = IDLE;
				if (bands.length > 0) {
					const pos = m * (bands.length - 1);
					const lo = Math.floor(pos);
					const hi = Math.min(bands.length - 1, lo + 1);
					const f = pos - lo;
					const eased = f * f * (3 - 2 * f);
					const v = bands[lo] + (bands[hi] - bands[lo]) * eased;
					target = Math.max(IDLE, Math.min(1, v));
				} else {
					target = IDLE + 0.035 * Math.sin(t * 0.8 + i * 0.05);
				}
				const cur = levels[i];
				const tau = target > cur ? RISE_MS : FALL_MS;
				levels[i] = cur + (target - cur) * (1 - Math.exp(-dt / tau));
				if (levels[i] > maxV) {
					maxV = levels[i];
					maxI = i;
				}
			}
			peak = Math.max(maxV, peak - dt * 0.0004);
			if (maxV >= peak - 0.002) peakIdx = maxI;

			// --- paint ---
			ctx.clearRect(0, 0, w, h);
			ctx.fillStyle = screen;
			ctx.fillRect(0, 0, w, h);

			// Graticule: 10 columns by 8 rows, a brighter centre cross, and the
			// fine ticks a real scope prints along the two centre lines.
			const cols = 10;
			const rows = 8;
			ctx.lineWidth = 1;
			ctx.strokeStyle = phos;
			ctx.globalAlpha = 0.16;
			ctx.beginPath();
			for (let i = 1; i < cols; i++) {
				if (i === cols / 2) continue;
				const x = Math.round((i / cols) * w) + 0.5;
				ctx.moveTo(x, 0);
				ctx.lineTo(x, h);
			}
			for (let i = 1; i < rows; i++) {
				if (i === rows / 2) continue;
				const y = Math.round((i / rows) * h) + 0.5;
				ctx.moveTo(0, y);
				ctx.lineTo(w, y);
			}
			ctx.stroke();

			ctx.globalAlpha = 0.34;
			ctx.beginPath();
			const cx = Math.round(w / 2) + 0.5;
			const cy = Math.round(h / 2) + 0.5;
			ctx.moveTo(cx, 0);
			ctx.lineTo(cx, h);
			ctx.moveTo(0, cy);
			ctx.lineTo(w, cy);
			// Fine ticks, five to a division.
			for (let i = 0; i <= cols * 5; i++) {
				const x = Math.round((i / (cols * 5)) * w) + 0.5;
				ctx.moveTo(x, cy - 3);
				ctx.lineTo(x, cy + 3);
			}
			for (let i = 0; i <= rows * 5; i++) {
				const y = Math.round((i / (rows * 5)) * h) + 0.5;
				ctx.moveTo(cx - 3, y);
				ctx.lineTo(cx + 3, y);
			}
			ctx.stroke();
			ctx.globalAlpha = 1;

			// The trace.
			const mid = h / 2;
			const amp = (h / 2) * 0.8;
			const path = new Path2D();
			for (let i = 0; i < POINTS; i++) {
				const x = (i / (POINTS - 1)) * w;
				const y = mid - levels[i] * amp;
				if (i === 0) path.moveTo(x, y);
				else path.lineTo(x, y);
			}
			ctx.lineJoin = "round";
			ctx.lineCap = "round";

			// Wide, soft pass for the glow; thin bright pass for the beam.
			ctx.strokeStyle = phos;
			ctx.globalAlpha = 0.16;
			ctx.lineWidth = 8;
			ctx.stroke(path);
			ctx.globalAlpha = 0.42;
			ctx.lineWidth = 3.4;
			ctx.stroke(path);
			ctx.globalAlpha = 0.95;
			ctx.lineWidth = 1.4;
			ctx.stroke(path);
			ctx.globalAlpha = 1;

			// --- The readouts ---
			// A peak cursor: a red line down to the baseline, a diamond on the trace
			// and a small flag, the way the reference marks what it has found.
			if (isPlaying && peak > IDLE + 0.1) {
				const px = (peakIdx / (POINTS - 1)) * w;
				const py = mid - peak * amp;
				ctx.strokeStyle = lamp;
				ctx.globalAlpha = 0.85;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(px + 0.5, py);
				ctx.lineTo(px + 0.5, mid);
				ctx.stroke();
				ctx.fillStyle = lamp;
				ctx.beginPath();
				ctx.moveTo(px, py - 4);
				ctx.lineTo(px + 4, py);
				ctx.lineTo(px, py + 4);
				ctx.lineTo(px - 4, py);
				ctx.closePath();
				ctx.fill();
				const fx = Math.min(w - 26, Math.max(10, px + 7));
				const fy = Math.max(18, py - 12);
				ctx.fillRect(fx, fy, 15, 9);
				ctx.globalAlpha = 1;
				ctx.fillStyle = screen;
				ctx.font = `700 6.5px ${family}`;
				ctx.textAlign = "left";
				ctx.textBaseline = "middle";
				ctx.fillText("PK", fx + 3, fy + 4.8);
			}

			// Corner brackets round the glass.
			const pad = 7;
			const arm = 9;
			ctx.strokeStyle = phos;
			ctx.globalAlpha = 0.6;
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(pad, pad + arm);
			ctx.lineTo(pad, pad);
			ctx.lineTo(pad + arm, pad);
			ctx.moveTo(w - pad - arm, pad);
			ctx.lineTo(w - pad, pad);
			ctx.lineTo(w - pad, pad + arm);
			ctx.moveTo(pad, h - pad - arm);
			ctx.lineTo(pad, h - pad);
			ctx.lineTo(pad + arm, h - pad);
			ctx.moveTo(w - pad - arm, h - pad);
			ctx.lineTo(w - pad, h - pad);
			ctx.lineTo(w - pad, h - pad - arm);
			ctx.stroke();

			// Small print: channel and timebase, record status, the held peak and a
			// voltage scale down the left edge.
			ctx.fillStyle = phos;
			ctx.font = `7.5px ${family}`;
			ctx.textBaseline = "top";
			ctx.textAlign = "left";
			ctx.globalAlpha = 0.75;
			ctx.fillText("CH1 DC 1V/DIV", pad + 5, pad + 3);
			ctx.textAlign = "right";
			ctx.fillText(isPlaying ? "REC" : "STBY", w - pad - (isPlaying ? 13 : 5), pad + 3);
			if (isPlaying && Math.floor(t * 1.6) % 2 === 0) {
				ctx.fillStyle = lamp;
				ctx.globalAlpha = 1;
				ctx.beginPath();
				ctx.arc(w - pad - 7, pad + 6.6, 2.3, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = phos;
			}
			ctx.globalAlpha = 0.75;
			ctx.textBaseline = "bottom";
			ctx.textAlign = "right";
			ctx.fillText(`PK ${String(Math.round(Math.min(1, peak) * 100)).padStart(2, "0")}%`, w - pad - 5, h - pad - 3);
			ctx.textAlign = "left";
			ctx.globalAlpha = 0.5;
			ctx.font = `6.5px ${family}`;
			ctx.textBaseline = "middle";
			ctx.fillText("+", pad + 3, Math.round((2 / rows) * h));
			ctx.fillText("0", pad + 3, cy + 6);
			ctx.fillText("-", pad + 3, Math.round((6 / rows) * h));
			ctx.globalAlpha = 1;

			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);

		return () => {
			cancelAnimationFrame(frame);
			ro.disconnect();
			if (unlisten) unlisten.then((fn) => fn());
		};
	}, [isPlaying]);

	return <canvas ref={canvasRef} className="ms-screen-canvas" aria-hidden />;
}

// A point on a circle, with 0deg at twelve o'clock and angles running clockwise.
const polar = (r: number, deg: number): [number, number] => {
	const a = ((deg - 90) * Math.PI) / 180;
	return [r * Math.cos(a), r * Math.sin(a)];
};

/**
 * The knob artwork, as one SVG so it stays crisp at any size.
 *
 * From the outside in: a printed scale on the faceplate, a hard offset shadow
 * (the same one the cards use), the fluted skirt with its pointer (this part
 * turns, by the --a variable the button sets), and the fixed cap the glyph
 * sits on. One unit is one pixel when the knob is 64px wide.
 */
function KnobArt({
	cap,
	ticks = 0,
	sweep = 270,
	turnCap = false
}: {
	cap: "ink" | "accent" | "paper";
	ticks?: number;
	sweep?: number;
	// The volume knob has no glyph, so its cap turns with the skirt and carries a pointer.
	turnCap?: boolean;
}) {
	const marks = [];
	for (let i = 0; i < ticks; i++) {
		const deg = ticks === 1 ? 0 : -sweep / 2 + (i / (ticks - 1)) * sweep;
		const major = i === 0 || i === ticks - 1 || (ticks > 2 && i === (ticks - 1) / 2);
		const [x1, y1] = polar(major ? 27 : 28.4, deg);
		const [x2, y2] = polar(31, deg);
		marks.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />);
	}
	return (
		<svg className="ms-knob-art" viewBox="-32 -32 64 64" aria-hidden>
			<g className="ms-knob-scale">{marks}</g>
			<circle className="ms-knob-shadow" cx="1.8" cy="2.2" r="23" />
			<g className="ms-knob-top">
				<g className="ms-skirt">
					<circle className="ms-skirt-body" r="23" />
					<circle className="ms-skirt-flutes" r="19.4" />
					<path className="ms-skirt-pointer" d="M0 -22 V-14.6" />
					{turnCap && (
						<>
							<circle className={`ms-cap ${cap}`} r="13.4" />
							<path className="ms-cap-pointer" d="M0 -3.6 V-10.6" />
						</>
					)}
				</g>
				{!turnCap && <circle className={`ms-cap ${cap}`} r="13.4" />}
				<path className="ms-cap-gloss" d="M-8.6 -5.4 A10.2 10.2 0 0 1 -1.6 -9.8" />
			</g>
		</svg>
	);
}

/** A push knob: it turns a little while held, and the legend sits under it. */
function Knob({
	label,
	onClick,
	children,
	kind,
	cap,
	turn,
	ticks,
	sweep,
	title
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
	kind: "prev" | "next" | "play";
	cap: "ink" | "accent" | "paper";
	// Resting angle in degrees (the play knob swings between two stops).
	turn?: number;
	ticks?: number;
	sweep?: number;
	title?: string;
}) {
	return (
		<button
			className={`ms-knob ${kind}`}
			onClick={onClick}
			title={title ?? label}
			style={turn === undefined ? undefined : ({ "--a": `${turn}deg` } as React.CSSProperties)}
		>
			<span className="ms-knob-face">
				<KnobArt cap={cap} ticks={ticks} sweep={sweep} />
				<span className="ms-knob-glyph">{children}</span>
			</span>
			<span className="ms-knob-legend">{label}</span>
		</button>
	);
}

/**
 * The volume knob: drag it up or to the right to turn it up, use the wheel, or
 * the arrow keys. It shows the level as its pointer angle, 270 degrees in all.
 */
function VolumeKnob({
	volume,
	onSet,
	onNudge
}: {
	volume: number;
	onSet: (v: number) => void;
	onNudge: (d: number) => void;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; y: number; v: number } | null>(null);
	const nudgeRef = useRef(onNudge);
	nudgeRef.current = onNudge;

	// A native listener, because React's wheel handler is passive and cannot
	// stop the page from scrolling.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			nudgeRef.current(Math.max(-0.06, Math.min(0.06, -e.deltaY * 0.0005)));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const angle = -135 + volume * 270;
	return (
		<div className="ms-knob vol-wrap">
			<div
				ref={ref}
				className="ms-vol"
				role="slider"
				tabIndex={0}
				aria-label="Volume"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(volume * 100)}
				title="Drag, scroll or use the arrow keys"
				style={{ "--a": `${angle}deg` } as React.CSSProperties}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					dragRef.current = { x: e.clientX, y: e.clientY, v: volume };
				}}
				onPointerMove={(e) => {
					const d = dragRef.current;
					if (!d) return;
					onSet(d.v + (d.y - e.clientY + (e.clientX - d.x) * 0.6) / 130);
				}}
				onPointerUp={() => {
					dragRef.current = null;
				}}
				onPointerCancel={() => {
					dragRef.current = null;
				}}
				onKeyDown={(e) => {
					const step = e.shiftKey ? 0.1 : 0.04;
					if (e.key === "ArrowUp" || e.key === "ArrowRight") onNudge(step);
					else if (e.key === "ArrowDown" || e.key === "ArrowLeft") onNudge(-step);
					else return;
					e.preventDefault();
				}}
			>
				<span className="ms-knob-face">
					<KnobArt cap="ink" ticks={11} sweep={270} turnCap />
				</span>
			</div>
			<span className="ms-knob-legend">VOL</span>
		</div>
	);
}

/** The sound-output picker, restyled to match the case. */
function OutputPanel({
	outputs,
	onPick,
	onBack
}: {
	outputs: AudioOutput[];
	onPick: (id: string) => void;
	onBack: () => void;
}) {
	return (
		<motion.div
			className="ms-output"
			initial={{ opacity: 0, y: 10 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
			transition={{ type: "spring", stiffness: 420, damping: 32 }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="ms-output-head">
				<button className="ms-output-back" onClick={onBack} title="Back">
					<ChevronLeft size={13} strokeWidth={2.4} />
				</button>
				<span className="ms-output-title">Output</span>
			</div>
			<ScrollArea outputs={outputs} onPick={onPick} />
		</motion.div>
	);
}

function ScrollArea({ outputs, onPick }: { outputs: AudioOutput[]; onPick: (id: string) => void }) {
	return (
		<div className="ms-output-list">
			{outputs.length === 0 && <div className="ms-output-empty">No devices</div>}
			{outputs.map((d) => (
				<button
					key={d.id}
					className={`ms-output-item${d.isDefault ? " active" : ""}`}
					onClick={() => onPick(d.id)}
					title={d.name}
				>
					<span className="ms-output-name">{d.name}</span>
					{d.isDefault && <Check size={12} strokeWidth={2.6} className="ms-output-check" />}
				</button>
			))}
		</div>
	);
}

export function MediaScope({
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
	slotImage?: string | null;
	onPickSlot?: () => void;
	onClearSlot?: () => void;
}) {
	const { positionMs, durationMs: reportedDuration, positionUpdatedAt, isPlaying, seekEnabled } = media;

	// Browsers sometimes report a duration of 0 for a moment. Remember the last
	// real one so the readout does not blink out, as the original does.
	const trackKey = `${media.title}|${media.artist}`;
	const lastDurationRef = useRef({ key: "", ms: 0 });
	if (reportedDuration > 0) lastDurationRef.current = { key: trackKey, ms: reportedDuration };
	const durationMs =
		reportedDuration > 0
			? reportedDuration
			: lastDurationRef.current.key === trackKey
				? lastDurationRef.current.ms
				: 0;

	const backendPosRef = useRef(positionMs);
	const backendTimeRef = useRef(positionUpdatedAt || Date.now());
	const seekingRef = useRef(false);
	const [displayPosition, setDisplayPosition] = useState(() =>
		Math.min(positionMs + (isPlaying ? Date.now() - (positionUpdatedAt || Date.now()) : 0), durationMs || Infinity)
	);

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

	const [copied, setCopied] = useState(false);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		},
		[]
	);
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

	// Sound output, opened by pressing the screen. Same commands as before.
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
			setOutputs((list) => list.map((d) => ({ ...d, isDefault: d.id === id })));
			invoke("set_audio_output", { id })
				.catch((e) => console.error("Failed to switch audio output:", e))
				.finally(() => setTimeout(refreshOutputs, 400));
		},
		[refreshOutputs]
	);
	useEffect(() => {
		if (!media.hasMedia) setOutOpen(false);
	}, [media.hasMedia]);

	// Wheel over the screen drives system volume, shown on the screen's own
	// readout rather than a separate ring.
	const screenRef = useRef<HTMLDivElement | null>(null);
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
		const unlisten = listen<{ volume: number; is_muted: boolean }>("volume-change", (ev) => {
			if (performance.now() - lastWheelRef.current < 400) return;
			volumeRef.current = ev.payload.volume;
			setVolume(ev.payload.volume);
			setVolMuted(ev.payload.is_muted);
		});
		return () => {
			unlisten.then((fn) => fn());
			window.clearTimeout(volHideTimerRef.current);
			window.clearTimeout(volSendTimerRef.current);
		};
	}, []);

	// One place that changes the volume, whether it came from the wheel over the
	// screen, the volume knob or the keyboard.
	const applyVolume = useCallback((value: number) => {
		const next = Math.max(0, Math.min(1, value));
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
	}, []);
	const nudgeVolume = useCallback((d: number) => applyVolume(volumeRef.current + d), [applyVolume]);

	useEffect(() => {
		const el = screenRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			nudgeVolume(Math.max(-0.06, Math.min(0.06, -e.deltaY * 0.0005)));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [media.hasMedia, nudgeVolume]);


	if (!media.hasMedia) {
		return (
			<div className="ms-root ms-empty">
				<div className="ms-face">
					<div className="ms-empty-unit">
						<div className="ms-empty-screen">
							<MusicNoteIcon size={22} />
						</div>
						<span className="ms-empty-text">No signal</span>
					</div>
				</div>
			</div>
		);
	}

	const progress = durationMs > 0 ? Math.min(100, (displayPosition / durationMs) * 100) : 0;
	const sourceName = friendlySource(media.source);
	const shownVolume = volMuted ? 0 : volume;

	return (
		<div className="ms-root">
			<div className="ms-face">
				{/* Four screws, one in each corner of the faceplate. */}
				<i className="ms-screw tl" aria-hidden />
				<i className="ms-screw tr" aria-hidden />
				<i className="ms-screw bl" aria-hidden />
				<i className="ms-screw br" aria-hidden />
				{/* ---- The screen, in its bezel, with the track plate underneath ---- */}
				<div className="ms-scope">
					<div className="ms-bezel">
						<div
							ref={screenRef}
							className="ms-screen"
							role="button"
							tabIndex={0}
							aria-label="Sound output"
							title="Click for output devices, scroll to change volume"
							onClick={toggleOutputs}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									toggleOutputs();
								}
							}}
						>
							<ScreenTrace isPlaying={isPlaying} />

							{/* The cover, as a small phosphor print in the corner of the glass. */}
							{media.art && (
								<span className="ms-thumb" aria-hidden>
									<img src={media.art} alt="" draggable={false} />
								</span>
							)}

							{/* Volume readout, drawn on the glass while it changes. */}
							<span className={`ms-screen-vol${volShow ? " show" : ""}`}>
								{volMuted || volume === 0 ? (
									<VolumeX size={13} strokeWidth={2.4} />
								) : volume < 0.5 ? (
									<Volume1 size={13} strokeWidth={2.4} />
								) : (
									<Volume2 size={13} strokeWidth={2.4} />
								)}
								<span>{Math.round(shownVolume * 100)}%</span>
							</span>

							<AnimatePresence>
								{outOpen && (
									<OutputPanel
										key="out"
										outputs={outputs}
										onPick={pickOutput}
										onBack={() => setOutOpen(false)}
									/>
								)}
							</AnimatePresence>
						</div>
					</div>

					{/* The track plate: title and artist on a paper label, and the pilot lamp. */}
					<div className="ms-label">
						<div className="ms-label-text">
							<span className="ms-label-title" title={media.title}>
								{media.title || "Unknown title"}
							</span>
							<span
								className="ms-label-sub"
								title={[media.artist, media.album].filter(Boolean).join(" \u00b7 ")}
							>
								{media.artist || "Unknown artist"}
								{media.album && <span className="ms-label-album">{" \u00b7 "}{media.album}</span>}
							</span>
						</div>
						<span
							className={`ms-lamp${isPlaying ? " on" : ""}`}
							title={isPlaying ? "Playing" : "Paused"}
						/>
					</div>
				</div>

				{/* ---- The control panel ---- */}
				<div className="ms-controls">
					<div className="ms-knobs">
						<Knob kind="prev" label="PREV" cap="ink" onClick={onPrevious} title="Previous">
							<SkipBackIcon size={11} />
						</Knob>
						<Knob
							kind="play"
							label={isPlaying ? "PLAYING" : "PAUSED"}
							cap="accent"
							turn={isPlaying ? 42 : -42}
							ticks={2}
							sweep={84}
							onClick={onPlayPause}
							title={isPlaying ? "Pause" : "Play"}
						>
							{isPlaying ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
						</Knob>
						<Knob kind="next" label="NEXT" cap="ink" onClick={onNext} title="Next">
							<SkipForwardIcon size={11} />
						</Knob>
						<span className="ms-rule" aria-hidden />
						<VolumeKnob volume={shownVolume} onSet={applyVolume} onNudge={nudgeVolume} />
					</div>

					{/* A line of small print between the knobs and the track bar. */}
					<div className="ms-strip" aria-hidden>
						<span>BLOOM MS-01</span>
						<i />
						<span>
							CAL <b className="ms-strip-ok" />
						</span>
					</div>

					{/* The track position: a range bar with a printed scale, a diamond cursor on a
					    red line and a flag showing how far along it is. */}
					<div className="ms-fader">
						<div className="ms-fader-head">
							<span className="ms-fader-title">
								<span className="ms-legend">TRACK</span>
								<span className={`ms-state${isPlaying ? " on" : ""}`}>{isPlaying ? "PLAY" : "HOLD"}</span>
							</span>
							{durationMs > 0 && (
								<span className="ms-fader-time">
									<span className="ms-fader-now">{formatTime(displayPosition)}</span> / {formatTime(durationMs)}
								</span>
							)}
						</div>
						<div className="ms-seek" style={{ "--p": progress / 100 } as React.CSSProperties}>
							<div className="ms-seek-line">
								<span className="ms-seek-done" />
							</div>
							<div className="ms-seek-ticks" />
							<div className="ms-seek-head">
								<span className="ms-seek-flag">{Math.round(progress)}%</span>
								<i className="ms-seek-stem" />
								<i className="ms-seek-diamond" />
							</div>
							{seekEnabled && durationMs > 0 && (
								<input
									type="range"
									className="ms-seek-input"
									aria-label="Track position"
									min={0}
									max={durationMs}
									step={100}
									value={displayPosition}
									onMouseDown={handleSeekStart}
									onTouchStart={handleSeekStart}
									onChange={handleSeekChange}
									onMouseUp={handleSeekEnd}
									onTouchEnd={handleSeekEnd}
									onKeyDown={(e) => {
										if (SEEK_KEYS.has(e.key)) handleSeekStart();
									}}
									onKeyUp={(e) => {
										if (SEEK_KEYS.has(e.key)) handleSeekEnd();
									}}
									onClick={(e) => e.stopPropagation()}
								/>
							)}
						</div>
						<div className="ms-seek-nums" aria-hidden>
							{[0, 1, 2, 3, 4].map((q) => (
								<span key={q}>{durationMs > 0 ? formatTime((durationMs * q) / 4) : "-:--"}</span>
							))}
						</div>
					</div>

					<div className="ms-extras">
						<button className="ms-push" onClick={copyTrack} title="Copy track name">
							{copied ? <Check size={13} /> : <Copy size={13} />}
						</button>
						{sourceName && (
							<span className="ms-tag" title={media.source}>
								<i className="ms-tag-dot" />
								{sourceName}
							</span>
						)}
						{/* The picture slot: just the picture, no frame. */}
						{slotImage ? (
							<span className="ms-slot has-image">
								<img src={slotImage} alt="" draggable={false} />
								<span className="ms-slot-tools">
									<button className="ms-slot-btn" onClick={onPickSlot} title="Change picture">
										<RefreshCw size={10} />
									</button>
									<button className="ms-slot-btn" onClick={onClearSlot} title="Remove picture">
										<X size={11} />
									</button>
								</span>
							</span>
						) : (
							onPickSlot && (
								<button className="ms-slot ms-slot-empty" onClick={onPickSlot} title="Add a gif or image">
									<ImagePlus size={14} />
								</button>
							)
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
