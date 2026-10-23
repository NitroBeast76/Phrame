// Sound for the time gun, played through the Web Audio API instead of <audio> elements.
// An <audio> element has to be created, decoded and buffered every time it is played, which put the hammer and cock
// sounds about 80 ms behind their animations (measured from a screen recording). Here each sound is fetched and decoded
// once, up front, so playing it is a single start() call with no startup delay.
//
// The fire crackle is a looping bed: it fades in when the timer is counting on the timer tab and fades out when it
// stops or the tab is left. The fades run on the audio clock, so they carry on after the component has unmounted.
//
// Volume: each sound has its own level from 0 to 1 (Settings > Notch > Time Gun Sounds). 1 is the loudest the sound can
// go without clipping: when a sound is decoded its highest peak is measured, and level 1 scales that peak to just under
// full scale. The level is also squared on the way in, so the slider feels even (volume is heard on a log scale). Every
// sound goes through a master limiter, so two sounds loud at once (the hit on top of the crackle) still cannot clip.
import hammerHitUrl from "./assets/sounds/hammer-hit.wav";
import gunCockUrl from "./assets/sounds/gun-cock.wav";
import fireLoopUrl from "./assets/sounds/fire-loop.wav";

export type TimeGunSoundKey = "hit" | "cock" | "fire";

/** The sounds that have a volume slider, in the order they are listed in settings. */
export const TIMEGUN_SOUNDS: { key: TimeGunSoundKey; label: string; desc: string }[] = [
	{ key: "hit", label: "Hammer Hit", desc: "The hammer landing on the cube when the timer starts" },
	{ key: "cock", label: "Hammer Cock", desc: "The hammer cocking back when the timer stops" },
	{ key: "fire", label: "Fire Crackle", desc: "The fire burning while the timer counts" }
];

const URLS: Record<TimeGunSoundKey, string> = {
	hit: hammerHitUrl,
	cock: gunCockUrl,
	fire: fireLoopUrl
};

// Defaults chosen to be as loud as these sounds were before they had sliders.
const DEFAULT_LEVEL: Record<TimeGunSoundKey, number> = { hit: 0.78, cock: 0.85, fire: 0.31 };
const STORAGE_KEY: Record<TimeGunSoundKey, string> = {
	hit: "bloom-timegun-volume-hit",
	cock: "bloom-timegun-volume-cock",
	fire: "bloom-timegun-volume-fire"
};
// Level 1 puts a sound's peak here (a little under full scale, to leave room for the converter).
const PEAK_CEILING = 0.97;
const MAX_NORMALISE_GAIN = 8;

// The hammer hit fades out smoothly at its end instead of running to the end of the clip.
// HIT_FADE_SECONDS is how long the fade lasts. HIT_MAX_SECONDS cuts the hit off after that many seconds (Infinity plays
// the whole clip); the fade then ends at that point, so a long tail can be trimmed without a click.
const HIT_FADE_SECONDS = 0.3;
const HIT_MAX_SECONDS = Infinity;

const levels: Record<TimeGunSoundKey, number> = { ...DEFAULT_LEVEL };
for (const key of Object.keys(STORAGE_KEY) as TimeGunSoundKey[]) {
	try {
		const raw = localStorage.getItem(STORAGE_KEY[key]);
		const v = raw === null ? NaN : Number.parseFloat(raw);
		if (Number.isFinite(v)) levels[key] = Math.min(1, Math.max(0, v));
	} catch {
		/* storage unavailable */
	}
}

