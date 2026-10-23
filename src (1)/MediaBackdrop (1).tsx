/**
 * Backdrop artwork for the Media tab.
 *
 * Replaces the old poster-X drawing with a technical-schematic layer in the
 * spirit of the reference sheets: a survey grid, a scatter of node clusters,
 * leader lines running out to small bracketed tags, bead chains along a couple
 * of traced curves, and one large soft boundary ring.
 *
 * Everything is plain SVG driven by CSS custom properties, so the whole thing
 * recolors with the wallpaper (`--viz-*`, set by theme.ts for the retro theme,
 * with sane fallbacks for the others). It is purely decorative: the layer sits
 * behind the content, ignores the pointer, and is hidden from assistive tech.
 */

import "./MediaBackdropArt.css";

// Node clusters. `x`/`y` are in the 0..1000 / 0..300 viewBox. `r` is the node
// radius, `tag` the bracketed label its leader line runs out to, `side` which
// way the leader exits. Kept to a handful so the panel never looks busy.
interface VizNode {
	x: number;
	y: number;
	r: number;
	tag: string;
	code: string;
	meta: string;
	side: "left" | "right";
	ring?: boolean;
}

const NODES: VizNode[] = [
	{ x: 150, y: 74, r: 7, tag: "A-42", code: "NODE 07", meta: "DENS 0.73 / SIG 4F", side: "right", ring: true },
	{ x: 96, y: 196, r: 5, tag: "A-48", code: "NODE 12", meta: "DENS 0.41 / SIG 1C", side: "right" },
	{ x: 858, y: 92, r: 6.5, tag: "B-56", code: "NODE 03", meta: "DENS 0.88 / SIG A2", side: "left", ring: true },
	{ x: 902, y: 214, r: 4.5, tag: "B-60", code: "NODE 19", meta: "DENS 0.35 / SIG 07", side: "left" },
	{ x: 250, y: 246, r: 4, tag: "C-11", code: "NODE 24", meta: "DENS 0.52 / SIG 6E", side: "right" },
	{ x: 742, y: 252, r: 5.5, tag: "C-18", code: "NODE 31", meta: "DENS 0.64 / SIG D9", side: "left" }
];

// Ghost outlines: nodes that were there before, drawn faintly behind the live
// ones. Purely for depth, so they carry no label.
const GHOSTS: { x: number; y: number; r: number }[] = [
	{ x: 208, y: 132, r: 9 },
	{ x: 62, y: 118, r: 4 },
	{ x: 806, y: 168, r: 8 },
	{ x: 940, y: 130, r: 4 },
	{ x: 300, y: 196, r: 5 },
	{ x: 690, y: 116, r: 5 }
];

// How visible the bracketed tag cards ([A-42] NODE 07, ...) are, from 0 (gone) to 1 (as before).
// It multiplies whatever the stylesheet already sets, so the leader lines and dots are unchanged.
const TAG_OPACITY = 0.35;

// Colour of the small lines under the tag name. It comes from the pywal palette (theme.ts sets
// --retro-ink, a dark shade of the wallpaper's text colour, and --retro-accent-deep, the wallpaper's
// accent darkened), so it follows the wallpaper but stays dark enough to read on the pale card.
// The main tag name keeps the colour from the stylesheet. The second colour in each var() is only
// used when the theme does not set the variable.
const TAG_SUB_COLOR = "color-mix(in srgb, var(--retro-ink, #2b2b2b) 55%, var(--retro-accent-deep, #4f9aa6))";

