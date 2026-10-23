import { useEffect, useId, useRef } from "react";
import { animate as animateValue, motion, useMotionValue, useReducedMotion } from "framer-motion";
import { Floppy } from "./Floppy";
import "./DashDisk.css";

// The now-playing disk, redrawn from the reference picture: a clear plastic 3.5" floppy with the
// round disc showing through it, the pale shutter with its slot, the lighter wedge on the right,
// the label line at the bottom and the little holes in the case. The orange hub in the middle is
// replaced by the album cover as a small circle. Without a cover the orange hub from the picture is
// shown. Flat colours were sampled from the picture; the case is see-through, so it takes the
// card's background. The warm colours follow the theme accent (pywal) through DashDisk.css. It turns the same way the Media tab disk does (see MediaTab.tsx): a ticking turn while the music plays, a spin-up when it starts and a springy spin back when it pauses.
const CX = 50;
const CY = 50;
// ---- Turning. Copied from the disk on the Media tab, so both turn the same way. ----
// One turn in 30 seconds, in 600 steps of 0.6 degrees (a slow, ticking turn).
const DISK_TURN_SECONDS = 30;
const DISK_STEPS = 600;
const diskStep = (t: number) => Math.floor(t * DISK_STEPS) / DISK_STEPS;
// The angle it rests at (degrees): a slight lean to the left, like the reference picture.
const DISK_REST_DEG = -3;
// Where the disk was when the card last went away. The dashboard card is removed when you change
// tab, so without this the disk would start over at rest every time you come back.
let savedDiskAngle = DISK_REST_DEG;
// Spin back when the music pauses: a spring, so it overshoots the rest angle and settles.
const DISK_SPIN_BACK = { type: "spring" as const, stiffness: 150, damping: 13 };
// Spin up when the music starts: eases in from standing, builds to a fast spin, holds it a moment,
// then slows to the normal speed.
const DISK_SPINUP_SECONDS = 3.8;
const DISK_SPINUP_PEAK_DEG_PER_SEC = 1800;
const DISK_STEADY_DEG_PER_SEC = 360 / DISK_TURN_SECONDS;
const SPINUP_RISE_END = 0.3;
const SPINUP_HOLD_END = 0.3;
const sstep = (x: number) => {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
};
const diskSpinUpSpeed = (s: number) => {
	const rising =
		DISK_STEADY_DEG_PER_SEC * sstep(s) + DISK_SPINUP_PEAK_DEG_PER_SEC * sstep(s / SPINUP_RISE_END);
	if (s < SPINUP_HOLD_END) return rising;
	const peak = DISK_STEADY_DEG_PER_SEC * sstep(SPINUP_HOLD_END) + DISK_SPINUP_PEAK_DEG_PER_SEC;
	const u = sstep((s - SPINUP_HOLD_END) / (1 - SPINUP_HOLD_END));
	return DISK_STEADY_DEG_PER_SEC * Math.pow(peak / DISK_STEADY_DEG_PER_SEC, 1 - u);
};
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
const diskSpinUpEase = (s: number) => {
	if (s >= 1) return 1;
	const x = Math.max(0, s) * SPINUP_TABLE_STEPS;
	const i = Math.floor(x);
	const angle = DISK_SPINUP_ANGLES[i] + (DISK_SPINUP_ANGLES[i + 1] - DISK_SPINUP_ANGLES[i]) * (x - i);
	const step = 360 / DISK_STEPS;
	return (Math.floor(angle / step) * step) / DISK_SPINUP_TOTAL_DEG;
};

const COVER_R = 12; // radius of the round cover; change to make it bigger or smaller

