import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";

// Convert a hex color string to rgba with a specified alpha
function hexToRgba(hex: string, alpha: number): string {
	hex = hex.replace("#", "");
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((char) => char + char)
			.join("");
	}
	const r = parseInt(hex.substring(0, 2), 16) || 0;
	const g = parseInt(hex.substring(2, 4), 16) || 0;
	const b = parseInt(hex.substring(4, 6), 16) || 0;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface HSL {
	h: number;
	s: number;
	l: number;
}

// Convert Hex to HSL
export function hexToHsl(hex: string): HSL {
	hex = hex.replace("#", "");
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((char) => char + char)
			.join("");
	}
	const r = (parseInt(hex.substring(0, 2), 16) || 0) / 255;
	const g = (parseInt(hex.substring(2, 4), 16) || 0) / 255;
	const b = (parseInt(hex.substring(4, 6), 16) || 0) / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;

	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = (g - b) / d + (g < b ? 6 : 0);
				break;
			case g:
				h = (b - r) / d + 2;
				break;
			case b:
				h = (r - g) / d + 4;
				break;
		}
		h /= 6;
	}

	return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Convert HSL back to Hex color string
function hslToHex(h: number, s: number, l: number): string {
	s /= 100;
	l /= 100;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0,
		g = 0,
		b = 0;

	if (0 <= h && h < 60) {
		r = c;
		g = x;
		b = 0;
	} else if (60 <= h && h < 120) {
		r = x;
		g = c;
		b = 0;
	} else if (120 <= h && h < 180) {
		r = 0;
		g = c;
		b = x;
	} else if (180 <= h && h < 240) {
		r = 0;
		g = x;
		b = c;
	} else if (240 <= h && h < 300) {
		r = x;
		g = 0;
		b = c;
	} else if (300 <= h && h < 360) {
		r = c;
		g = 0;
		b = x;
	}

	const toHex = (val: number) => {
		const hexVal = Math.round((val + m) * 255).toString(16);
		return hexVal.length === 1 ? "0" + hexVal : hexVal;
	};

	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Parse the CSS custom properties out of the pywal palette file (colors.css)
function parsePywalPalette(css: string): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const m of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
		vars[m[1]] = m[2].trim();
	}
	return vars;
}

const HEX6 = /^#[0-9a-f]{6}$/i;

// While a wallpaper is previewed, the palette it would give (sent by the backend as "pywal-preview").
// It replaces the saved palette for painting only; nothing is written to disk or localStorage.
let previewPalette: Record<string, string> | null = null;

// Returns the pywal palette, or null if the file is missing / unusable
async function loadPywalPalette(): Promise<Record<string, string> | null> {
	if (previewPalette) return previewPalette;
	try {
		const vars = parsePywalPalette(await invoke<string>("get_pywal_palette"));
		if (HEX6.test(vars["base"] ?? "") && HEX6.test(vars["text"] ?? "")) return vars;
	} catch {
		// no pywal palette available, caller falls back to the system accent
	}
	return null;
}

// ── Retro theme ──
// Pywal palettes are dark and muted, but the retro skin wants paper-and-ink.
// Rather than using the raw colors, the palette is remapped into those two
// roles: the wallpaper's hue drives everything, its lightness is discarded.
// The result recolors with the wallpaper while staying light and high-contrast.

const HEX3 = /^#[0-9a-f]{3}$/i;

