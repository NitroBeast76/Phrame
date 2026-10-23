// media-fx:v1
import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import "./MediaFx.css";

/**
 * Oscilloscope trace along the bottom of the Media tab, driven by the same audio bands as the
 * old ring of bars. The backend only reports a handful of bands, so each one drives a sine of
 * its own frequency; the sum drifts across the screen like a scope trace, and a loud hit adds
 * a short spike. Drawn on one small canvas, and it stops redrawing once paused and settled.
 */

const BANDS = 5;
const TAU = Math.PI * 2;
const RISE_MS = 70;
const FALL_MS = 260;
const SPIKE_MS = 260;

interface Spike {
	x: number;
	h: number;
	born: number;
}

/** Height of the trace at horizontal position `x` (0..1) and time `t` (seconds), in -1..1. */
export function scopeSample(x: number, t: number, levels: number[], spikes: Spike[], now: number): number {
	let y = 0;
	y += (levels[0] ?? 0) * Math.sin(x * TAU * 1.4 + t * 0.9);
	y += (levels[1] ?? 0) * 0.85 * Math.sin(x * TAU * 3.1 - t * 1.35 + 1.1);
	y += (levels[2] ?? 0) * 0.65 * Math.sin(x * TAU * 6.3 + t * 2.2 + 2.3);
	y += (levels[3] ?? 0) * 0.5 * Math.sin(x * TAU * 11.7 - t * 3.5 + 0.4);
	y += (levels[4] ?? 0) * 0.38 * Math.sin(x * TAU * 19.4 + t * 5.3);
	y *= 0.46 * (0.8 + 0.2 * Math.sin(x * TAU * 0.8 + t * 0.3));
	for (const s of spikes) {
		const age = (now - s.born) / SPIKE_MS;
		if (age >= 1) continue;
		const d = x - s.x;
		y += s.h * (1 - age) * Math.exp(-(d * d) / 0.0007);
	}
	return Math.max(-1, Math.min(1, y));
}

export function ScopeWave({ isPlaying }: { isPlaying: boolean }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;

		let width = 0;
		let height = 0;
		let accent = "#ff9f0a";
		let muted = "rgba(255, 255, 255, 0.5)";

		const readColors = () => {
			const style = getComputedStyle(canvas);
			accent = style.getPropertyValue("--bloom-accent").trim() || accent;
			muted = style.getPropertyValue("--bloom-text-muted").trim() || muted;
		};
		const resize = () => {
			const dpr = window.devicePixelRatio || 1;
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = Math.max(1, Math.round(width * dpr));
			canvas.height = Math.max(1, Math.round(height * dpr));
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};

		const target = new Array<number>(BANDS).fill(0);
		const levels = new Array<number>(BANDS).fill(0);
		const spikes: Spike[] = [];
		let prevEnergy = 0;
		let phase = 0;
		let last = performance.now();
		let frame = 0;

		const draw = (now: number) => {
			ctx.clearRect(0, 0, width, height);
			const mid = height / 2;

			// Centre axis with small ticks, like the graticule on a scope.
			ctx.save();
			ctx.strokeStyle = muted;
			ctx.globalAlpha = 0.3;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(0, Math.round(mid) + 0.5);
			ctx.lineTo(width, Math.round(mid) + 0.5);
			for (let x = 12, i = 0; x < width; x += 24, i++) {
				const half = i % 5 === 0 ? 4 : 2;
				ctx.moveTo(x + 0.5, Math.round(mid) - half);
				ctx.lineTo(x + 0.5, Math.round(mid) + half + 1);
			}
			ctx.stroke();
			ctx.restore();

			// The trace itself, with a soft glow.
			const points = Math.max(24, Math.floor(width / 2.5));
			const amp = Math.max(2, mid - 3);
			ctx.save();
			ctx.strokeStyle = accent;
			ctx.shadowColor = accent;
			ctx.shadowBlur = 6;
			ctx.lineWidth = 1.4;
			ctx.lineJoin = "round";
			ctx.beginPath();
			for (let i = 0; i <= points; i++) {
				const x = i / points;
				const y = mid - scopeSample(x, phase, levels, spikes, now) * amp;
				if (i === 0) ctx.moveTo(0, y);
				else ctx.lineTo(x * width, y);
			}
			ctx.stroke();
			ctx.restore();
		};

		const loop = (now: number) => {
			const dt = Math.min(now - last, 50);
			last = now;
			phase += dt / 1000;

			let moving = false;
			for (let k = 0; k < BANDS; k++) {
				const goal = isPlaying ? target[k] : 0;
				const tau = goal > levels[k] ? RISE_MS : FALL_MS;
				levels[k] += (goal - levels[k]) * (1 - Math.exp(-dt / tau));
				if (Math.abs(goal - levels[k]) > 0.003) moving = true;
			}

			// A sudden jump in the low bands adds a short spike somewhere along the trace.
			const energy = ((levels[0] ?? 0) + (levels[1] ?? 0)) / 2;
			if (isPlaying && energy - prevEnergy > 0.05 && spikes.length < 4) {
				spikes.push({
					x: 0.1 + Math.random() * 0.8,
					h: (Math.random() < 0.5 ? -1 : 1) * (0.45 + energy * 0.5),
					born: now
				});
			}
			prevEnergy = energy;
			while (spikes.length > 0 && now - spikes[0].born > SPIKE_MS) spikes.shift();

			draw(now);
			// Stop animating once paused and settled; the effect restarts when playback resumes.
			if (isPlaying || moving || spikes.length > 0) frame = requestAnimationFrame(loop);
		};

		readColors();
		resize();
		const observer = new ResizeObserver(() => {
			resize();
			draw(performance.now());
		});
		observer.observe(canvas);

		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		let unlisten: Promise<() => void> | null = null;
		if (isPlaying && !reduceMotion) {
			unlisten = listen<{ frequencies: number[] }>("audio-visualization", (event) => {
				const bands = event.payload.frequencies;
				for (let k = 0; k < BANDS; k++) {
					const v = bands[k] ?? 0;
					target[k] = v < 0 ? 0 : v > 1 ? 1 : v;
				}
			});
		}

		if (reduceMotion) draw(performance.now());
		else frame = requestAnimationFrame(loop);

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			unlisten?.then((fn) => fn());
		};
	}, [isPlaying]);

	return <canvas ref={canvasRef} className="mt-scope" aria-hidden />;
}