// ---- Map layer, after the reference: pale city blocks, a river, thin streets. ----
// The blocks sit on the 50-unit survey grid. They are picked once, with a tiny seeded
// generator, so they are the same on every render and every launch.
function seeded(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface MapBlock {
	x: number;
	y: number;
	w: number;
	h: number;
	tone: 0 | 1 | 2;
}

const MAP_BLOCKS: MapBlock[] = (() => {
	const rnd = seeded(24);
	const blocks: MapBlock[] = [];
	for (let gy = 0; gy < 6; gy++) {
		for (let gx = 0; gx < 20; gx++) {
			if (rnd() > 0.26) continue;
			const w = rnd() > 0.65 ? 100 : 50;
			const h = rnd() > 0.8 ? 100 : 50;
			blocks.push({ x: gx * 50, y: gy * 50, w, h, tone: Math.floor(rnd() * 3) as 0 | 1 | 2 });
		}
	}
	return blocks;
})();

// Thin street lines running across the blocks.
const STREETS = [
	"M0 120 L180 96 L340 44 L420 0",
	"M420 300 L520 244 L612 262 L700 300",
	"M880 0 L934 66 L1000 88",
	"M236 0 L262 62 L330 92 L402 84",
	"M0 262 L96 236 L214 252 L296 300",
	"M740 176 L818 210 L900 196 L1000 232"
];

// The river: one wide soft stroke with a lighter core.
const RIVER = "M-20 236 C 120 210, 190 150, 330 160 S 520 232, 640 172 S 840 70, 1020 96";

// ---- Bubbles: soft accent discs of different sizes (the red discs in the reference) and
// hollow glass lenses with a dashed inner ring and four ticks (the white target circles). ----
const BUBBLES: { x: number; y: number; r: number; o: number }[] = [
	{ x: 212, y: 176, r: 26, o: 0.2 },
	{ x: 478, y: 86, r: 34, o: 0.15 },
	{ x: 780, y: 62, r: 22, o: 0.18 },
	{ x: 618, y: 238, r: 40, o: 0.14 },
	{ x: 930, y: 162, r: 30, o: 0.18 },
	{ x: 122, y: 252, r: 18, o: 0.18 },
	{ x: 356, y: 38, r: 16, o: 0.16 },
	{ x: 566, y: 22, r: 8, o: 0.22 },
	{ x: 300, y: 150, r: 7, o: 0.22 },
	{ x: 690, y: 126, r: 6, o: 0.24 },
	{ x: 860, y: 250, r: 9, o: 0.2 },
	{ x: 52, y: 160, r: 5, o: 0.24 },
	{ x: 410, y: 232, r: 5.5, o: 0.22 },
	{ x: 958, y: 66, r: 6, o: 0.22 },
	{ x: 746, y: 214, r: 4, o: 0.26 },
	{ x: 188, y: 28, r: 5, o: 0.22 },
	{ x: 520, y: 270, r: 6.5, o: 0.2 },
	{ x: 820, y: 130, r: 4.5, o: 0.24 }
];

const LENSES: { x: number; y: number; r: number }[] = [
	{ x: 330, y: 106, r: 18 },
	{ x: 396, y: 74, r: 12 },
	{ x: 690, y: 196, r: 16 },
	{ x: 836, y: 146, r: 12 },
	{ x: 470, y: 262, r: 10 },
	{ x: 640, y: 46, r: 10 },
	{ x: 962, y: 36, r: 12 },
	{ x: 36, y: 232, r: 9 },
	{ x: 566, y: 196, r: 8 }
];

// Small console text, like the log column down the left of the reference.
const TERMINAL = [
	"> link 24.7 ok",
	"> sync node_07 .. done",
	"> scan sector a-4 [12%]",
	"> sig 4F2C / hold",
	"> idle",
];

// ---- Merged shapes ----
// The layers above are drawn as a few paths instead of one element per shape (roughly 140 SVG
// elements became 14). The browser repaints this SVG whenever the notch changes size, and that
// cost grows with the number of elements, so fewer elements means a smoother open. The strings are
// built once when the file loads. The stylesheet classes are unchanged, so the colours, opacities
// and the detail switch behave exactly as before.
const n2 = (v: number) => Math.round(v * 100) / 100;
const circlePath = (cx: number, cy: number, r: number) =>
	`M${n2(cx - r)} ${n2(cy)}a${n2(r)} ${n2(r)} 0 1 0 ${n2(r * 2)} 0a${n2(r)} ${n2(r)} 0 1 0 ${n2(-r * 2)} 0Z`;

const BLOCKS_D = [0, 1, 2].map((tone) =>
	MAP_BLOCKS.filter((b) => b.tone === tone)
		.map((b) => `M${b.x} ${b.y}h${b.w}v${b.h}h${-b.w}Z`)
		.join("")
);
const STREETS_D = STREETS.join(" ");
const GLASS_D = "M64 16 H292 V92 L310 110 V198 H64 Z M700 122 H926 V204 L944 222 V300 H700 Z";
const BUBBLES_D = BUBBLES.map((b) => circlePath(b.x, b.y, b.r)).join("");
const BUBBLES_HI_D = BUBBLES.filter((b) => b.r > 14)
	.map((b) => circlePath(b.x - b.r * 0.3, b.y - b.r * 0.32, b.r * 0.22))
	.join("");
const LENS_D = LENSES.map((l) => circlePath(l.x, l.y, l.r)).join("");
const LENS_IN_D = LENSES.map((l) => circlePath(l.x, l.y, l.r * 0.58)).join("");
const LENS_DOT_D = LENSES.map((l) => circlePath(l.x, l.y, 1.3)).join("");
const LENS_TICK_D = LENSES.map(
	(l) =>
		`M${l.x} ${l.y - l.r - 3}V${l.y - l.r + 2}M${l.x} ${l.y + l.r - 2}V${l.y + l.r + 3}M${l.x - l.r - 3} ${l.y}H${l.x - l.r + 2}M${l.x + l.r - 2} ${l.y}H${l.x + l.r + 3}`
).join("");

export interface MediaBackdropProps {
	/** Highlight colour for the trace curves, so the art can echo the accent. */
	className?: string;
}

/**
 * The bead chains are baked rather than computed: `getPointAtLength` would need
 * a ref and a layout pass for a purely decorative layer, and a hand-placed set
 * of dots follows the curve closely enough at this size.
 */
const BEADS_TRACE_A: [number, number][] = [
	[318, 214], [356, 200], [396, 190], [438, 186], [480, 188], [520, 196]
];
const BEADS_TRACE_B: [number, number][] = [
	[612, 108], [654, 112], [694, 122], [730, 136], [762, 154]
];

export function MediaBackdrop({ className }: MediaBackdropProps) {
	return (
		<svg
			className={`mt-bgart${className ? ` ${className}` : ""}`}
			viewBox="0 0 1000 300"
			preserveAspectRatio="xMidYMid slice"
			aria-hidden
			focusable="false"
		>
			<defs>
				{/* The survey grid, drawn as a pattern so it stays crisp at any width. */}
				<pattern id="mt-grid" width="50" height="50" patternUnits="userSpaceOnUse">
					<path className="mt-bg-grid-line" d="M50 0 L0 0 0 50" fill="none" />
				</pattern>
				<pattern id="mt-grid-fine" width="10" height="10" patternUnits="userSpaceOnUse">
					<path className="mt-bg-grid-fine-line" d="M10 0 L0 0 0 10" fill="none" />
				</pattern>
			</defs>

			{/* Survey grid. */}
			<rect className="mt-bg-grid" x="0" y="0" width="1000" height="300" fill="url(#mt-grid-fine)" />
			<rect className="mt-bg-grid" x="0" y="0" width="1000" height="300" fill="url(#mt-grid)" />

			{/* Map layer: city blocks, a river and thin streets, kept faint so it only adds depth. */}
			<g className="mt-bg-map">
				{BLOCKS_D.map((d, tone) => (
					<path key={tone} className={`mt-bg-block tone-${tone}`} d={d} />
				))}
				<path className="mt-bg-river" d={RIVER} fill="none" />
				<path className="mt-bg-river-core" d={RIVER} fill="none" />
				<path className="mt-bg-street" d={STREETS_D} fill="none" />
			</g>

			{/* Two glass panels with a cut corner, like the frosted sheets in the second reference. */}
			<g className="mt-bg-glass">
				<path d={GLASS_D} />
			</g>

			{/* The big soft boundary ring, off to one side so it reads as a field. */}
			<circle className="mt-bg-ring" cx="500" cy="150" r="132" />

			{/* Traced curves sweeping across the field, with bead chains along them. */}
			<path
				className="mt-bg-trace trace-a"
				d="M286 232 C 360 196, 452 178, 530 190"
				fill="none"
			/>
			<path
				className="mt-bg-trace trace-b"
				d="M596 96 C 660 104, 718 132, 776 166"
				fill="none"
			/>
			<path
				className="mt-bg-trace trace-c"
				d="M330 118 C 392 138, 440 168, 470 206"
				fill="none"
			/>

			<g className="mt-bg-beads">
				{BEADS_TRACE_A.map(([x, y], i) => (
					<circle key={`a${i}`} cx={x} cy={y} r={2.4} />
				))}
			</g>
			<g className="mt-bg-beads beads-b">
				{BEADS_TRACE_B.map(([x, y], i) => (
					<circle key={`b${i}`} cx={x} cy={y} r={2.4} />
				))}
			</g>

			{/* Ghost outlines behind the live nodes. */}
			<g className="mt-bg-ghosts">
				{GHOSTS.map((g, i) => (
					<circle key={i} cx={g.x} cy={g.y} r={g.r} />
				))}
			</g>

			{/* Bubbles and glass lenses, scattered over the field. */}
			<g className="mt-bg-bubbles">
				<path className="mt-bg-bubble" d={BUBBLES_D} />
				<path className="mt-bg-bubble-hi" d={BUBBLES_HI_D} />
			</g>
			<g className="mt-bg-lenses">
				<path className="mt-bg-lens" d={LENS_D} />
				<path className="mt-bg-lens-in" d={LENS_IN_D} />
				<path className="mt-bg-lens-tick" d={LENS_TICK_D} />
				<path className="mt-bg-lens-dot" d={LENS_DOT_D} />
			</g>

			{/* Live nodes, each with a halo, a leader line and a bracketed tag. */}
			{NODES.map((n) => {
				const len = n.side === "right" ? 46 : -46;
				// The leader runs out from the node, then a short elbow to the tag.
				const elbowX = n.x + len;
				const elbowY = n.y + (n.y > 150 ? -18 : 18);
				const tagX = elbowX + (n.side === "right" ? 6 : -6);
				return (
					<g key={n.tag} className={`mt-bg-node node-${n.tag.toLowerCase()}`}>
						{n.ring && <circle className="mt-bg-halo" cx={n.x} cy={n.y} r={n.r + 9} />}
						<circle className="mt-bg-node-dot" cx={n.x} cy={n.y} r={n.r} />
						<polyline
							className="mt-bg-leader"
							points={`${n.x} ${n.y}, ${elbowX} ${n.y}, ${elbowX} ${elbowY}, ${tagX} ${elbowY}`}
							fill="none"
						/>
						<g className="mt-bg-tag" style={{ opacity: TAG_OPACITY }}>
						<rect
							className="mt-bg-tag-box"
							x={n.side === "right" ? tagX : tagX - 62}
							y={elbowY - 10}
							width="62"
							height="28"
							rx="3"
						/>
						<text
							className="mt-bg-tag-text"
							x={n.side === "right" ? tagX + 31 : tagX - 31}
							y={elbowY - 2.5}
							textAnchor="middle"
						>
							[{n.tag}]
						</text>
						<text
							className="mt-bg-tag-sub"
							style={{ fill: TAG_SUB_COLOR }}
							x={n.side === "right" ? tagX + 31 : tagX - 31}
							y={elbowY + 6}
							textAnchor="middle"
						>
							{n.code}
						</text>
						<text
							className="mt-bg-tag-meta"
							style={{ fill: TAG_SUB_COLOR }}
							x={n.side === "right" ? tagX + 31 : tagX - 31}
							y={elbowY + 13.5}
							textAnchor="middle"
						>
							{n.meta}
						</text>
						</g>
					</g>
				);
			})}

			{/* Corner read-outs, like the annotation column on the reference sheets. */}
			<g className="mt-bg-readout">
				<line x1="18" y1="46" x2="18" y2="126" />
				<line x1="14" y1="46" x2="22" y2="46" />
				<line x1="14" y1="86" x2="22" y2="86" />
				<line x1="14" y1="126" x2="22" y2="126" />
				<text x="28" y="50">[GRAPH 1-PORT]</text>
				<text x="28" y="90">SCALE 1:24</text>
				<text x="28" y="130">REV 03 / AUTO</text>
			</g>

			{/* Console lines under the read-outs, like the log column in the reference. */}
			<g className="mt-bg-term">
				<text>
					{TERMINAL.map((line, i) => (
						<tspan key={i} x="28" y={152 + i * 7.5}>
							{line}
						</tspan>
					))}
				</text>
			</g>

			{/* A small tick strip along the bottom edge. */}
			<g className="mt-bg-ticks">
				{Array.from({ length: 21 }, (_, i) => {
					const x = 60 + i * 44;
					return <line key={i} x1={x} y1={278} x2={x} y2={i % 5 === 0 ? 266 : 272} />;
				})}
			</g>
		</svg>
	);
}