/** The level (0 to 1) of a sound, as the slider shows it. */
export function getTimeGunVolume(key: TimeGunSoundKey): number {
	return levels[key];
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers: Partial<Record<TimeGunSoundKey, AudioBuffer>> = {};
const peakGain: Partial<Record<TimeGunSoundKey, number>> = {};
const pending: Partial<Record<TimeGunSoundKey, Promise<AudioBuffer | null>>> = {};

// The actual gain for a sound: the squared level, scaled so level 1 puts the sound's peak at the ceiling.
// Until the sound is decoded its peak is unknown, and nothing can be playing then anyway.
function gainFor(key: TimeGunSoundKey): number {
	return levels[key] * levels[key] * (peakGain[key] ?? 1);
}

function context(): AudioContext | null {
	if (ctx) return ctx;
	const Ctor =
		window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;
	try {
		ctx = new Ctor({ latencyHint: "interactive" });
		// Everything plays through one limiter, so overlapping sounds cannot add up past full scale.
		master = ctx.createGain();
		const limiter = ctx.createDynamicsCompressor();
		limiter.threshold.value = -1.5;
		limiter.knee.value = 0;
		limiter.ratio.value = 20;
		limiter.attack.value = 0.002;
		limiter.release.value = 0.12;
		master.connect(limiter).connect(ctx.destination);
	} catch {
		ctx = null;
		master = null;
		return null;
	}
	return ctx;
}

// Browsers keep an audio context suspended until the page has had a click or key press. This wakes it.
function wake(): AudioContext | null {
	const c = context();
	if (c && c.state !== "running") void c.resume().catch(() => {});
	return c;
}

function peakOf(buf: AudioBuffer): number {
	let peak = 0;
	for (let ch = 0; ch < buf.numberOfChannels; ch++) {
		const data = buf.getChannelData(ch);
		for (let i = 0; i < data.length; i++) {
			const v = Math.abs(data[i]);
			if (v > peak) peak = v;
		}
	}
	return peak;
}

function load(name: TimeGunSoundKey): Promise<AudioBuffer | null> {
	const have = buffers[name];
	if (have) return Promise.resolve(have);
	const c = context();
	if (!c) return Promise.resolve(null);
	let p = pending[name];
	if (!p) {
		p = fetch(URLS[name])
			.then((r) => r.arrayBuffer())
			.then((data) => c.decodeAudioData(data))
			.then((buf) => {
				const peak = peakOf(buf);
				peakGain[name] = peak > 0 ? Math.min(MAX_NORMALISE_GAIN, PEAK_CEILING / peak) : 1;
				buffers[name] = buf;
				return buf;
			})
			.catch(() => {
				delete pending[name];
				return null;
			});
		pending[name] = p;
	}
	return p;
}

let unlockBound = false;

/** Fetch and decode every sound now, and wake the audio context on the first click or key press. Safe to call often. */
export function preloadTimeGunSounds() {
	if (!unlockBound) {
		unlockBound = true;
		const unlock = () => {
			wake();
		};
		window.addEventListener("pointerdown", unlock, true);
		window.addEventListener("keydown", unlock, true);
	}
	void load("hit");
	void load("cock");
	void load("fire");
}

function playOnce(name: "hit" | "cock", fade?: { seconds: number; maxSeconds: number }) {
	const c = wake();
	if (!c || !master) return;
	const out = master;
	const go = (buf: AudioBuffer) => {
		const src = c.createBufferSource();
		src.buffer = buf;
		const gain = c.createGain();
		const level = gainFor(name);
		gain.gain.value = level;
		src.connect(gain).connect(out);
		const now = c.currentTime;
		src.start(now);
		if (fade) {
			// A smooth (cosine-shaped) fade to silence that ends where the sound ends, or at maxSeconds if that is sooner.
			const end = Math.min(buf.duration, fade.maxSeconds);
			const length = Math.min(fade.seconds, end);
			if (length > 0) {
				const points = 48;
				const curve = new Float32Array(points);
				for (let i = 0; i < points; i++) curve[i] = level * 0.5 * (1 + Math.cos((Math.PI * i) / (points - 1)));
				gain.gain.setValueCurveAtTime(curve, now + end - length, length);
				src.stop(now + end + 0.02);
			}
		}
	};
	const buf = buffers[name];
	if (buf) go(buf);
	else void load(name).then((b) => b && go(b));
}

/** The hammer landing on the cube. */
export function playHit() {
	playOnce("hit", { seconds: HIT_FADE_SECONDS, maxSeconds: HIT_MAX_SECONDS });
}

/** The hammer cocking back. */
export function playCock() {
	playOnce("cock");
}

interface Fire {
	src: AudioBufferSourceNode;
	gain: GainNode;
	stopTimer: number | null;
}

let fire: Fire | null = null;
let fireWanted = false;

/** Start the crackle (or bring it back if it is fading out), fading in over fadeIn seconds. */
export function startFire(fadeIn: number) {
	fireWanted = true;
	const c = wake();
	if (!c || !master) return;
	const out = master;
	const begin = (buf: AudioBuffer) => {
		if (!fireWanted) return;
		const now = c.currentTime;
		if (fire) {
			// Already playing, or fading out: ramp it back up instead of starting a second one.
			if (fire.stopTimer !== null) {
				window.clearTimeout(fire.stopTimer);
				fire.stopTimer = null;
			}
			const g = fire.gain.gain;
			g.cancelScheduledValues(now);
			g.setValueAtTime(g.value, now);
			g.linearRampToValueAtTime(gainFor("fire"), now + fadeIn);
			return;
		}
		const src = c.createBufferSource();
		src.buffer = buf;
		src.loop = true;
		const gain = c.createGain();
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(gainFor("fire"), now + fadeIn);
		src.connect(gain).connect(out);
		// Start somewhere in the loop so each session crackles differently.
		src.start(0, Math.random() * buf.duration);
		fire = { src, gain, stopTimer: null };
	};
	const buf = buffers.fire;
	if (buf) begin(buf);
	else void load("fire").then((b) => b && begin(b));
}

/** Fade the crackle out over fadeOut seconds, then stop it. */
export function stopFire(fadeOut: number) {
	fireWanted = false;
	const f = fire;
	const c = ctx;
	if (!f || !c || f.stopTimer !== null) return;
	const now = c.currentTime;
	const g = f.gain.gain;
	g.cancelScheduledValues(now);
	g.setValueAtTime(g.value, now);
	g.linearRampToValueAtTime(0, now + fadeOut);
	f.stopTimer = window.setTimeout(() => {
		try {
			f.src.stop();
		} catch {
			/* already stopped */
		}
		f.src.disconnect();
		f.gain.disconnect();
		if (fire === f) fire = null;
	}, fadeOut * 1000 + 60);
}

let previewTimer: number | null = null;

/** Change a sound's level (0 to 1) and remember it. A crackle that is burning right now follows the change at once. */
export function setTimeGunVolume(key: TimeGunSoundKey, level: number) {
	const v = Math.min(1, Math.max(0, level));
	levels[key] = v;
	try {
		localStorage.setItem(STORAGE_KEY[key], String(v));
	} catch {
		/* storage unavailable */
	}
	if (key === "fire" && fire && fire.stopTimer === null && ctx) {
		const g = fire.gain.gain;
		const now = ctx.currentTime;
		g.cancelScheduledValues(now);
		g.setValueAtTime(g.value, now);
		g.linearRampToValueAtTime(gainFor("fire"), now + 0.06);
	}
}

/** Play a sound once at its current level, so the slider can be judged by ear. The crackle plays for about a second. */
export function previewTimeGunSound(key: TimeGunSoundKey) {
	if (key === "hit") return playHit();
	if (key === "cock") return playCock();
	// The real fire is already burning: its slider is heard live, so there is nothing to preview.
	if (fireWanted && previewTimer === null) return;
	if (previewTimer !== null) window.clearTimeout(previewTimer);
	startFire(0.15);
	previewTimer = window.setTimeout(() => {
		previewTimer = null;
		stopFire(0.4);
	}, 1100);
}