// Widen #abc to #aabbcc so hexToHsl can read it.
function normalizeHex(hex: string): string {
	const h = hex.trim();
	if (HEX3.test(h)) {
		const [r, g, b] = h.slice(1).split("");
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return h;
}

// Repaint a palette color at a fixed lightness, keeping its hue and saturation.
// This is what turns a near-black base into cream paper and a grey text color
// into dark ink — same family as the wallpaper, readable as a light theme.
function atLightness(hex: string, l: number, satScale = 1, satFloor = 0): string {
	const hsl = hexToHsl(normalizeHex(hex));
	// A near-grey wallpaper (pywal's base is often ~10% saturation) would otherwise
	// produce dead grey paper. The floor keeps a visible tint from the hue.
	const s = Math.min(100, Math.max(hsl.s * satScale, satFloor));
	return hslToHex(hsl.h, s, Math.max(0, Math.min(100, l)));
}

// Paper, ink and the accent, derived from a pywal variable map.
interface RetroRoles {
	paper: string;
	paperDeep: string;
	ink: string;
	/** Ink mixed toward the paper for secondary text. Kept dark enough to stay
	 *  readable -- an opacity fade on ink measures under 3:1 on this paper. */
	inkMuted: string;
	accent: string;
	accentDeep: string;
	/** Signal hues for the media-tab backdrop: red for nodes and tags, teal for
	 *  leader lines and grid, yellow and green for the trace curves. Drawn
	 *  straight from the palette so the artwork recolors with the wallpaper. */
	vizRed: string;
	vizTeal: string;
	vizYellow: string;
	vizGreen: string;
	/** Oscilloscope face: the enamel case, the screen well, the phosphor trace
	 *  and the jewel lamp. Only the case follows the wallpaper. */
	scopeCase: string;
	scopeCaseDeep: string;
	scopeScreen: string;
	scopePhos: string;
	scopeLamp: string;
}

// Picks the accent source: the most saturated color in the palette. Named keys
// are unreliable -- in most schemes `blue` and `teal` are aliases, and a warm
// wallpaper puts every one of them in the same orange/amber family.
function pickAccentSource(pywal: Record<string, string>, fallback: string): string {
	const preferred = [
		"teal",
		"sky",
		"sapphire",
		"blue",
		"mauve",
		"peach",
		"green",
		"pink",
		"rosewater",
		"lavender",
		"yellow",
		"flamingo",
		"red",
		"maroon"
	];
	let best: string | null = null;
	let bestSat = -1;
	for (const key of preferred) {
		const value = pywal[key];
		if (!value || !HEX6.test(normalizeHex(value))) continue;
		const sat = hexToHsl(normalizeHex(value)).s;
		if (sat > bestSat) {
			bestSat = sat;
			best = value;
		}
	}
	return best ?? fallback;
}

// The backdrop wants a few distinguishable signal colours. Named palette keys are
// not a reliable way to get them: in many schemes `red`, `blue` and `teal` are the
// same hue (they are aliases in the Catppuccin-derived file this app reads), and a
// monochrome wallpaper makes every key identical. So instead of trusting names,
// every real colour in the palette is considered and the most saturated one
// nearest each target hue is taken. That guarantees the sheet has contrast on any
// palette -- a warm wallpaper yields warm signals, a blue one yields blues -- while
// still being driven entirely by the wallpaper.
function nearestHue(pywal: Record<string, string>, target: number, fallback: string): string {
	let best: string | null = null;
	let bestScore = -1;
	for (const key of Object.keys(pywal)) {
		const value = pywal[key];
		if (!value || !HEX6.test(normalizeHex(value))) continue;
		const hsl = hexToHsl(normalizeHex(value));
		// Wrap-around distance in degrees.
		const raw = Math.abs(hsl.h - target);
		const dist = Math.min(raw, 360 - raw);
		// Prefer colours close to the target hue, and among those the most vivid.
		// A 60-degree tolerance keeps a near-grey from winning on saturation alone.
		const score = hsl.s - dist * 1.6;
		if (score > bestScore && dist <= 90) {
			bestScore = score;
			best = value;
		}
	}
	return best ?? fallback;
}
// ── Retro knobs ──
// All of the retro colour tuning lives here. The wallpaper picks the HUE; these set how
// light, how tinted and how vivid each role is.
const RETRO_PAPER_LIGHT = 88; // lower = deeper paper, wallpaper tint shows more
const RETRO_PAPER_SAT_MIN = 42; // every wallpaper gets at least this much tint
const RETRO_PAPER_SAT_MAX = 70;
const RETRO_PAPER_SAT_SCALE = 0.9; // share of the wallpaper's own saturation that is kept
const RETRO_INK_LIGHT = 24; // text / borders: deep tinted colour, not black
const RETRO_INK_SAT = 48;
const RETRO_ACCENT_LIGHT = 64;
const RETRO_ACCENT_DEEP_LIGHT = 38;
const RETRO_ACCENT_SAT_MIN = 22; // the accent is never greyer than this
const RETRO_ACCENT_SAT_MAX = 34; // ...nor more vivid than this (was 60-85, then 36-52: still loud on soft paper)
// The accent must sit at least this many degrees away from the paper hue, otherwise
// highlights vanish into the page. 25 deg is clearly "another colour", still same family.
const RETRO_ACCENT_MIN_HUE_GAP = 25;
const RETRO_ACCENT_SRC_SAT_MIN = 12; // palette colours greyer than this cannot give the accent its hue
const RETRO_ACCENT_MAX_HUE_GAP = 180; // 180 = no upper limit (the opposite hue is allowed)
// Palette key whose hue the accent always follows, or null to pick from the whole palette.
// e.g. "blue" (wal colour4, what update-colors.ps1 treats as the wallpaper's main colour).
const RETRO_ACCENT_FROM: string | null = null;
// Outline around the side bar / frame / notch: the ink colour at this strength (1 = solid).
const RETRO_OUTLINE_ALPHA = 0.85;

function hueGap(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
}

// The accent: a wallpaper colour that is a different hue from the paper. Saturation alone picked
// whatever single entry was most vivid (a patch of grass green on a teal sky), so each candidate is
// weighted by how many palette entries share its hue: aliased entries (blue / teal / sky / sapphire
// are often the same colour) stand in for how much of the picture has that colour.
function retroAccentHue(
	pywal: Record<string, string>,
	paperHue: number
): { h: number; s: number } {
	// Pin it: set RETRO_ACCENT_FROM to a palette key ("blue", "teal", "red"...) to always use that
	// entry's hue.
	if (RETRO_ACCENT_FROM) {
		const v = colorToHex(pywal[RETRO_ACCENT_FROM]);
		if (v) {
			const c = hexToHsl(v);
			if (c.s >= 15) return { h: c.h, s: c.s };
		}
	}
	const cands: { h: number; s: number }[] = [];
	for (const key of WAL_COLOUR_KEYS) {
		const v = colorToHex(pywal[key]);
		if (!v) continue;
		const c = hexToHsl(v);
		// Pywal palettes from soft pictures are muted (teal at 21% saturation is normal), so the
		// floor is low; the accent is re-saturated below anyway. Only true greys are skipped.
		if (c.s < RETRO_ACCENT_SRC_SAT_MIN || c.l < 15 || c.l > 90) continue;
		const gap = hueGap(c.h, paperHue);
		if (gap < RETRO_ACCENT_MIN_HUE_GAP || gap > RETRO_ACCENT_MAX_HUE_GAP) continue;
		cands.push({ h: c.h, s: c.s });
	}
	let best: { h: number; s: number } | null = null;
	let bestScore = -1;
	for (const c of cands) {
		const mates = cands.filter((o) => hueGap(o.h, c.h) <= 20).length;
		const score = c.s * mates;
		if (score > bestScore) {
			bestScore = score;
			best = c;
		}
	}
	// Nothing usable (a one-colour or grey palette): a contrasting hue, not a neighbour.
	return best ?? { h: (paperHue + 160) % 360, s: 70 };
}

function relLum(hex: string): number {
	const c = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastRatio(a: string, b: string): number {
	const x = relLum(a);
	const y = relLum(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Walks the lightness from `start` in `step` increments until `hex` reaches `min` contrast
// against `against`. Blue and purple look dark at the same HSL lightness where yellow and
// green look bright, so a fixed lightness cannot keep text readable on every hue.
function fitContrast(
	h: number,
	s: number,
	start: number,
	step: number,
	against: string,
	min: number
): string {
	let l = start;
	let out = hslToHex(h, s, l);
	while (contrastRatio(out, against) < min && l + step >= 8 && l + step <= 95) {
		l += step;
		out = hslToHex(h, s, l);
	}
	return out;
}

function retroRoles(pywal: Record<string, string>): RetroRoles {
	const base = pywal["base"] || pywal["background"] || "#201a19";
	const text = pywal["text"] || pywal["foreground"] || "#ccc4bb";
	const accentSrc = pickAccentSource(pywal, text);

	// The wallpaper's main hue. Pywal's `base` is just the darkest colour and its `text` is blended
	// with fixed Catppuccin lavender, so using either made every wallpaper look alike (and the ink
	// always blue-black). The vote over the palette's real colours is what follows the picture.
	const dom = dominantHue(pywal);
	const baseHsl = hexToHsl(normalizeHex(base));
	const accHsl = hexToHsl(normalizeHex(accentSrc));
	const hue = dom ? dom.h : baseHsl.s >= 6 ? baseHsl.h : accHsl.h;
	const colourful = dom !== null || accHsl.s >= 15;
	const paperSat = colourful
		? Math.min(
				RETRO_PAPER_SAT_MAX,
				Math.max((dom ? dom.s : accHsl.s) * RETRO_PAPER_SAT_SCALE, RETRO_PAPER_SAT_MIN)
			)
		: 12;

	const acc = retroAccentHue(pywal, hue);
	const accSat = Math.min(RETRO_ACCENT_SAT_MAX, Math.max(acc.s, RETRO_ACCENT_SAT_MIN));

	// Signal hues for the backdrop. `red` and `green` are usually named; the
	// teal/blue keys are aliases in many schemes, so each falls back sensibly.
	const vizRed = atLightness(nearestHue(pywal, 8, accentSrc), 46, 1, 34);
	const vizTeal = atLightness(nearestHue(pywal, 200, accentSrc), 52, 1, 30);
	const vizYellow = atLightness(nearestHue(pywal, 45, accentSrc), 58, 1, 34);
	const vizGreen = atLightness(nearestHue(pywal, 140, accentSrc), 48, 1, 28);

	// The case is enamel in the wallpaper's own hue, lightened until it reads as
	// painted metal rather than paper. The screen is a deep well of that same hue,
	// so the glass looks tinted by the room.
	const caseHue = hue;
	const scopeCase = hslToHex(caseHue, 14, 78);
	const scopeCaseDeep = hslToHex(caseHue, 16, 62);
	const scopeScreen = hslToHex(caseHue, 26, 9);

	// The phosphor is pinned to the green of a real P1 screen and the lamp to a
	// genuine red: a scope that traces in the wallpaper's colour stops reading as one.
	const scopePhos = hslToHex((120 + caseHue * 0.12) % 360, 52, 66);
	const scopeLamp = hslToHex(6, 62, 48);

	const paper = hslToHex(hue, paperSat, RETRO_PAPER_LIGHT);
	const ink = hslToHex(hue, colourful ? RETRO_INK_SAT : 8, RETRO_INK_LIGHT);
	// Filled controls put ink on the accent: lighten the accent until that is readable (4.5:1).
	const accent = fitContrast(acc.h, accSat, RETRO_ACCENT_LIGHT, 2, ink, 4.5);
	// Lines, weekend text and rings sit on paper: darken until they hold 4.5:1 there.
	const accentDeep = fitContrast(acc.h, accSat, RETRO_ACCENT_DEEP_LIGHT, -2, paper, 4.5);

	return {
		// Light paper, clearly tinted with the wallpaper's hue (min saturation 42), so switching
		// wallpaper visibly changes the whole page: mint, peach, sky, lilac...
		paper,
		// A slightly deeper paper for panel fills and track bars.
		paperDeep: hslToHex(hue, Math.min(80, paperSat + 6), RETRO_PAPER_LIGHT - 9),
		// Ink is a deep, saturated shade of the wallpaper hue (deep navy, wine, forest...) rather
		// than near-black. Still ~9:1 against the paper.
		ink,
		// Secondary text: same hue, lighter, still about 5:1 or better on paper.
		inkMuted: hslToHex(hue, colourful ? RETRO_INK_SAT - 10 : 6, RETRO_INK_LIGHT + 10),
		// Accent: a vivid colour of a *different* hue from the paper, so highlights, today's date,
		// the play button and active segments stand out instead of blending into the page.
		accent,
		// Deeper accent for lines, weekend text and rings: clearly coloured, clearly not ink.
		accentDeep,
		vizRed,
		vizTeal,
		vizYellow,
		vizGreen,
		scopeCase,
		scopeCaseDeep,
		scopeScreen,
		scopePhos,
		scopeLamp
	};
}
// ── Adaptive light theme ──
// The "light" mode is a soft tonal light theme drawn from the wallpaper's pywal
// palette: a creamy surface in the wallpaper's own hue, dark ink, a deep accent
// for controls, and a thin outline. Unlike retro there are no hard shadows.
// With no palette on disk it falls back to the warm cream below.
interface LightRoles {
	surface: string;
	surfaceExpanded: string;
	ink: string;
	inkMuted: string;
	accent: string;
	/** The thin outline: the accent's hue, dark enough to read on the surface. */
	outline: string;
	/** Text on top of the accent (the surface colour, so it stays readable). */
	onAccent: string;
}

const LIGHT_FALLBACK: LightRoles = {
	surface: "#fbf4f0",
	surfaceExpanded: "#f6ede8",
	ink: "#241a18",
	inkMuted: "#6f5d58",
	accent: "#8c4a3f",
	outline: "#7a4a40",
	onAccent: "#fbf4f0"
};

const LIGHT_CACHE_KEY = "bloom-light-roles";

// Knobs: how light and how tinted the surface is, and how deep and saturated the accent is.
// A lower LIGHT_SURFACE_LIGHT or a higher LIGHT_SURFACE_SAT_FLOOR makes the wallpaper's colour
// show more.
const LIGHT_SURFACE_LIGHT = 92;
const LIGHT_SURFACE_SAT_FLOOR = 34;
const LIGHT_SURFACE_SAT_MAX = 58;
// How much of the wallpaper's own saturation the surface keeps (1 = all of it).
const LIGHT_SURFACE_SAT_SCALE = 0.5;
const LIGHT_ACCENT_LIGHT = 38;
const LIGHT_ACCENT_SAT = 0.85;

// The palette keys that come from the wallpaper. update-colors.ps1 fills these from wal's colours
// and writes fixed Catppuccin greys for the overlay* and surface* keys, which are always the same
// blue-violet and must not vote.
const WAL_COLOUR_KEYS = [
	"rosewater",
	"flamingo",
	"pink",
	"mauve",
	"red",
	"maroon",
	"peach",
	"yellow",
	"green",
	"teal",
	"sky",
	"sapphire",
	"blue",
	"lavender"
];

// The wallpaper's main colour, read from the palette. Pywal's base is the darkest colour (on a
// sunny picture with dark soil it is brown, whatever the sky is), so it says little about the look
// of the wallpaper. Instead every colourful entry votes for its hue, weighted by saturation, and the
// hue with most votes wins; aliased entries (several names for the same colour) count more, which
// is a fair stand-in for how much of the picture has that colour. Returns null for a grey palette.
function dominantHue(pywal: Record<string, string>): { h: number; s: number } | null {
	const items: { h: number; s: number }[] = [];
	// Only the keys that come from the wallpaper vote. A palette without them (another generator)
	// lets every key vote except the fixed greys and the dark backgrounds.
	const own = WAL_COLOUR_KEYS.filter((k) => pywal[k]);
	const keys =
		own.length >= 3
			? own
			: Object.keys(pywal).filter((k) => !/^(overlay|surface)\d$/.test(k) && !/^(base|bar-bg|mantle|crust)$/.test(k));
	for (const key of keys) {
		const v = pywal[key];
		if (!v || !HEX6.test(normalizeHex(v))) continue;
		const c = hexToHsl(normalizeHex(v));
		if (c.s < 15 || c.l < 10 || c.l > 90) continue;
		items.push({ h: c.h, s: c.s });
	}
	if (!items.length) return null;
	const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
	let bestCentre = 0;
	let bestVotes = -1;
	for (let centre = 0; centre < 360; centre += 15) {
		let votes = 0;
		for (const it of items) {
			const d = dist(it.h, centre);
			if (d <= 30) votes += it.s * (1 - d / 45);
		}
		if (votes > bestVotes) {
			bestVotes = votes;
			bestCentre = centre;
		}
	}
	let x = 0;
	let y = 0;
	let sSum = 0;
	let n = 0;
	for (const it of items) {
		if (dist(it.h, bestCentre) > 30) continue;
		const r = (it.h * Math.PI) / 180;
		x += Math.cos(r) * it.s;
		y += Math.sin(r) * it.s;
		sSum += it.s;
		n++;
	}
	return { h: (Math.atan2(y, x) * 180) / Math.PI + (Math.atan2(y, x) < 0 ? 360 : 0), s: sSum / n };
}

// A palette value as #rrggbb, whether it is written #abc, #aabbcc, #aabbccdd or rgb()/rgba().
function colorToHex(value: string | undefined): string | null {
	if (!value) return null;
	const v = value.trim();
	const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
	if (m) {
		return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
	}
	const h = normalizeHex(v);
	if (/^#[0-9a-f]{8}$/i.test(h)) return h.slice(0, 7);
	return HEX6.test(h) ? h : null;
}

// The palette's own border colour (glass-border, border or outline) when it is a real colour. A
// pale translucent glass border carries no colour, so then the outline is made from the wallpaper's
// hue instead. A usable one is darkened if needed so it reads on the light surface.
function pywalBorder(pywal: Record<string, string>): string | null {
	for (const key of ["glass-border", "border", "outline"]) {
		const hex = colorToHex(pywal[key]);
		if (!hex) continue;
		const c = hexToHsl(hex);
		if (c.s < 10) continue;
		return c.l > 45 ? atLightness(hex, 38, 1, 20) : hex;
	}
	return null;
}

function lightRoles(pywal: Record<string, string>): LightRoles {
	const base = pywal["base"] || pywal["background"] || "#201a19";
	const text = pywal["text"] || pywal["foreground"] || "#ccc4bb";
	const accentSrc = pickAccentSource(pywal, text);
	const baseHsl = hexToHsl(normalizeHex(base));
	const accHsl = hexToHsl(normalizeHex(accentSrc));
	// `blue` is wal's colour4, the colour update-colors.ps1 itself uses to tint the border and the
	// text, so it is the wallpaper's main colour as far as the rest of the setup is concerned. When it
	// has no colour the vote over the whole palette decides.
	const tint = colorToHex(pywal["blue"]);
	const tintHsl = tint ? hexToHsl(tint) : null;
	const dom = tintHsl && tintHsl.s >= 15 ? { h: tintHsl.h, s: tintHsl.s } : dominantHue(pywal);
	// A palette with no colour at all falls back to the base, then the accent.
	const hue = dom ? dom.h : baseHsl.s >= 6 ? baseHsl.h : accHsl.h;
	// A palette with no colour in it gets a barely tinted surface rather than an invented tint.
	const colourful = dom !== null || accHsl.s >= 15;
	const sat = colourful
		? Math.min(
				LIGHT_SURFACE_SAT_MAX,
				Math.max((dom ? dom.s : accHsl.s) * LIGHT_SURFACE_SAT_SCALE, LIGHT_SURFACE_SAT_FLOOR)
			)
		: 8;
	const surface = hslToHex(hue, sat, LIGHT_SURFACE_LIGHT);
	// Controls take the most vivid palette colour near that hue, so they match the surface.
	const accent = nearestHue(pywal, hue, accentSrc);
	return {
		surface,
		surfaceExpanded: hslToHex(hue, Math.min(LIGHT_SURFACE_SAT_MAX, sat + 4), LIGHT_SURFACE_LIGHT - 2),
		// Text follows the surface's hue, so it never turns yellow on a blue wallpaper.
		ink: hslToHex(hue, colourful ? 28 : 6, 13),
		inkMuted: hslToHex(hue, colourful ? 18 : 5, 36),
		accent: atLightness(accent, LIGHT_ACCENT_LIGHT, LIGHT_ACCENT_SAT, 30),
		outline: pywalBorder(pywal) ?? hslToHex(hue, Math.min(60, sat + 20), 30),
		onAccent: surface
	};
}

function readCachedLightRoles(): LightRoles | null {
	try {
		const raw = localStorage.getItem(LIGHT_CACHE_KEY);
		if (!raw) return null;
		const r = JSON.parse(raw) as LightRoles;
		const keys: (keyof LightRoles)[] = [
			"surface",
			"surfaceExpanded",
			"ink",
			"inkMuted",
			"accent",
			"outline",
			"onAccent"
		];
		return keys.every((k) => HEX6.test(r[k] ?? "")) ? r : null;
	} catch {
		return null;
	}
}

function paintLight(root: HTMLElement, r: LightRoles, op: number, opExpanded: number) {
	root.style.setProperty("--bloom-bg", hexToRgba(r.surface, op));
	root.style.setProperty("--bloom-bg-expanded", hexToRgba(r.surfaceExpanded, opExpanded));
	root.style.setProperty("--bloom-text", r.ink);
	root.style.setProperty("--bloom-text-muted", r.inkMuted);
	// Thin outline and dividers: the ink at low strength, so they stay quiet.
	root.style.setProperty("--bloom-border", hexToRgba(r.outline, 0.3));
	root.style.setProperty("--bloom-outline", hexToRgba(r.outline, 0.9));
	root.style.setProperty("--bloom-group-bg", hexToRgba(r.ink, 0.05));
	root.style.setProperty("--bloom-accent", r.accent);
	root.style.setProperty("--bloom-scrollbar-thumb", hexToRgba(r.ink, 0.22));
	root.style.setProperty("--bloom-hover", hexToRgba(r.ink, 0.08));
	root.style.setProperty("--bloom-field", hexToRgba(r.ink, 0.06));
	root.style.setProperty("--bloom-control-bg", r.accent);
	root.style.setProperty("--bloom-control-fg", r.onAccent);
}

export async function applyTheme(
	mode: string,
	customColor: string,
	opacity?: number,
	saturation?: number,
	brightness?: number
) {
	const root = document.documentElement;
	if (opacity === undefined || opacity === null) {
		const cachedOpacity = localStorage.getItem("bloom-theme-opacity");
		opacity = cachedOpacity !== null ? parseFloat(cachedOpacity) : 0.8;
	}

	if (saturation === undefined || saturation === null) {
		const cachedSaturation = localStorage.getItem("bloom-theme-saturation");
		saturation = cachedSaturation !== null ? parseFloat(cachedSaturation) : 0.5;
	}

	if (brightness === undefined || brightness === null) {
		const cachedBrightness = localStorage.getItem("bloom-theme-brightness");
		brightness = cachedBrightness !== null ? parseFloat(cachedBrightness) : 0.15;
	}

	const op = opacity;
	const opExpanded = Math.min(1.0, opacity + 0.12);

	// Light and retro set these; clear them so they cannot leak into another theme.
	root.style.removeProperty("--bloom-outline");
	root.style.removeProperty("--bloom-control-bg");
	root.style.removeProperty("--bloom-control-fg");

	if (mode === "light") {
		// Draw straight away from the last palette (or the cream fallback) so there is no
		// flash, then repaint once the current pywal palette has been read.
		paintLight(root, readCachedLightRoles() ?? LIGHT_FALLBACK, op, opExpanded);
		root.classList.add("light-mode");
		root.classList.remove("dark-mode");
		root.classList.add("theme-light");
		root.classList.remove("theme-dark", "theme-custom", "theme-adaptive", "theme-retro");
		try {
			const wasPreview = previewPalette !== null;
			const pywal = await loadPywalPalette();
			// Another theme may have been applied while the palette was loading.
			if (pywal && root.classList.contains("theme-light")) {
				const roles = lightRoles(pywal);
				paintLight(root, roles, op, opExpanded);
				// A previewed palette is never remembered for the next start.
				if (wasPreview || previewPalette !== null) return;
				try {
					localStorage.setItem(LIGHT_CACHE_KEY, JSON.stringify(roles));
				} catch {
					// not remembered, the next start just paints the fallback first
				}
			}
		} catch {
			// no palette: the cached or fallback colours stay
		}
	} else if (mode === "custom") {
		const hsl = hexToHsl(customColor);
		hsl.s = saturation * 100;
		hsl.l = brightness * 100;
		const finalBgColor = hslToHex(hsl.h, hsl.s, hsl.l);
		const isLight = brightness > 0.55;

		root.style.setProperty("--bloom-bg", hexToRgba(finalBgColor, op));
		root.style.setProperty("--bloom-bg-expanded", hexToRgba(finalBgColor, opExpanded));
		root.style.setProperty("--bloom-text", isLight ? "#1c1c1e" : "#ffffff");
		root.style.setProperty(
			"--bloom-text-muted",
			isLight ? "rgba(28, 28, 30, 0.65)" : "rgba(255, 255, 255, 0.65)"
		);
		root.style.setProperty(
			"--bloom-border",
			isLight ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.12)"
		);
		root.style.setProperty(
			"--bloom-group-bg",
			isLight ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.04)"
		);
		root.style.setProperty("--bloom-accent", customColor);
		root.style.setProperty(
			"--bloom-hover",
			isLight ? "rgba(0, 0, 0, 0.07)" : "rgba(255, 255, 255, 0.1)"
		);
		root.style.setProperty(
			"--bloom-field",
			isLight ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.08)"
		);
		root.style.setProperty(
			"--bloom-scrollbar-thumb",
			isLight ? "rgba(0, 0, 0, 0.15)" : "rgba(255, 255, 255, 0.15)"
		);
		root.classList.add("theme-custom");
		root.classList.remove("theme-light", "theme-dark", "theme-adaptive", "theme-retro");
		if (isLight) {
			root.classList.add("light-mode");
			root.classList.remove("dark-mode");
		} else {
			root.classList.add("dark-mode");
			root.classList.remove("light-mode");
		}
	} else if (mode === "retro") {
		// Paper-and-ink skin: pywal hues remapped onto light roles so the
		// wallpaper still drives the color, but the result reads as cream + ink.
		let roles: RetroRoles | null = null;
		try {
			const pywal = await loadPywalPalette();
			if (pywal) {
				roles = retroRoles(pywal);
			}
		} catch {
			// no palette on disk — fall back to a neutral paper, ink and accent
		}
		if (!roles) {
			roles = {
				paper: "#efe2c8",
				paperDeep: "#ddc9a3",
				ink: "#3a2a4a",
				inkMuted: "#65507a",
				accent: "#4fb6c8",
				accentDeep: "#1f7c8e",
				vizRed: "#c0392b",
				vizTeal: "#4f9aa6",
				vizYellow: "#c9a227",
				vizGreen: "#4a8c5a",
				// The scope face with no readable palette: a bone case, a dark well,
				// green phosphor and a red jewel lamp.
				scopeCase: "#cfc7b4",
				scopeCaseDeep: "#a9a08a",
				scopeScreen: "#0d1f1a",
				scopePhos: "#7ed6b4",
				scopeLamp: "#c0392b"
			};
		}

		root.style.setProperty("--bloom-bg", hexToRgba(roles.paper, op));
		root.style.setProperty("--bloom-bg-expanded", hexToRgba(roles.paper, opExpanded));
		root.style.setProperty("--bloom-text", roles.ink);
		root.style.setProperty("--bloom-text-muted", roles.inkMuted);
		root.style.setProperty("--bloom-border", roles.ink);
		root.style.setProperty("--bloom-group-bg", hexToRgba(roles.ink, 0.08));
		root.style.setProperty("--bloom-accent", roles.accent);
		root.style.setProperty("--bloom-scrollbar-thumb", hexToRgba(roles.ink, 0.35));
		// The thin outline around the side bar, the frame and the notch (same variable the light theme uses).
		root.style.setProperty("--bloom-outline", hexToRgba(roles.ink, RETRO_OUTLINE_ALPHA));

		// Retro-specific vars consumed by the .theme-retro blocks in the stylesheets.
		root.style.setProperty("--retro-paper", roles.paper);
		root.style.setProperty("--retro-paper-deep", roles.paperDeep);
		root.style.setProperty("--retro-ink", roles.ink);
		root.style.setProperty("--retro-ink-muted", roles.inkMuted);
		root.style.setProperty("--retro-accent", roles.accent);
		root.style.setProperty("--retro-accent-deep", roles.accentDeep);
		// Surfaces for interactive states. --bloom-border is solid ink here, so it
		// cannot double as a hover wash: painting it behind ink text hid the label.
		root.style.setProperty("--bloom-hover", hexToRgba(roles.ink, 0.1));
		root.style.setProperty("--bloom-field", hexToRgba(roles.paperDeep, 0.85));
		// Filled controls (primary buttons, active segments): accent behind ink.
		root.style.setProperty("--bloom-control-bg", roles.accent);
		root.style.setProperty("--bloom-control-fg", roles.ink);

		root.style.setProperty("--viz-red", roles.vizRed);
		root.style.setProperty("--viz-teal", roles.vizTeal);
		root.style.setProperty("--viz-yellow", roles.vizYellow);
		root.style.setProperty("--viz-green", roles.vizGreen);
		root.style.setProperty("--scope-case", roles.scopeCase);
		root.style.setProperty("--scope-case-deep", roles.scopeCaseDeep);
		root.style.setProperty("--scope-screen", roles.scopeScreen);
		root.style.setProperty("--scope-phos", roles.scopePhos);
		root.style.setProperty("--scope-lamp", roles.scopeLamp);

		root.classList.add("theme-retro");
		root.classList.remove("theme-light", "theme-dark", "theme-custom", "theme-adaptive");
		// Retro is a light theme, so the light-mode contract (dark ink on paper) holds.
		root.classList.add("light-mode");
		root.classList.remove("dark-mode");
	} else if (mode === "adaptive") {
		try {
			const pywal = await loadPywalPalette();
			if (pywal) {
				const base = pywal["base"];
				const text = pywal["text"];
				const isLight = hexToHsl(base).l > 55;
				root.style.setProperty("--bloom-bg", hexToRgba(base, op));
				root.style.setProperty("--bloom-bg-expanded", hexToRgba(base, opExpanded));
				root.style.setProperty("--bloom-text", text);
				root.style.setProperty("--bloom-text-muted", hexToRgba(text, 0.65));
				root.style.setProperty(
					"--bloom-border",
					pywal["glass-border"] ?? hexToRgba(text, 0.12)
				);
				root.style.setProperty("--bloom-group-bg", hexToRgba(text, 0.04));
				root.style.setProperty(
					"--bloom-accent",
					HEX6.test(pywal["blue"] ?? "") ? pywal["blue"] : text
				);
				root.style.setProperty("--bloom-scrollbar-thumb", hexToRgba(text, 0.15));
				root.classList.add("theme-adaptive");
				root.classList.remove("theme-light", "theme-dark", "theme-custom", "theme-retro");
				if (isLight) {
					root.classList.add("light-mode");
					root.classList.remove("dark-mode");
				} else {
					root.classList.add("dark-mode");
					root.classList.remove("light-mode");
				}
				return;
			}
			const accentHex = await invoke<string>("get_system_accent_color");
			const hsl = hexToHsl(accentHex);
			hsl.s = saturation * 100;
			hsl.l = brightness * 100;
			const finalBgColor = hslToHex(hsl.h, hsl.s, hsl.l);
			const isLight = brightness > 0.55;

			root.style.setProperty("--bloom-bg", hexToRgba(finalBgColor, op));
			root.style.setProperty("--bloom-bg-expanded", hexToRgba(finalBgColor, opExpanded));
			root.style.setProperty("--bloom-text", isLight ? "#1c1c1e" : "#ffffff");
			root.style.setProperty(
				"--bloom-text-muted",
				isLight ? "rgba(28, 28, 30, 0.65)" : "rgba(255, 255, 255, 0.65)"
			);
			root.style.setProperty(
				"--bloom-border",
				isLight ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.12)"
			);
			root.style.setProperty(
				"--bloom-group-bg",
				isLight ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.04)"
			);
			root.style.setProperty("--bloom-accent", accentHex);
			root.style.setProperty(
				"--bloom-scrollbar-thumb",
				isLight ? "rgba(0, 0, 0, 0.15)" : "rgba(255, 255, 255, 0.15)"
			);
			root.classList.add("theme-adaptive");
			root.classList.remove("theme-light", "theme-dark", "theme-custom", "theme-retro");
			if (isLight) {
				root.classList.add("light-mode");
				root.classList.remove("dark-mode");
			} else {
				root.classList.add("dark-mode");
				root.classList.remove("light-mode");
			}
		} catch (e) {
			console.error("Failed to apply adaptive theme:", e);
			applyTheme("dark", customColor, op, saturation, brightness);
		}
	} else {
		// default/dark
		root.style.setProperty("--bloom-bg", `rgba(0, 0, 0, ${op})`);
		root.style.setProperty("--bloom-bg-expanded", `rgba(0, 0, 0, ${opExpanded})`);
		root.style.setProperty("--bloom-text", "#ffffff");
		root.style.setProperty("--bloom-text-muted", "rgba(255, 255, 255, 0.6)");
		root.style.setProperty("--bloom-border", "rgba(255, 255, 255, 0.1)");
		root.style.setProperty("--bloom-group-bg", "rgba(255, 255, 255, 0.04)");
		root.style.setProperty("--bloom-accent", "#007aff");
		root.style.setProperty("--bloom-scrollbar-thumb", "rgba(255, 255, 255, 0.1)");
		root.style.setProperty("--bloom-hover", "rgba(255, 255, 255, 0.1)");
		root.style.setProperty("--bloom-field", "rgba(255, 255, 255, 0.08)");
		root.classList.add("dark-mode");
		root.classList.remove("light-mode");
		root.classList.add("theme-dark");
		root.classList.remove("theme-light", "theme-custom", "theme-adaptive");
	}
}

