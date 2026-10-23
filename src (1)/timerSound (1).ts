import { invoke } from "@tauri-apps/api/core";

// Timer completion sound. Plays either the built-in synthesized chime or a
// user-chosen audio file (stored by the backend), at an adjustable level.
//
// Volume is a 0-100 setting where 50 is "normal" (the original chime level and
// the custom file at its own level); above 50 boosts, below 50 attenuates.

export const NO_CUSTOM_SOUND = "none";
export const DEFAULT_TIMER_VOLUME = 50;
const MAX_CUSTOM_SECONDS = 20;

export const hasCustomTimerSound = (file: string | null | undefined): boolean =>
	!!file && file !== NO_CUSTOM_SOUND && file !== "0";

let audioCtx: AudioContext | null = null;
let customBuffer: AudioBuffer | null = null;
let customLoading: Promise<AudioBuffer | null> | null = null;

// Created on a user gesture (Start click / Preview click) so the webview's
// autoplay policy lets it play later when the timer ends.
export const getTimerChimeCtx = (): AudioContext | null => {
	try {
		if (!audioCtx) audioCtx = new AudioContext();
		if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
		return audioCtx;
	} catch {
		return null;
	}
};

export const clearCustomTimerSoundCache = () => {
	customBuffer = null;
	customLoading = null;
};

const loadCustomBuffer = (ctx: AudioContext): Promise<AudioBuffer | null> => {
	if (customBuffer) return Promise.resolve(customBuffer);
	if (!customLoading) {
		customLoading = (async () => {
			try {
				const b64 = await invoke<string | null>("read_timer_sound");
				if (!b64) return null;
				const bin = atob(b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const decoded = await ctx.decodeAudioData(bytes.buffer);
				customBuffer = decoded;
				return decoded;
			} catch (e) {
				console.error("Failed to load custom timer sound:", e);
				return null;
			} finally {
				customLoading = null;
			}
		})();
	}
	return customLoading;
};

// Decode the custom file ahead of time so it plays instantly when the timer ends.
export const preloadCustomTimerSound = () => {
	const ctx = getTimerChimeCtx();
	if (ctx) void loadCustomBuffer(ctx);
};

export const playChime = (ctx: AudioContext, level: number) => {
	const start = ctx.currentTime + 0.02;
	const master = ctx.createGain();
	master.gain.value = 0.45 * level;
	master.connect(ctx.destination);

	// Soft rising bell arpeggio (A5-C#6-E6) with a quiet octave harmonic.
	const notes = [
		{ freq: 880.0, at: 0 },
		{ freq: 1108.73, at: 0.18 },
		{ freq: 1318.51, at: 0.36 }
	];
	notes.forEach(({ freq, at }) => {
		const osc = ctx.createOscillator();
		const harmonic = ctx.createOscillator();
		const gain = ctx.createGain();
		const harmonicGain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		harmonic.type = "sine";
		harmonic.frequency.value = freq * 2.01;
		harmonicGain.gain.value = 0.12;
		gain.gain.setValueAtTime(0.0001, start + at);
		gain.gain.exponentialRampToValueAtTime(0.32, start + at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 1.4);
		osc.connect(gain);
		harmonic.connect(harmonicGain);
		harmonicGain.connect(gain);
		gain.connect(master);
		osc.start(start + at);
		harmonic.start(start + at);
		osc.stop(start + at + 1.5);
		harmonic.stop(start + at + 1.5);
	});
};

export const playTimerSound = async (volume: number, useCustom: boolean) => {
	const ctx = getTimerChimeCtx();
	if (!ctx) return;
	const level = Math.max(0, Math.min(100, volume)) / 50;
	if (level === 0) return;

	if (useCustom) {
		const buffer = await loadCustomBuffer(ctx);
		if (buffer) {
			const src = ctx.createBufferSource();
			src.buffer = buffer;
			const gain = ctx.createGain();
			const t0 = ctx.currentTime + 0.02;
			gain.gain.setValueAtTime(level, t0);
			const length = Math.min(buffer.duration, MAX_CUSTOM_SECONDS);
			if (buffer.duration > MAX_CUSTOM_SECONDS) {
				// Long file: cut it off with a short fade instead of a hard stop.
				gain.gain.setValueAtTime(level, t0 + length - 0.5);
				gain.gain.linearRampToValueAtTime(0, t0 + length);
			}
			src.connect(gain);
			gain.connect(ctx.destination);
			src.start(t0);
			src.stop(t0 + length);
			return;
		}
	}
	playChime(ctx, level);
};
