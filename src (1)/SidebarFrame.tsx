import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { initTheme } from "./theme";

// The thin frame around the screen: a strip along the top, one along the bottom and one down the
// side away from the bar. Same surface as the bar and the notch. The window is click-through and only
// paints. The notch joins this strip with its own concave corners (the "is-impacted" rule in App.css),
// so nothing here needs to know where the notch is.
// STRIP must equal FRAME_STRIP_H in sidebar.rs and --sb-strip in Sidebar.css.
const STRIP = 11;
// Radius of the rounded inner corners. Must equal --sb-fillet in Sidebar.css (the bar draws the two
// corners on its own side, this window draws the two on the far side).
const FILLET = 20;
// The window reaches this far above the screen (FRAME_BLEED_PX in sidebar.rs), so the pieces start
// this far down.
const FRAME_BLEED = 16;
const SURFACE = "var(--bloom-bg-expanded, rgba(0, 0, 0, 0.92))";
// The adaptive light and retro themes draw a thin line along the inner edge of the frame. OW must equal
// --sb-ow in Sidebar.css and BAR_W the bar width there (--sb-bar-w): the top and bottom lines stop
// where the bar's own curved joins begin.
const OW = 2;
const BAR_W = 56;
const LINE = "var(--bloom-outline, transparent)";

const isOutlined = () => {
	const c = document.documentElement.classList;
	return c.contains("theme-light") || c.contains("theme-retro");
};

