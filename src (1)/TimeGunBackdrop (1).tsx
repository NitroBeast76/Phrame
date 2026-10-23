import { useEffect, useId, useRef } from "react";
import "./TimeGunBackdrop.css";

/* The scene behind the Time gun: a "disk and memory" backdrop in the spirit of the references. Pale floppy disks drift in a
   dark room, a red laser cuts across it, a crossing barrier and its two lights sit in the corners with a few road signs, and
   a row of X marks (memory cells) flickers along the top. It is one SVG (no filters, no images) drawn behind the gun, so it
   costs almost nothing. While the timer runs the crossing lights blink and a bright pulse travels down the laser. When the
   hammer lands on the cube (`hit` goes up by one) the scene gives a soft shake and the laser flashes. When the chamber is
   zoomed in on (`camera` is set) the scene follows the gun's camera, but only part of the way, so it sits further back. */

const CELLS = 14;
// Which memory cells are lit, and in which colour (r = red, a = accent).
const LIT: Record<number, "r" | "a"> = { 2: "r", 5: "a", 6: "r", 9: "a", 12: "r" };

// The shake when the hammer lands: a short, damped wobble that dies away, in pixels. The second step is smaller than the
// first, so it stays soft. To tune: SHAKE_STEPS is the wobble (x, y), SHAKE_MS how long it lasts.
const SHAKE_STEPS: [number, number][] = [
	[-2, 0.7],
	[1, -0.3]
];
const SHAKE_MS = 240;
const FLASH_MS = 260;

// How far the scene follows the gun's camera when the chamber is zoomed in on: 1 = as much as the gun, 0 = not at all.
const FOLLOW_MOVE = 0.4;
const FOLLOW_ZOOM = 0.45;

export type BackdropCamera = { x: number; y: number; scale: number };

