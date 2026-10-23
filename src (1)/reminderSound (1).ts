import { invoke } from "@tauri-apps/api/core";
import { getTimerChimeCtx, playChime } from "./timerSound";

// Sounds for the task reminder, the calendar reminder, task completion and a
// card snapping into place on the tasks board. Each can
// have its own custom audio file (stored by the backend); with none set, a built-in
// sound plays (the timer's chime, or a short blip for completing a task). Volume
// is 0-100 where 50 is "normal", like the timer.

export type ReminderKind = "task" | "calendar" | "complete" | "snap";

export const DEFAULT_REMINDER_VOLUME = 50;
const MAX_CUSTOM_SECONDS = 20;
// The snap sound fires on every card drop, so a custom file is cut short.
const MAX_SNAP_SECONDS = 2.5;

const buffers: Partial<Record<ReminderKind, AudioBuffer>> = {};
const loading: Partial<Record<ReminderKind, Promise<AudioBuffer | null>>> = {};
// Bumped whenever a sound is replaced or removed, so a decode that was still
// running for the old file can't be cached as the new one.
const generation: Record<ReminderKind, number> = { task: 0, calendar: 0, complete: 0, snap: 0 };

export const clearCustomReminderSoundCache = (kind: ReminderKind) => {
	generation[kind]++;
	delete buffers[kind];
	delete loading[kind];
};

const loadCustomBuffer = (kind: ReminderKind, ctx: AudioContext): Promise<AudioBuffer | null> => {
	const cached = buffers[kind];
	if (cached) return Promise.resolve(cached);
	const pending = loading[kind];
	if (pending) return pending;

	const gen = generation[kind];
	const job = (async () => {
		try {
			const b64 = await invoke<string | null>("read_reminder_sound", { kind });
			if (!b64) return null;
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const decoded = await ctx.decodeAudioData(bytes.buffer);
			if (gen === generation[kind]) buffers[kind] = decoded;
			return decoded;
		} catch (e) {
			console.error(`Failed to load ${kind} reminder sound:`, e);
			return null;
		} finally {
			if (gen === generation[kind]) delete loading[kind];
		}
	})();
	loading[kind] = job;
	return job;
};

// Decode the custom file ahead of time so it plays instantly when the reminder fires.
// Short two-note "ding" for checking a task off.
const playCompleteBlip = (ctx: AudioContext, level: number) => {
	const start = ctx.currentTime + 0.02;
	const master = ctx.createGain();
	master.gain.value = 0.4 * level;
	master.connect(ctx.destination);
	[
		{ freq: 987.77, at: 0 },
		{ freq: 1479.98, at: 0.09 }
	].forEach(({ freq, at }) => {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		gain.gain.setValueAtTime(0.0001, start + at);
		gain.gain.exponentialRampToValueAtTime(0.35, start + at + 0.012);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.38);
		osc.connect(gain);
		gain.connect(master);
		osc.start(start + at);
		osc.stop(start + at + 0.4);
	});
};

// Soft wooden "tock" for a card settling into its slot: a short low thump plus
// a quick filtered noise tick.
const playSnapTock = (ctx: AudioContext, level: number) => {
	const start = ctx.currentTime + 0.01;
	const master = ctx.createGain();
	master.gain.value = 0.5 * level;
	master.connect(ctx.destination);

	const osc = ctx.createOscillator();
	const og = ctx.createGain();
	osc.type = "sine";
	osc.frequency.setValueAtTime(320, start);
	osc.frequency.exponentialRampToValueAtTime(140, start + 0.09);
	og.gain.setValueAtTime(0.0001, start);
	og.gain.exponentialRampToValueAtTime(0.7, start + 0.004);
	og.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
	osc.connect(og);
	og.connect(master);
	osc.start(start);
	osc.stop(start + 0.14);

	const len = Math.floor(ctx.sampleRate * 0.03);
	const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
	const data = noiseBuf.getChannelData(0);
	for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
	const noise = ctx.createBufferSource();
	noise.buffer = noiseBuf;
	const filter = ctx.createBiquadFilter();
	filter.type = "bandpass";
	filter.frequency.value = 1800;
	filter.Q.value = 0.9;
	const ng = ctx.createGain();
	ng.gain.value = 0.25;
	noise.connect(filter);
	filter.connect(ng);
	ng.connect(master);
	noise.start(start);
};

// The previous snap sound still playing, so quick drops don't pile up.
let lastSnapGain: GainNode | null = null;

export const preloadCustomReminderSound = (kind: ReminderKind) => {
	const ctx = getTimerChimeCtx();
	if (ctx) void loadCustomBuffer(kind, ctx);
};

export const playReminderSound = async (
	kind: ReminderKind,
	volume: number,
	useCustom: boolean
) => {
	const ctx = getTimerChimeCtx();
	if (!ctx) return;
	const level = Math.max(0, Math.min(100, volume)) / 50;
	if (level === 0) return;

	if (useCustom) {
		const buffer = await loadCustomBuffer(kind, ctx);
		if (buffer) {
			const src = ctx.createBufferSource();
			src.buffer = buffer;
			const gain = ctx.createGain();
			const t0 = ctx.currentTime + 0.02;
			gain.gain.setValueAtTime(level, t0);
			const maxSeconds = kind === "snap" ? MAX_SNAP_SECONDS : MAX_CUSTOM_SECONDS;
			const length = Math.min(buffer.duration, maxSeconds);
			if (buffer.duration > maxSeconds) {
				// Long file: cut it off with a short fade instead of a hard stop.
				const fade = Math.min(0.5, length / 2);
				gain.gain.setValueAtTime(level, t0 + length - fade);
				gain.gain.linearRampToValueAtTime(0, t0 + length);
			}
			if (kind === "snap") {
				// A new drop replaces the previous snap sound.
				if (lastSnapGain) {
					try {
						lastSnapGain.gain.cancelScheduledValues(ctx.currentTime);
						lastSnapGain.gain.setValueAtTime(lastSnapGain.gain.value, ctx.currentTime);
						lastSnapGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
					} catch {
						/* already finished */
					}
				}
				lastSnapGain = gain;
			}
			src.connect(gain);
			gain.connect(ctx.destination);
			src.start(t0);
			src.stop(t0 + length);
			return;
		}
	}
	if (kind === "complete") playCompleteBlip(ctx, level);
	else if (kind === "snap") playSnapTock(ctx, level);
	else playChime(ctx, level);
};
