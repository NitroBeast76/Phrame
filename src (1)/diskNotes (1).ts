// Fidget toy: every time you press the album disk on the dashboard's now-playing card, a music note
// pops out of it, drifts up and sideways, and fades. Press fast and they pile up.
//
// It listens on the whole document (pointerdown, so it fires the instant you press) and picks out
// presses on `.dash-card.dash-media .dash-art`, so it does not need any change to Dashboard.tsx.
// Notes are added to the disk's offset parent (the card) and placed with offsetLeft/offsetTop, which
// do not depend on how the notch is scaled. It installs itself when this file is imported.
import "./DiskNotes.css";

const DISK_SELECTOR = ".dash-card.dash-media .dash-art";
const MAX_NOTES = 24; // at most this many on screen; the oldest goes first

// Lucide's "music-2" (one note) and "music" (two notes), drawn as outlines in the accent colour.
const NOTE_SVGS = [
	'<svg viewBox="0 0 24 24"><circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/></svg>',
	'<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
];

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function spawnNote(art: HTMLElement) {
	const host = art.offsetParent as HTMLElement | null;
	if (!host) return;

	// Keep the pile small so mashing the disk never gets heavy.
	const old = host.querySelectorAll(":scope > .dn-note");
	if (old.length >= MAX_NOTES) old[0].remove();

	const note = document.createElement("span");
	note.className = "dn-note";
	note.setAttribute("aria-hidden", "true");
	note.innerHTML = NOTE_SVGS[Math.random() < 0.5 ? 0 : 1];
	// Starts on the upper part of the disk, a little off centre each time.
	note.style.left = `${art.offsetLeft + art.offsetWidth / 2 + rand(-art.offsetWidth * 0.18, art.offsetWidth * 0.18)}px`;
	note.style.top = `${art.offsetTop + art.offsetHeight * 0.3}px`;
	host.appendChild(note);

	// Leans the way it drifts, so it reads as floating off the disk.
	const drift = rand(-46, 46);
	const rise = rand(46, 74);
	const turn = drift * 0.6 + rand(-12, 12);
	const size = rand(0.85, 1.25);
	const animation = note.animate(
		[
			{ opacity: 0, transform: `translate(0px, 6px) scale(${size * 0.4}) rotate(0deg)` },
			{
				opacity: 1,
				transform: `translate(${drift * 0.25}px, ${-rise * 0.25}px) scale(${size}) rotate(${turn * 0.3}deg)`,
				offset: 0.18
			},
			{
				opacity: 0,
				transform: `translate(${drift}px, ${-rise}px) scale(${size * 1.1}) rotate(${turn}deg)`
			}
		],
		{ duration: rand(900, 1400), easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" }
	);
	animation.onfinish = () => note.remove();
	animation.oncancel = () => note.remove();
}

function onPointerDown(event: PointerEvent) {
	if (event.button !== 0) return;
	const target = event.target;
	if (!(target instanceof Element)) return;
	const art = target.closest<HTMLElement>(DISK_SELECTOR);
	if (art) spawnNote(art);
}

if (typeof document !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
	// Capture phase, so nothing on the card that stops the event can swallow the press.
	document.addEventListener("pointerdown", onPointerDown, true);
}