export function initTheme() {
	const syncMode = localStorage.getItem("bloom-theme-mode") || "dark";
	const syncColor = localStorage.getItem("bloom-theme-color") || "#007aff";
	const syncOpacityVal = localStorage.getItem("bloom-theme-opacity");
	const syncOpacity = syncOpacityVal !== null ? parseFloat(syncOpacityVal) : 0.8;
	const syncSaturationVal = localStorage.getItem("bloom-theme-saturation");
	const syncSaturation = syncSaturationVal !== null ? parseFloat(syncSaturationVal) : 0.5;
	const syncBrightnessVal = localStorage.getItem("bloom-theme-brightness");
	const syncBrightness = syncBrightnessVal !== null ? parseFloat(syncBrightnessVal) : 0.15;

	// Fast synchronous draw using cached localStorage
	applyTheme(syncMode, syncColor, syncOpacity, syncSaturation, syncBrightness);

	// Sync settings.json in background to avoid flickers
	invoke<Record<string, any>>("load_settings")
		.then(async (settings) => {
			// Don't write a stale mirror value back while the window reloads.
			if (await reloadIfMirrorWasStale(settings)) return;
			const mode = settings["bloom-theme-mode"] ? String(settings["bloom-theme-mode"]) : syncMode;
			const color = settings["bloom-theme-color"]
				? String(settings["bloom-theme-color"])
				: syncColor;
			const opacityVal = settings["bloom-theme-opacity"]
				? parseFloat(String(settings["bloom-theme-opacity"]))
				: syncOpacity;
			const saturationVal = settings["bloom-theme-saturation"]
				? parseFloat(String(settings["bloom-theme-saturation"]))
				: syncSaturation;
			const brightnessVal = settings["bloom-theme-brightness"]
				? parseFloat(String(settings["bloom-theme-brightness"]))
				: syncBrightness;

			if (
				mode !== syncMode ||
				color !== syncColor ||
				opacityVal !== syncOpacity ||
				saturationVal !== syncSaturation ||
				brightnessVal !== syncBrightness
			) {
				localStorage.setItem("bloom-theme-mode", mode);
				localStorage.setItem("bloom-theme-color", color);
				localStorage.setItem("bloom-theme-opacity", String(opacityVal));
				localStorage.setItem("bloom-theme-saturation", String(saturationVal));
				localStorage.setItem("bloom-theme-brightness", String(brightnessVal));
				applyTheme(mode, color, opacityVal, saturationVal, brightnessVal);
			}
		})
		.catch(console.error);

	// Helper: read all theme values from localStorage and apply
	const applyThemeFromStorage = () => {
		const mode = localStorage.getItem("bloom-theme-mode") || "dark";
		const color = localStorage.getItem("bloom-theme-color") || "#007aff";
		const opacity = parseFloat(localStorage.getItem("bloom-theme-opacity") || "0.80");
		const saturation = parseFloat(localStorage.getItem("bloom-theme-saturation") || "0.50");
		const brightness = parseFloat(localStorage.getItem("bloom-theme-brightness") || "0.15");
		applyTheme(mode, color, opacity, saturation, brightness);
	};

	const bloomThemeKeys = [
		"bloom-theme-mode",
		"bloom-theme-color",
		"bloom-theme-opacity",
		"bloom-theme-saturation",
		"bloom-theme-brightness"
	];

	// Listen to setting changes broadcasted from settings window
	// (localStorage sync is handled by saveAndLocal in Settings.tsx; we just apply the theme)
	const settingsPromise = listen<{ key: string; value: any }>("settings-changed", (event) => {
		const { key } = event.payload;
		if (bloomThemeKeys.includes(key)) {
			applyThemeFromStorage();
		}
	});

	// Listen to system accent color updates in case of adaptive theme
	const accentPromise = listen<string>("system-accent-changed", (event) => {
		const currentMode = localStorage.getItem("bloom-theme-mode") || "dark";
		if (currentMode === "adaptive") {
			const opacity = parseFloat(localStorage.getItem("bloom-theme-opacity") || "0.80");
			const saturation = parseFloat(localStorage.getItem("bloom-theme-saturation") || "0.50");
			const brightness = parseFloat(localStorage.getItem("bloom-theme-brightness") || "0.15");
			applyTheme("adaptive", event.payload, opacity, saturation, brightness);
		}
	});

	// Listen to pywal palette updates (update-colors.ps1 rewrote colors.css)
	const followsPywal = () => {
		const mode = localStorage.getItem("bloom-theme-mode") || "dark";
		return mode === "adaptive" || mode === "retro" || mode === "light";
	};
	const pywalPromise = listen<string>("pywal-colors-changed", () => {
		previewPalette = null; // the real palette is here (a wallpaper was applied)
		if (followsPywal()) {
			applyThemeFromStorage();
		}
	});

	// Wallpaper preview: paint the palette the previewed picture would give, then go back to the saved one.
	const previewPromise = listen<string>("pywal-preview", (event) => {
		const vars = parsePywalPalette(String(event.payload));
		if (!HEX6.test(vars["base"] ?? "") || !HEX6.test(vars["text"] ?? "")) return;
		previewPalette = vars;
		if (followsPywal()) applyThemeFromStorage();
	});
	const previewEndPromise = listen("pywal-preview-end", () => {
		if (!previewPalette) return;
		previewPalette = null;
		if (followsPywal()) applyThemeFromStorage();
	});

	// Listen to external edits (e.g. settings.json edited outside the app)
	// localStorage sync is handled by useSettingsSync hook; we just apply the theme
	const externalPromise = listen<{ key: string; value: any }>(
		"settings-external-changed",
		(event) => {
			const { key } = event.payload;
			if (bloomThemeKeys.includes(key)) {
				applyThemeFromStorage();
			}
		}
	);

	return () => {
		settingsPromise.then((f) => f());
		accentPromise.then((f) => f());
		pywalPromise.then((f) => f());
		previewPromise.then((f) => f());
		previewEndPromise.then((f) => f());
		externalPromise.then((f) => f());
	};
}