export default function TimeGunBackdrop({
	running,
	hit,
	camera,
	origin
}: {
	running: boolean;
	hit: number;
	camera: BackdropCamera | null;
	origin: { left: number; top: number };
}) {
	const uid = useId().replace(/:/g, "");
	const svgRef = useRef<SVGSVGElement | null>(null);
	const flashRef = useRef<SVGPathElement | null>(null);
	// The hammer landed: shake the scene and flash the laser. Done with the Web Animations API so every hit restarts it
	// without remounting the drawing (which would snap the drifting disks back to where they began). The shake is on the
	// drawing itself and the camera follow is on the box around it, so the two never fight over one transform.
	useEffect(() => {
		if (!hit) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const at = (x: number, y: number) => ({ transform: `translate(${x}px, ${y}px)` });
		const kick = svgRef.current?.animate([at(0, 0), ...SHAKE_STEPS.map(([x, y]) => at(x, y)), at(0, 0)], {
			duration: SHAKE_MS,
			easing: "ease-out"
		});
		const flash = flashRef.current?.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: FLASH_MS, easing: "ease-out" });
		return () => {
			kick?.cancel();
			flash?.cancel();
		};
	}, [hit]);
	const follow = camera
		? `translate(${camera.x * FOLLOW_MOVE}px, ${camera.y * FOLLOW_MOVE}px) scale(${1 + (camera.scale - 1) * FOLLOW_ZOOM})`
		: "translate(0px, 0px) scale(1)";
	return (
		<div className="tgb-cam" style={{ transformOrigin: `${origin.left}px ${origin.top}px`, transform: follow }}>
		<svg
			ref={svgRef}
			className={`tgb${running ? " running" : ""}`}
			viewBox="0 0 360 180"
			preserveAspectRatio="xMidYMid slice"
			aria-hidden
			focusable="false"
		>
			<defs>
				{/* One floppy, drawn in a 100 x 100 box: notched corner, metal shutter with its window, label. */}
				<symbol id={`${uid}-disk`} viewBox="0 0 100 100" overflow="visible">
					<path d="M4 0H84L100 16V96a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z" />
					<path d="M24 0H76V30H24Z" />
					<path d="M58 5H69V25H58Z" />
					<path d="M14 54H86V100H14Z" />
					<path d="M26 66H74M26 76H74M26 86H58" />
				</symbol>
				<pattern id={`${uid}-dots`} width="12" height="12" patternUnits="userSpaceOnUse">
					<circle cx="6" cy="6" r="0.7" />
				</pattern>
				{/* The crossing lamps: a white-hot centre fading out to red, not a flat red disc. */}
				<radialGradient id={`${uid}-lamp`}>
					<stop offset="0" stopColor="#fff" />
					<stop offset="0.3" stopColor="#ffe9e6" />
					<stop offset="0.62" stopColor="#ff6a5f" />
					<stop offset="1" stopColor="#e02a20" />
				</radialGradient>
				<radialGradient id={`${uid}-halo`}>
					<stop offset="0" stopColor="#ff5a4f" stopOpacity="0.7" />
					<stop offset="1" stopColor="#ff3b30" stopOpacity="0" />
				</radialGradient>
				<radialGradient id={`${uid}-haze`} gradientUnits="userSpaceOnUse" cx="72" cy="32" r="270">
					<stop offset="0" stopColor="#fff" stopOpacity="0.16" />
					<stop offset="0.55" stopColor="#fff" stopOpacity="0.04" />
					<stop offset="1" stopColor="#fff" stopOpacity="0" />
				</radialGradient>
			</defs>

			{/* Both reach well past the edges, so nothing ends in view when the scene follows the camera. */}
			<rect x="-300" y="-200" width="960" height="580" fill={`url(#${uid}-haze)`} />
			<rect className="tgb-dots" x="-300" y="-200" width="960" height="580" fill={`url(#${uid}-dots)`} />

			{/* Floppy disks, big and faint at the back, small ones nearer the edges. */}
			<g transform="translate(168 -22) rotate(13)">
				<use className="tgb-disk tgb-disk-a" href={`#${uid}-disk`} width="140" height="140" />
			</g>
			<g transform="translate(6 104) rotate(-13)">
				<use className="tgb-disk tgb-disk-b" href={`#${uid}-disk`} width="52" height="52" />
			</g>
			<g transform="translate(300 112) rotate(9)">
				<use className="tgb-disk tgb-disk-c" href={`#${uid}-disk`} width="36" height="36" />
			</g>

			{/* Road signs piled against the fence, as faint outlines. */}
			<g className="tgb-signs">
				<path d="M62 30 76 54H48Z" transform="rotate(-8 62 42)" />
				<circle cx="108" cy="30" r="9" />
				<path d="M102 36 114 24" />
				<path d="M300 58 312 70 300 82 288 70Z" transform="rotate(6 300 70)" />
				<path d="M262 18 270 18 276 24 276 32 270 38 262 38 256 32 256 24Z" className="tgb-stop" />
				<text x="266" y="32" textAnchor="middle">停</text>
				<circle cx="24" cy="76" r="7" />
				<path d="M20 76H28" />
			</g>

			{/* The laser: a soft wide stroke under a thin hot one, and a pulse that runs along it while the timer is on. */}
			<g className="tgb-laser">
				<path d="M-260 -84 620 250" className="tgb-laser-glow" />
				<path d="M-260 -84 620 250" className="tgb-laser-mid" />
				<path d="M-260 -84 620 250" className="tgb-laser-core" />
				<path d="M-260 -84 620 250" className="tgb-laser-pulse" pathLength="100" />
				<path ref={flashRef} d="M-260 -84 620 250" className="tgb-laser-flash" />
			</g>

			{/* Crossing barrier in the top right corner, with a light on each side. */}
			<g className="tgb-gate">
				<path d="M344 26 226 -8" className="tgb-gate-red" />
				<path d="M344 26 226 -8" className="tgb-gate-white" />
				<circle cx="344" cy="26" r="3" />
			</g>
			<g className="tgb-lights">
				<circle className="tgb-halo tgb-l1" cx="20" cy="20" r="10" fill={`url(#${uid}-halo)`} />
				<circle className="tgb-lamp tgb-l1" cx="20" cy="20" r="3.4" fill={`url(#${uid}-lamp)`} />
				<circle className="tgb-halo tgb-l2" cx="338" cy="44" r="10" fill={`url(#${uid}-halo)`} />
				<circle className="tgb-lamp tgb-l2" cx="338" cy="44" r="3.4" fill={`url(#${uid}-lamp)`} />
			</g>

			{/* Memory cells drawn as X marks, a few lit. */}
			<g className="tgb-cells">
				{Array.from({ length: CELLS }, (_, i) => {
					const x = 96 + i * 8;
					return <path key={i} className={LIT[i] ? `lit-${LIT[i]}` : undefined} d={`M${x} 7l5 5M${x + 5} 7l-5 5`} />;
				})}
			</g>
		</svg>
		</div>
	);
}