export default function SidebarFrame() {
	const [mode, setMode] = useState("smart");
	const [side, setSide] = useState("left");
	const [overlap, setOverlap] = useState(false);
	const [outlined, setOutlined] = useState(() => isOutlined());
	// Where the notch is (screen px, sent by the notch window) and where this window starts on the screen.
	const [span, setSpan] = useState<{ l: number; r: number; p: number } | null>(null);
	const [winX, setWinX] = useState(0);
	const [vw, setVw] = useState(() => window.innerWidth);

	useEffect(() => {
		try {
			(initTheme as any)?.();
		} catch {}
		document.documentElement.style.background = "transparent";
		document.body.style.background = "transparent";
		invoke<Record<string, any>>("load_settings")
			.then((s) => {
				if (s["bloom-sidebar-mode"]) setMode(String(s["bloom-sidebar-mode"]));
				if (s["bloom-sidebar-side"]) setSide(String(s["bloom-sidebar-side"]));
			})
			.catch(() => {});
		const obs = new MutationObserver(() =>
			setOutlined(isOutlined())
		);
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		// initTheme() above has already set the class, before the observer existed, so read it now.
		setOutlined(isOutlined());
		const win = getCurrentWebviewWindow();
		Promise.all([win.outerPosition(), win.scaleFactor()])
			.then(([o, sf]) => setWinX(o.x / sf))
			.catch(() => {});
		const onResize = () => setVw(window.innerWidth);
		window.addEventListener("resize", onResize);
		const n = listen<{ l: number; r: number; p: number } | null>("sidebar-notch-span", (e) => setSpan(e.payload));
		const a = listen<boolean>("sidebar-overlap", (e) => setOverlap(e.payload));
		const b = listen<string>("sidebar-mode", (e) => setMode(e.payload));
		const c = listen<{ key: string; value: any }>("settings-changed", (e) => {
			if (e.payload.key === "bloom-sidebar-mode") setMode(String(e.payload.value));
			if (e.payload.key === "bloom-sidebar-side") setSide(String(e.payload.value));
		});
		return () => {
			obs.disconnect();
			window.removeEventListener("resize", onResize);
			[a, b, c, n].forEach((p) => p.then((f) => f()));
		};
	}, []);

	// Smart: gone while a window overlaps the bar. Peek: the window is hidden by the backend.
	const hidden = mode === "peek" || (mode === "smart" && overlap);
	const piece = {
		position: "absolute" as const,
		background: SURFACE,
		opacity: hidden ? 0 : 1,
		transition: "opacity 0.15s"
	};

	// Rounded inner corners on the side away from the bar: a square of surface colour with a circle cut
	// out of it. They sit inside the strips, so nothing overlaps.
	const far = side === "right" ? "left" : "right";
	const corner = (v: "top" | "bottom") => {
		const cx = far === "right" ? "0" : "100%";
		const cy = v === "top" ? "100%" : "0";
		return {
			...piece,
			[v]: STRIP,
			[far]: STRIP,
			width: FILLET,
			height: FILLET,
			background: `radial-gradient(circle at ${cx} ${cy}, transparent ${FILLET - 0.5}px, ${SURFACE} ${FILLET}px)`
		};
	};

	// The line along the arc of a corner, as its own layer one line-width bigger on every side:
	// at the two ends of the arc the line lies just outside the corner's box.
	const ringCorner = (v: "top" | "bottom") => {
		const cx = far === "right" ? `${OW}px` : `calc(100% - ${OW}px)`;
		const cy = v === "top" ? `calc(100% - ${OW}px)` : `${OW}px`;
		return {
			position: "absolute" as const,
			opacity: hidden ? 0 : 1,
			transition: "opacity 0.15s",
			[v]: STRIP - OW,
			[far]: STRIP - OW,
			width: FILLET + OW * 2,
			height: FILLET + OW * 2,
			background: `radial-gradient(circle at ${cx} ${cy}, transparent ${FILLET - 0.5}px, ${LINE} ${FILLET}px, ${LINE} ${FILLET + OW}px, transparent ${FILLET + OW + 0.5}px)`
		};
	};

	// Same for the two corners next to the bar. The bar window draws these too; this layer is what
	// carries the line over the part that is above the bar window (the strip side of the arc).
	const barSideName = side === "right" ? "right" : "left";
	const ringBarCorner = (v: "top" | "bottom") => {
		const cx = barSideName === "left" ? `calc(100% - ${OW}px)` : `${OW}px`;
		const cy = v === "top" ? `calc(100% - ${OW}px)` : `${OW}px`;
		return {
			position: "absolute" as const,
			opacity: hidden ? 0 : 1,
			transition: "opacity 0.15s",
			[v]: STRIP - OW,
			[barSideName]: BAR_W - OW,
			width: FILLET + OW * 2,
			height: FILLET + OW * 2,
			background: `radial-gradient(circle at ${cx} ${cy}, transparent ${FILLET - 0.5}px, ${LINE} ${FILLET}px, ${LINE} ${FILLET + OW}px, transparent ${FILLET + OW + 0.5}px)`
		};
	};

	// The line along the inner edge of a strip, laid over the strip's last OW pixels. The top and
	// bottom lines run between the two curved joins; the bar's own side is left to the bar window.
	const barSide = side === "right" ? "right" : "left";
	const lineStart = (barSide === "left" ? BAR_W : STRIP) + FILLET;
	const lineEnd = (barSide === "left" ? STRIP : BAR_W) + FILLET;
	const line = {
		position: "absolute" as const,
		background: LINE,
		opacity: hidden ? 0 : 1,
		transition: "opacity 0.15s"
	};

	// Where the notch hangs from the top strip, the strip's line stops: the notch and the strip are one shape there.
	// The gap covers the notch and the concave pads either side of it (the pads' own arcs carry the line from there).
	const gapL = span ? span.l - span.p - winX : 0;
	const gapR = span ? span.r + span.p - winX : 0;
	const topSegs: { left: number; right: number }[] = [];
	if (span && gapR > gapL) {
		if (gapL > lineStart) topSegs.push({ left: lineStart, right: vw - gapL });
		if (gapR < vw - lineEnd) topSegs.push({ left: gapR, right: lineEnd });
	} else {
		topSegs.push({ left: lineStart, right: lineEnd });
	}

	// The three pieces do not overlap: the surface is a little see-through, so an overlap would show
	// as a darker patch.
	return (
		<div style={{ position: "fixed", top: FRAME_BLEED, left: 0, right: 0, bottom: 0, pointerEvents: "none" }}>
			<div style={{ ...piece, top: 0, left: 0, right: 0, height: STRIP }} />
			<div style={{ ...piece, left: 0, right: 0, bottom: 0, height: STRIP }} />
			<div
				style={{
					...piece,
					top: STRIP,
					bottom: STRIP,
					[side === "right" ? "left" : "right"]: 0,
					width: STRIP
				}}
			/>
			<div style={corner("top")} />
			<div style={corner("bottom")} />
			{outlined && (
				<>
					<div style={ringCorner("top")} />
					<div style={ringCorner("bottom")} />
					<div style={ringBarCorner("top")} />
					<div style={ringBarCorner("bottom")} />
					{topSegs.map((g, i) => (
						<div key={i} style={{ ...line, top: STRIP - OW, height: OW, left: g.left, right: g.right }} />
					))}
					<div style={{ ...line, bottom: STRIP - OW, height: OW, left: lineStart, right: lineEnd }} />
					<div style={{ ...line, [far]: STRIP - OW, width: OW, top: STRIP + FILLET, bottom: STRIP + FILLET }} />
				</>
			)}
		</div>
	);
}
