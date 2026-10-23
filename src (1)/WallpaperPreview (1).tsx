import { useEffect, useRef, useState } from "react";
import "./WallpaperPreview.css";

// Drawn by the "wp-preview" window (created in wallpaper.rs, which sits just above the desktop, behind
// every app window, the dock and the notch). That window has no IPC; wallpaper.rs drives this page by
// calling window.__wpv.show(...) / window.__wpv.end(...) through eval(). The real Windows wallpaper is
// never touched here.

type Layer = { id: number; src: string; style: string; ms: number };

const FADE_IN_MS = 450; // a different wallpaper
const SHARPEN_MS = 250; // the same wallpaper, sharp version replacing its thumbnail
const FADE_OUT_MS = 200; // keep in step with PREVIEW_FADE_OUT_MS in wallpaper.rs and .wpv in the css
const TOP_BLEED_PX = 12; // keep in step with PREVIEW_TOP_BLEED in wallpaper.rs (physical pixels)

const sizeFor = (style: string) =>
	style === "fit" ? "contain" : style === "stretch" ? "100% 100%" : style === "tile" || style === "center" ? "auto" : "cover";

// Windows' "Fill" does not centre the part of the picture it cuts off. For a picture taller than the screen
// it cuts only a third of it off the top (measured on a 3:2 wallpaper on a 16:9 screen: the crop starts
// 1/3 of the way down the surplus, not 1/2). Keep in step with FILL_ANCHOR_Y in wallpaper.rs.
const FILL_Y = "33.33%";
const positionFor = (style: string) => (style === "fill" ? `50% ${FILL_Y}` : "center");

export default function WallpaperPreview() {
	const [layers, setLayers] = useState<Layer[]>([]);
	const [shown, setShown] = useState(false);
	const idRef = useRef(0);
	const tokenRef = useRef(0);
	const hideRef = useRef<number | null>(null);
	const clearRef = useRef<number | null>(null);

	useEffect(() => {
		document.documentElement.classList.add("wpv-page");
		// The window reaches TOP_BLEED_PX above the screen; the picture starts where the screen does.
		document.documentElement.style.setProperty("--wpv-top", `${TOP_BLEED_PX / (window.devicePixelRatio || 1)}px`);
		const cancelTimers = () => {
			if (hideRef.current !== null) window.clearTimeout(hideRef.current);
			if (clearRef.current !== null) window.clearTimeout(clearRef.current);
			hideRef.current = null;
			clearRef.current = null;
		};

		const show = async (src: string, style: string, sharpen: boolean) => {
			cancelTimers();
			const token = ++tokenRef.current;
			// Decode first, so a layer never fades in half drawn.
			const img = new Image();
			img.src = src;
			try {
				await img.decode();
			} catch {
				return;
			}
			if (token !== tokenRef.current) return; // a newer picture arrived, or the preview ended
			const ms = sharpen ? SHARPEN_MS : FADE_IN_MS;
			setLayers((ls) => [...ls, { id: ++idRef.current, src, style, ms }].slice(-4));
			setShown(true);
		};

		const end = (hold: number) => {
			tokenRef.current++; // drop a picture that is still decoding
			cancelTimers();
			hideRef.current = window.setTimeout(
				() => {
					setShown(false);
					clearRef.current = window.setTimeout(() => setLayers([]), FADE_OUT_MS + 50);
				},
				Math.max(0, hold || 0)
			);
		};

		const w = window as unknown as { __wpv?: { show: typeof show; end: typeof end } };
		w.__wpv = { show, end };
		return () => {
			delete w.__wpv;
			cancelTimers();
		};
	}, []);

	// Once a layer has finished fading in it is solid, so everything under it can go.
	const prune = (id: number) =>
		setLayers((ls) => {
			const at = ls.findIndex((l) => l.id === id);
			return at > 0 ? ls.slice(at) : ls;
		});

	return (
		<div className={`wpv${shown ? " on" : ""}`} aria-hidden>
			{layers.map((l) => (
				<div
					key={l.id}
					className="wpv-layer"
					onAnimationEnd={() => prune(l.id)}
					style={{
						backgroundImage: `url("${l.src}")`,
						backgroundSize: sizeFor(l.style),
						backgroundPosition: positionFor(l.style),
						backgroundRepeat: l.style === "tile" ? "repeat" : "no-repeat",
						animationDuration: `${l.ms}ms`
					}}
				/>
			))}
		</div>
	);
}