// variant 1 is the clear black disk (DashDiskArt, below); variant 2 is the yellow floppy from the
// Media tab (Floppy.tsx). Both are drawn to fill the same box, so they come out the same size, and
// both turn, rest and spin back the same way. The yellow one has no cover, as on the Media tab.
export function DashDisk({
	art,
	playing = false,
	variant = 1
}: {
	art?: string | null;
	playing?: boolean;
	variant?: 1 | 2;
}) {
	const reduceMotion = useReducedMotion();
	const angle = useMotionValue(savedDiskAngle);
	// Only a start while the card is showing gets the spin-up; coming back to music that is already
	// playing just carries on at the normal speed. Started from an effect (not an animate prop) so
	// it also runs when the card mounts while the music is playing.
	const wasPlayingRef = useRef(playing);
	useEffect(() => {
		const starting = playing && !wasPlayingRef.current;
		wasPlayingRef.current = playing;
		if (playing && !reduceMotion) {
			let ramp: ReturnType<typeof animateValue> | null = null;
			let turning: ReturnType<typeof animateValue> | null = null;
			const steady = () => {
				// Carry on from the current angle (wrapped into one turn, so it looks the same): no jump.
				const from = DISK_REST_DEG + ((((angle.get() - DISK_REST_DEG) % 360) + 360) % 360);
				angle.set(from);
				turning = animateValue(angle, from + 360, {
					duration: DISK_TURN_SECONDS,
					ease: diskStep,
					repeat: Infinity
				});
			};
			if (starting) {
				const from = angle.get();
				ramp = animateValue(angle, from + DISK_SPINUP_TOTAL_DEG, {
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
		const back = animateValue(angle, DISK_REST_DEG, DISK_SPIN_BACK);
		return () => back.stop();
	}, [playing, reduceMotion, angle]);
	// Remember the angle when the card goes away.
	useEffect(
		() => () => {
			savedDiskAngle = angle.get();
		},
		[angle]
	);
	return (
		<motion.span className="dash-disk" aria-hidden style={{ rotate: angle }}>
			{variant === 2 ? <Floppy /> : <DashDiskArt art={art} />}
		</motion.span>
	);
}

// The clear black disk by itself, without any turning. Used on the card (variant 1) and on the Media
// tab (variant 1 there, inside .mt-disk). It fills whatever box it is put in.
// Whether the black disk shows the album cover as a small circle in the middle. Off: it shows the
// orange hub from the reference picture instead, with no cover. Set to true to bring the cover back.
const SHOW_COVER = false;

export function DashDiskArt({ art: coverArt }: { art?: string | null }) {
	const art = SHOW_COVER ? coverArt : null;
	const uid = useId().replace(/:/g, "");
	const id = (n: string) => `dd-${n}-${uid}`;
	return (
		<span className="dash-disk-art" aria-hidden>
			<svg viewBox="0 0 100 100" overflow="visible">
				<defs>
					<clipPath id={id("disc")}>
						<circle cx="50" cy="50" r="45.4" />
					</clipPath>
					<clipPath id={id("art")}>
						<circle cx={CX} cy={CY} r={COVER_R} />
					</clipPath>
					<linearGradient id={id("case")} x1="0" y1="0" x2="1" y2="1">
						<stop offset="0" stopColor="#fff" stopOpacity="0.11" />
						<stop offset="1" stopColor="#fff" stopOpacity="0.17" />
					</linearGradient>
					<radialGradient id={id("shade")} gradientUnits="userSpaceOnUse" cx="50" cy="50" r="72">
						<stop offset="0.62" stopColor="#000" stopOpacity="0" />
						<stop offset="1" stopColor="#000" stopOpacity="0.32" />
					</radialGradient>
				</defs>
				{/* clear plastic case, top-left corner clipped like the picture */}
				<path
					id={id("shell")}
					d="M10 1.5 H93.5 Q99 1.5 99 7 V93 Q99 99 93.5 99 H6.5 Q1 99 1 93.5 V10Z"
					fill={`url(#${id("case")})`}
				/>
				<path
					d="M10 1.5 H93.5 Q99 1.5 99 7 V93 Q99 99 93.5 99 H6.5 Q1 99 1 93.5 V10Z"
					fill={`url(#${id("shade")})`}
				/>
				<path
					d="M10 1.5 H93.5 Q99 1.5 99 7 V93 Q99 99 93.5 99 H6.5 Q1 99 1 93.5 V10Z"
					fill="none"
					stroke="#a89d95"
					strokeOpacity="0.8"
					strokeWidth="1"
					strokeLinejoin="round"
				/>
				<path
					d="M10.6 4 H92.5 Q96.5 4 96.5 8 V92.5 Q96.5 96.5 92.5 96.5 H7.5 Q3.5 96.5 3.5 92.5 V11Z"
					fill="none"
					stroke="#a89d95"
					strokeOpacity="0.4"
					strokeWidth="0.5"
				/>

				{/* the disc, with the lighter wedge, its edge line and the label line */}
				<circle className="dd-disc" cx="50" cy="50" r="45.4" fill="#bf8e6e" />
				<g clipPath={`url(#${id("disc")})`}>
					<path className="dd-wedge" d="M50 50 L140 5 L140 94Z" fill="#d7bdae" />
					<path className="dd-wedge-line" d="M50 50 L140 5" stroke="#dcae92" strokeWidth="1" fill="none" />
					<path className="dd-strip" d="M0 84.3 L100 81.4 L100 100 L0 100Z" fill="#b98d6e" />
					<path className="dd-line" d="M22 84.2 L81.5 82.3" stroke="#8c4a2a" strokeWidth="0.9" fill="none" />
				</g>

				{/* shutter with its slot */}
				<path className="dd-shutter" d="M22.1 3.3 H71.8 V33.9 H22.1Z" fill="#ebe5dd" />
				<path className="dd-line" d="M22.6 33.6 H84.6" stroke="#8c4a2a" strokeWidth="0.9" fill="none" />
				<rect className="dd-block" x="72.2" y="17.5" width="12.2" height="15.8" fill="#b58d72" stroke="#8c4a2a" strokeWidth="0.8" />
				<path
					className="dd-slot"
					d="M29.8 33 V9.4 Q29.8 8.4 30.9 8.1 L33.2 7.2 H40.3 L42.5 8.1 Q43.5 8.5 43.5 9.6 V33Z"
					fill="#bc8f6f"
					stroke="#8c4a2a"
					strokeWidth="0.9"
					strokeLinejoin="round"
				/>
				<ellipse cx="57.2" cy="5.6" rx="2.1" ry="0.9" fill="#b9b3ad" />

				{/* holes and notches in the case */}
				<circle cx="5.2" cy="21.5" r="1.9" fill="none" stroke="#a89d95" strokeOpacity="0.7" strokeWidth="0.7" />
				<circle cx="90.5" cy="14" r="1.6" fill="none" stroke="#a89d95" strokeOpacity="0.7" strokeWidth="0.6" />
				<rect x="7.5" y="88" width="5" height="5" fill="none" stroke="#a89d95" strokeOpacity="0.7" strokeWidth="0.7" rx="0.6" />
				<rect x="93.6" y="85" width="3.4" height="3.8" fill="#14100d" rx="0.4" />
				<rect x="93.6" y="90" width="3.4" height="3.4" fill="none" stroke="#a89d95" strokeOpacity="0.7" strokeWidth="0.6" rx="0.4" />

				{/* middle: the album cover as a small circle, or the orange hub from the picture */}
				{art ? (
					<g>
						<circle className="dd-hub-edge" cx={CX} cy={CY} r={COVER_R + 1.3} fill="#8c3b1c" />
						<image
							href={art}
							x={CX - COVER_R}
							y={CY - COVER_R}
							width={COVER_R * 2}
							height={COVER_R * 2}
							preserveAspectRatio="xMidYMid slice"
							clipPath={`url(#${id("art")})`}
						/>
					</g>
				) : (
					<g>
						<circle className="dd-hub" cx={CX} cy={CY} r="13.4" fill="#f6844e" />
						<circle className="dd-hub-ring" cx={CX} cy={CY} r="13.4" fill="none" stroke="#8c3b1c" strokeWidth="1.2" />
						{/* The two little marks, placed as in the picture: the small dark square is dead centre in the hub
						    (the spindle, where the disk turns) and an outlined light rectangle sits down-right of it, both leaning the same way. */}
						<rect
							className="dd-mark-dark"
							x={CX - 1.85}
							y={CY - 1.85}
							width="3.7"
							height="3.7"
							fill="#822b0d"
							transform={`rotate(40 ${CX} ${CY})`}
						/>
						<rect
							className="dd-mark-light"
							x={CX + 5.3 - 1.9}
							y={CY + 5.4 - 3.5}
							width="3.8"
							height="7"
							rx="0.7"
							fill="#f39a6e"
							stroke="#8c3b1c"
							strokeWidth="0.9"
							transform={`rotate(40 ${CX + 5.3} ${CY + 5.4})`}
						/>
					</g>
				)}
			</svg>
		</span>
	);
}
