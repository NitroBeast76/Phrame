// A made-up scope trace for the profile tab: a quiet line with a few bursts, like the waveform on a
// lab oscilloscope. It is drawn from a seed (user@host), so the same computer always gets the same
// one. Returns the points of an SVG polyline in a width x height box, the baseline at half height.
export function scopeTrace(seed: string, width = 600, height = 100, step = 4): string {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	let a = h >>> 0;
	const rand = () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const bursts = Array.from({ length: 5 }, () => ({
		at: rand() * width,
		spread: 28 + rand() * 48,
		power: 0.4 + rand() * 0.6
	}));
	const points: string[] = [];
	for (let x = 0; x <= width; x += step) {
		let swing = 0.05;
		for (const b of bursts) swing += b.power * Math.exp(-(((x - b.at) / b.spread) ** 2));
		const y = height / 2 - Math.min(swing, 1) * (rand() * 2 - 1) * (height / 2 - 4);
		points.push(`${x},${y.toFixed(1)}`);
	}
	return points.join(" ");
}
