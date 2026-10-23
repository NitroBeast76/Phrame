import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { BellRing, Check, GripVertical, ListChecks, Pin, Plus, Tag, X } from "lucide-react";
import "./TaskBoard.css";
import "./TaskBoardHead.css";

// Kanban-style tasks board: Open / In progress / Done. Cards can be dragged
// between columns and reordered; the card lifts and tilts while held, the other
// cards slide out of the way, and it settles into its slot on release. The
// card trails the cursor a little and glides home, and cards ease aside rather
// than jump. Finishing a task plays a short tick-and-sparkle animation.
//
// Dragging is pointer-based (not HTML5 drag and drop) so it works under the
// notch's CSS zoom on any monitor: all positions are converted to layout pixels
// with a zoom factor measured at drag start.

export type TaskStatus = "open" | "progress" | "done";

export interface QuickTask {
	id: string;
	text: string;
	done: boolean;
	status: TaskStatus;
	// 1 = low, 2 = medium, 3 = high.
	priority: number;
	// Optional reminder time (epoch ms) and whether it already fired.
	remindAt?: number;
	notified?: boolean;
	// Group name. Absent means the task is ungrouped and sorts under "No group".
	group?: string;
	// Pinned tasks sort to the top of their column and are marked with a pin.
	pinned?: boolean;
	// Free-form note added in the full editor.
	notes?: string;
}

const COLUMNS: { id: TaskStatus; label: string }[] = [
	{ id: "open", label: "Open" },
	{ id: "progress", label: "In progress" },
	{ id: "done", label: "Done" }
];

const PRIORITY_LABEL = ["", "Low", "Medium", "High"];
// Longest allowed group name and note, mirroring the task text limit.
const GROUP_MAX_LENGTH = 24;
const NOTES_MAX_LENGTH = 500;
// Column order when grouping is on. Ungrouped tasks come last.
const NO_GROUP = "";
const LIST_GAP = 6;
// Motion tuning. Higher FOLLOW = card keeps up with the cursor more tightly.
const FOLLOW = 0.24;
const SLIDE_MS = 300;
const SLIDE_EASE = "cubic-bezier(0.3, 0.1, 0.12, 1)";
// Landing: the card starts gliding home the instant it is released, with a plain
// ease-out (no bounce, no waiting) while the other cards slide at the same time.
// The card presses in slightly just before it arrives and the column it lands in
// pulses, all starting at the moment of release.
// Starts moving at once but eases out over a long, soft tail.
const SETTLE_MS = 380;
const SETTLE_EASE = "cubic-bezier(0.3, 0.1, 0.12, 1)";
const PRESS_EASE = "cubic-bezier(0.35, 0, 0.2, 1)";
const PULSE_MS = 480;
const LIFT_SCALE = 1.02;
const DONE_MS = 1100;
const SLOT_TICK_GAP_MS = 90;

const formatScheduled = (ms: number): string => {
	const d = new Date(ms);
	const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	// 24-hour clock ("hourCycle" is newer than some TS lib targets, hence the cast).
	const timeOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as Intl.DateTimeFormatOptions;
	const time = d.toLocaleTimeString(undefined, timeOptions);
	return `${day} ${time}`;
};

// Position of an element inside the board in layout pixels, ignoring any
// transform in flight (used for sliding cards and for settling the dragged one).
const contentPos = (el: HTMLElement) => {
	const list = el.closest<HTMLElement>(".tb-list");
	const col = el.closest<HTMLElement>(".tb-col");
	if (!list || !col) return { x: 0, y: 0 };
	return {
		x: col.offsetLeft + list.offsetLeft + el.offsetLeft,
		y: col.offsetTop + list.offsetTop + el.offsetTop
	};
};

interface DragView {
	id: string;
	status: TaskStatus;
	index: number;
	w: number;
	h: number;
}

interface DragRuntime {
	id: string;
	pointerId: number;
	el: HTMLElement;
	startX: number;
	startY: number;
	active: boolean;
	settling: boolean;
	k: number;
	gx: number;
	gy: number;
	x: number;
	y: number;
	// Where the cursor wants the card; x / y chase it a little behind.
	tx: number;
	ty: number;
	w: number;
	h: number;
	tilt: number;
	tiltTarget: number;
	scale: number;
	lastClientX: number;
	raf: number;
}

interface TaskBoardProps {
	tasks: QuickTask[];
	onChange: (change: (prev: QuickTask[]) => QuickTask[]) => void;
	draft: string;
	onDraftChange: (value: string) => void;
	time: string;
	onTimeChange: (value: string) => void;
	composer: TaskStatus | null;
	onComposerChange: (status: TaskStatus | null) => void;
	onAdd: (status: TaskStatus) => void;
	onComplete: () => void;
	// A dragged card moved over a different slot (plays the snap sound, rate-limited).
	onSlotChange?: () => void;
	maxLength: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Sort for display inside a column: pinned first, then by priority (high first),
// then by the stored order. Sorting is stable so dragging still reorders within
// an equal-priority run.
const sortForDisplay = (list: QuickTask[]): QuickTask[] =>
	list
		.map((t, i) => ({ t, i }))
		.sort((a, b) => {
			const pin = Number(!!b.t.pinned) - Number(!!a.t.pinned);
			if (pin !== 0) return pin;
			const pri = (b.t.priority || 2) - (a.t.priority || 2);
			if (pri !== 0) return pri;
			return a.i - b.i;
		})
		.map((x) => x.t);

const groupLabel = (g: string) => (g === NO_GROUP ? "No group" : g);

const ghostTransform = (d: DragRuntime) =>
	`translate3d(${d.x}px, ${d.y}px, 0) rotate(${d.tilt}deg) scale(${d.scale})`;

export default function TaskBoard({
	tasks,
	onChange,
	draft,
	onDraftChange,
	time,
	onTimeChange,
	composer,
	onComposerChange,
	onAdd,
	onComplete,
	onSlotChange,
	maxLength
}: TaskBoardProps) {
	const boardRef = useRef<HTMLDivElement>(null);
	const ghostRef = useRef<HTMLDivElement>(null);
	const addInputRef = useRef<HTMLInputElement>(null);
	const dragRef = useRef<DragRuntime | null>(null);
	const targetRef = useRef<{ status: TaskStatus; index: number } | null>(null);
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;
	const [drag, setDrag] = useState<DragView | null>(null);
	// Id of the card that was just dropped and is still flying to its slot. The
	// move is already committed, so the real card sits (hidden) in its new slot
	// and the dragged copy lands on it.
	const [landing, setLanding] = useState<string | null>(null);
	const ghostTaskRef = useRef<QuickTask | undefined>(undefined);
	// Column that just received a card; it pulses briefly.
	const [pulseCol, setPulseCol] = useState<TaskStatus | null>(null);
	const pulseTimer = useRef<number>(0);
	useEffect(() => () => window.clearTimeout(pulseTimer.current), []);
	const [now, setNow] = useState(() => Date.now());
	// Full editor: the id of the task being edited at full size, opened by
	// right-click, plus its working copy. Nothing is written until Save.
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState<{
		text: string;
		notes: string;
		group: string;
		priority: number;
		status: TaskStatus;
		pinned: boolean;
	} | null>(null);
	const editTextRef = useRef<HTMLTextAreaElement>(null);
	// Grouping is a view option, remembered across sessions.
	const [grouped, setGrouped] = useState(
		() => localStorage.getItem("bloom-tasks-grouped") === "true"
	);
	// Tasks that were just finished; they play the "done" animation for a moment.
	const [justDone, setJustDone] = useState<ReadonlySet<string>>(() => new Set());
	const doneTimers = useRef<number[]>([]);
	const lastSlotTickRef = useRef(0);
	const onSlotChangeRef = useRef(onSlotChange);
	onSlotChangeRef.current = onSlotChange;

	useEffect(() => {
		const timers = doneTimers.current;
		return () => timers.forEach((t) => window.clearTimeout(t));
	}, []);

	const celebrate = (id: string) => {
		setJustDone((prev) => new Set(prev).add(id));
		const t = window.setTimeout(() => {
			setJustDone((prev) => {
				if (!prev.has(id)) return prev;
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		}, DONE_MS);
		doneTimers.current.push(t);
	};

	// Refresh the "(past)" markers while the board is open.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 30000);
		return () => clearInterval(id);
	}, []);

	// Slide cards to their new places whenever the layout changes (reorder,
	// move between columns, check off, add, delete).
	const prevPos = useRef<Map<string, { x: number; y: number }>>(new Map());
	// Cards only slide when something was actually done to the board (a drag, a move,
	// an add, a delete, an edit). A change of layout on its own (the notch growing, the
	// text re-wrapping, a timer re-render) just updates the remembered positions.
	const flipSigRef = useRef("");
	const flipWidthRef = useRef(0);
	const flipMountRef = useRef(performance.now());
	useLayoutEffect(() => {
		const board = boardRef.current;
		if (!board) return;
		const sig =
			tasks
				.map((t) => `${t.id}:${t.status}:${t.priority}:${t.pinned ? 1 : 0}:${t.group ?? ""}:${t.text}`)
				.join("|") + `#${drag ? `${drag.status}:${drag.index}` : ""}:${landing ?? ""}:${grouped ? 1 : 0}`;
		const userChange = sig !== flipSigRef.current;
		const width = board.offsetWidth;
		const resized = Math.abs(width - flipWidthRef.current) > 0.5;
		const settled = performance.now() - flipMountRef.current > 400;
		flipSigRef.current = sig;
		flipWidthRef.current = width;
		const slideAllowed = userChange && !resized && settled;
		const next = new Map<string, { x: number; y: number }>();
		board.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
			const key = el.dataset.flip as string;
			const p = contentPos(el);
			next.set(key, p);
			const old = prevPos.current.get(key);
			if (
				!slideAllowed ||
				!old ||
				(Math.abs(old.x - p.x) <= 0.5 && Math.abs(old.y - p.y) <= 0.5)
			)
				return;
			// If an earlier slide is still running, carry on from where the card is
			// drawn right now instead of jumping back to its old slot first.
			let ox = 0;
			let oy = 0;
			el.getAnimations()
				.filter((a) => a.id === "tb-slide")
				.forEach((a) => {
					if (ox === 0 && oy === 0) {
						const m = new DOMMatrix(getComputedStyle(el).transform);
						ox = m.m41;
						oy = m.m42;
					}
					a.cancel();
				});
			const slide = el.animate(
				[
					{ transform: `translate(${old.x - p.x + ox}px, ${old.y - p.y + oy}px)` },
					{ transform: "translate(0, 0)" }
				],
				{ duration: SLIDE_MS, easing: SLIDE_EASE }
			);
			slide.id = "tb-slide";
		});
		prevPos.current = next;
	});

	// Put the ghost under the cursor before its first paint.
	useLayoutEffect(() => {
		const d = dragRef.current;
		if (drag && d && ghostRef.current) ghostRef.current.style.transform = ghostTransform(d);
	}, [drag?.id]); // eslint-disable-line react-hooks/exhaustive-deps

	// A task finished by dragging it into Done: its tick animation and sound wait
	// until the dragged card has landed, so they start together with the circle.
	const pendingDoneRef = useRef<string | null>(null);

	const moveTask = (id: string, status: TaskStatus, index: number, afterLanding = false) => {
		const cur = tasksRef.current.find((t) => t.id === id);
		if (!cur) return;
		const column = tasksRef.current.filter((t) => t.status === status && t.id !== id);
		const oldIndex = tasksRef.current
			.filter((t) => t.status === cur.status)
			.findIndex((t) => t.id === id);
		const targetIndex = Math.min(index, column.length);
		if (cur.status === status && oldIndex === targetIndex) return;
		const completing = status === "done" && cur.status !== "done";
		onChange((prev) => {
			const task = prev.find((t) => t.id === id);
			if (!task) return prev;
			const rest = prev.filter((t) => t.id !== id);
			const col = rest.filter((t) => t.status === status);
			const moved: QuickTask = { ...task, status, done: status === "done" };
			let at: number;
			if (targetIndex < col.length) at = rest.indexOf(col[targetIndex]);
			else if (col.length) at = rest.indexOf(col[col.length - 1]) + 1;
			else at = rest.length;
			return [...rest.slice(0, at), moved, ...rest.slice(at)];
		});
		if (completing) {
			if (afterLanding) {
				pendingDoneRef.current = id;
			} else {
				celebrate(id);
				onComplete();
			}
		}
	};

	const lastTickRef = useRef(0);
	const tick = useCallback((time: number) => {
		const d = dragRef.current;
		if (!d || !d.active || d.settling) return;
		// Scale every step by the real frame time so the card feels the same on
		// 60, 120 and 144 Hz screens (and doesn't stutter when a frame is late).
		const dt = lastTickRef.current ? Math.min(time - lastTickRef.current, 50) : 16.7;
		lastTickRef.current = time;
		const f = dt / 16.7;
		const ease = (rate: number) => 1 - Math.pow(1 - rate, f);
		d.x += (d.tx - d.x) * ease(FOLLOW);
		d.y += (d.ty - d.y) * ease(FOLLOW);
		d.tilt += (d.tiltTarget - d.tilt) * ease(0.2);
		d.tiltTarget *= Math.pow(0.92, f);
		d.scale += (LIFT_SCALE - d.scale) * ease(0.25);
		if (ghostRef.current) ghostRef.current.style.transform = ghostTransform(d);
		d.raf = requestAnimationFrame(tick);
	}, []);

	const finish = (drop: boolean) => {
		const d = dragRef.current;
		if (!d || d.settling) return;
		window.removeEventListener("keydown", onKeyRef.current);
		window.removeEventListener("blur", onBlurRef.current);
		cancelAnimationFrame(d.raf);
		if (!d.active) {
			dragRef.current = null;
			return;
		}
		const target = targetRef.current;
		const release = () => {
			try {
				boardRef.current?.releasePointerCapture(d.pointerId);
			} catch {
				/* already released */
			}
		};
		if (!drop || !target) {
			dragRef.current = null;
			targetRef.current = null;
			release();
			setDrag(null);
			return;
		}
		d.settling = true;
		targetRef.current = null;
		release();
		if (!ghostRef.current) {
			dragRef.current = null;
			moveTask(d.id, target.status, target.index);
			setDrag(null);
			return;
		}
		// Commit the move now: the other cards start sliding into their final
		// places while the dragged copy flies to the real card's slot.
		pendingDoneRef.current = null;
		setLanding(d.id);
		window.clearTimeout(pulseTimer.current);
		setPulseCol(null);
		requestAnimationFrame(() => setPulseCol(target.status));
		pulseTimer.current = window.setTimeout(() => setPulseCol(null), PULSE_MS + 40);
		moveTask(d.id, target.status, target.index, true);
	};

	const endLanding = () => {
		dragRef.current = null;
		setDrag(null);
		setLanding(null);
		// The card is now visible in Done: start its tick animation and sound together.
		const done = pendingDoneRef.current;
		pendingDoneRef.current = null;
		if (done) {
			celebrate(done);
			onComplete();
		}
	};
	const endLandingRef = useRef(endLanding);
	endLandingRef.current = endLanding;

	// Fly the dragged copy onto the (hidden) real card once it has been laid out.
	useLayoutEffect(() => {
		if (!landing) return;
		const ghost = ghostRef.current;
		const board = boardRef.current;
		if (!ghost || !board) {
				endLandingRef.current();
				return;
			}
			const target = board.querySelector<HTMLElement>(`[data-task-id="${landing}"]`);
		if (!target) {
			endLandingRef.current();
			return;
		}
		// Measure the real card exactly (offsetLeft/Top round to whole pixels, which
		// would leave the dragged copy up to half a pixel off when the notch is zoomed).
		const br = board.getBoundingClientRect();
		const k = board.offsetWidth ? br.width / board.offsetWidth : 1;
		const tr = target.getBoundingClientRect();
		const p = { x: (tr.left - br.left) / k, y: (tr.top - br.top) / k };
		const at = (scale: number) => `translate3d(${p.x}px, ${p.y}px, 0) rotate(0deg) scale(${scale})`;
		const anim = ghost.animate(
			[
				{ transform: ghost.style.transform, easing: SETTLE_EASE },
				{
					// Arrives pressed in a touch, with the lift (shadow, outline) gone.
					offset: 0.78,
					transform: at(0.965),
					boxShadow:
						"0 0 0 1px rgba(255, 255, 255, 0), 0 0 0 rgba(0, 0, 0, 0), 0 0 0 rgba(0, 0, 0, 0)",
					backgroundColor: "rgba(0, 0, 0, 0)",
					easing: PRESS_EASE
				},
				{
					transform: at(1),
					boxShadow:
						"0 0 0 1px rgba(255, 255, 255, 0), 0 0 0 rgba(0, 0, 0, 0), 0 0 0 rgba(0, 0, 0, 0)",
					backgroundColor: "rgba(0, 0, 0, 0)"
				}
			],
			{ duration: SETTLE_MS, fill: "forwards" }
		);
		anim.onfinish = () => endLandingRef.current();
		anim.oncancel = () => endLandingRef.current();
	}, [landing]);
	const finishRef = useRef(finish);
	finishRef.current = finish;
	const onKeyRef = useRef((e: KeyboardEvent) => {
		if (e.key === "Escape") finishRef.current(false);
	});
	const onBlurRef = useRef(() => finishRef.current(false));

	// Leaving the tasks view mid-drag drops the press without moving anything.
	useEffect(() => {
		return () => {
			const d = dragRef.current;
			if (d) cancelAnimationFrame(d.raf);
			window.removeEventListener("keydown", onKeyRef.current);
			window.removeEventListener("blur", onBlurRef.current);
		};
	}, []);

	const beginPress = (e: ReactPointerEvent<HTMLElement>, id: string) => {
		if (e.button !== 0) return;
		const existing = dragRef.current;
		if (existing && (existing.active || existing.settling)) return;
		if ((e.target as HTMLElement).closest("button, input")) return;
		dragRef.current = {
			id,
			pointerId: e.pointerId,
			el: e.currentTarget,
			startX: e.clientX,
			startY: e.clientY,
			active: false,
			settling: false,
			k: 1,
			gx: 0,
			gy: 0,
			x: 0,
			y: 0,
			tx: 0,
			ty: 0,
			w: 0,
			h: 0,
			tilt: 0,
			tiltTarget: 0,
			scale: 1,
			lastClientX: e.clientX,
			raf: 0
		};
	};

	const handleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		const board = boardRef.current;
		if (!d || !board || d.settling || e.pointerId !== d.pointerId) return;
		// The button was released while the window could not see it (for example
		// the cursor left the notch): treat it as a drop.
		if (e.buttons === 0) {
			finish(d.active);
			return;
		}

		if (!d.active) {
			if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
			const task = tasksRef.current.find((t) => t.id === d.id);
			if (!task) {
				dragRef.current = null;
				return;
			}
			const br = board.getBoundingClientRect();
			const k = board.offsetWidth ? br.width / board.offsetWidth : 1;
			const cr = d.el.getBoundingClientRect();
			d.k = k || 1;
			d.gx = (d.startX - cr.left) / d.k;
			d.gy = (d.startY - cr.top) / d.k;
			d.x = (cr.left - br.left) / d.k;
			d.y = (cr.top - br.top) / d.k;
			d.tx = d.x;
			d.ty = d.y;
			d.w = cr.width / d.k;
			d.h = cr.height / d.k;
			d.active = true;
			d.lastClientX = e.clientX;
			const index = tasksRef.current
				.filter((t) => t.status === task.status)
				.findIndex((t) => t.id === d.id);
			targetRef.current = { status: task.status, index };
			try {
				board.setPointerCapture(d.pointerId);
			} catch {
				/* pointer already gone */
			}
			window.addEventListener("keydown", onKeyRef.current);
			window.addEventListener("blur", onBlurRef.current);
			setDrag({ id: d.id, status: task.status, index, w: d.w, h: d.h });
			lastTickRef.current = 0;
			d.raf = requestAnimationFrame(tick);
			return;
		}

		d.tiltTarget = clamp((e.clientX - d.lastClientX) * 1.1, -14, 14);
		d.lastClientX = e.clientX;
		const br = board.getBoundingClientRect();
		d.tx = clamp((e.clientX - br.left) / d.k - d.gx, -6, board.offsetWidth - d.w + 6);
		d.ty = clamp((e.clientY - br.top) / d.k - d.gy, -6, board.offsetHeight - d.h + 6);

		// Which column is the cursor over (nearest centre), and where in it?
		const cols = Array.from(board.querySelectorAll<HTMLElement>("[data-col]"));
		let colEl = cols[0];
		let best = Infinity;
		for (const c of cols) {
			const r = c.getBoundingClientRect();
			const dist = Math.abs(e.clientX - (r.left + r.width / 2));
			if (dist < best) {
				best = dist;
				colEl = c;
			}
		}
		if (!colEl) return;
		const status = colEl.dataset.col as TaskStatus;
		const list = colEl.querySelector<HTMLElement>(".tb-list");
		if (!list) return;
		const lr = list.getBoundingClientRect();
		const edge = 28 * d.k;
		if (e.clientY < lr.top + edge) list.scrollTop -= 8;
		else if (e.clientY > lr.bottom - edge) list.scrollTop += 8;
		                const py = (e.clientY - lr.top) / d.k + list.scrollTop;
const ph = list.querySelector<HTMLElement>('[data-flip="__placeholder"]');
const phSpace = ph ? ph.offsetHeight + LIST_GAP : 0;
const cards = Array.from(list.querySelectorAll<HTMLElement>("[data-task-id]")).filter(
(card) => card.dataset.taskId !== d.id
);
let index = 0;
cards.forEach((card) => {
// Ignore the gap the placeholder itself opens up, or it would flicker.
const below = ph && card.offsetTop > ph.offsetTop ? phSpace : 0;
const mid = card.offsetTop + card.offsetHeight / 2 - below;
if (py > mid) index++;
});const cur = targetRef.current;
		if (!cur || cur.status !== status || cur.index !== index) {
			targetRef.current = { status, index };
			const stamp = performance.now();
			if (stamp - lastSlotTickRef.current > SLOT_TICK_GAP_MS) {
				lastSlotTickRef.current = stamp;
				onSlotChangeRef.current?.();
			}
			setDrag((prev) => (prev ? { ...prev, status, index } : prev));
		}
	};

	const handleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d || d.settling || e.pointerId !== d.pointerId) return;
		finish(d.active);
	};

	const handleCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = dragRef.current;
		if (!d || d.settling || e.pointerId !== d.pointerId) return;
		finish(false);
	};

	const handleLostCapture = () => {
		const d = dragRef.current;
		if (d && d.active && !d.settling) finish(false);
	};

	const toggleDone = (task: QuickTask) =>
		moveTask(task.id, task.done ? "open" : "done", Infinity);

	const cyclePriority = (id: string) =>
		onChange((prev) =>
			prev.map((t) => (t.id === id ? { ...t, priority: (t.priority % 3) + 1 } : t))
		);

	const togglePinned = (id: string) =>
		onChange((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));

	const toggleGrouped = () => {
		setGrouped((prev) => {
			const next = !prev;
			localStorage.setItem("bloom-tasks-grouped", String(next));
			return next;
		});
	};

	// Right-click opens the task at full size, the way the calendar opens a day.
	const openEditor = (task: QuickTask) => {
		setEditingId(task.id);
		setEditDraft({
			text: task.text,
			notes: task.notes ?? "",
			group: task.group ?? "",
			priority: task.priority,
			status: task.status,
			pinned: !!task.pinned
		});
	};

	const closeEditor = () => {
		setEditingId(null);
		setEditDraft(null);
	};

	const saveEditor = () => {
		const id = editingId;
		const d = editDraft;
		if (!id || !d) return;
		const text = d.text.trim().slice(0, maxLength);
		if (!text) return closeEditor();
		onChange((prev) =>
			prev.map((t) => {
				if (t.id !== id) return t;
				const next: QuickTask = {
					...t,
					text,
					priority: d.priority,
					status: d.status,
					done: d.status === "done"
				};
				// Empty values are removed rather than stored as "", so an older
				// save stays byte-identical when nothing was set.
				const group = d.group.trim().slice(0, GROUP_MAX_LENGTH);
				if (group) next.group = group;
				else delete next.group;
				const notes = d.notes.trim().slice(0, NOTES_MAX_LENGTH);
				if (notes) next.notes = notes;
				else delete next.notes;
				if (d.pinned) next.pinned = true;
				else delete next.pinned;
				return next;
			})
		);
		if (d.status === "done") celebrate(id);
		closeEditor();
	};

	const deleteFromEditor = () => {
		const id = editingId;
		closeEditor();
		if (id) onChange((prev) => prev.filter((t) => t.id !== id));
	};

	// Known group names, offered as suggestions in the editor.
	const knownGroups = Array.from(
		new Set(tasks.map((t) => (t.group || "").trim()).filter(Boolean))
	).sort((a, b) => a.localeCompare(b));

	const renderCard = (task: QuickTask, ghost = false) => {
		const overdue = task.remindAt !== undefined && !task.done && task.remindAt < now;
		return (
			<div
				key={ghost ? undefined : task.id}
				className={`tb-card ${task.status} p${task.priority}${task.pinned ? " pinned" : ""}${!ghost && justDone.has(task.id) ? " just-done" : ""}${!ghost && landing === task.id ? " tb-landing" : ""}`}
				data-task-id={ghost ? undefined : task.id}
				data-flip={ghost ? undefined : task.id}
				onPointerDown={ghost ? undefined : (e) => beginPress(e, task.id)}
				onContextMenu={
					ghost
						? undefined
						: (e) => {
								// Right-click opens the task full size, matching how the
								// calendar opens a day. The drag press is dropped first so a
								// right-click during a pending left press cannot move it.
								e.preventDefault();
								e.stopPropagation();
								finish(false);
								openEditor(task);
							}
				}
				title={ghost ? undefined : "Right-click to open"}
			>
				{/* Priority is carried by a bar down the leading edge, so it reads at a
				    glance without adding another badge to the row. */}
				<span className={`tb-prio-bar p${task.priority}`} aria-hidden />
				<button
					className="tb-check"
					onClick={() => toggleDone(task)}
					title={task.done ? "Mark as not done" : "Mark as done"}
				>
					{task.done && <Check size={10} strokeWidth={3.2} />}
				</button>
				<button
					className={`tb-prio p${task.priority}`}
					onClick={() => cyclePriority(task.id)}
					title={`Priority: ${PRIORITY_LABEL[task.priority] ?? "Medium"} (click to change)`}
				/>
				<div className="tb-card-main">
					<div className="tb-card-title" title={task.text}>
						{task.text}
					</div>
					{task.remindAt !== undefined && (
						<div className={`tb-card-due ${overdue ? "past" : ""}`}>
							scheduled: {formatScheduled(task.remindAt)}
							{overdue ? " (past)" : ""}
						</div>
					)}
				</div>
				<div className="tb-card-side">
					{task.group && (
						<span className="tb-card-group" title={`Group: ${task.group}`}>
							<Tag size={10} strokeWidth={2} />
							{task.group}
						</span>
					)}
					{!ghost && (
						<button
							className={`tb-pin${task.pinned ? " on" : ""}`}
							onClick={(e) => {
								e.stopPropagation();
								togglePinned(task.id);
							}}
							title={task.pinned ? "Unpin" : "Pin to top"}
						>
							<Pin size={11} strokeWidth={2} />
						</button>
					)}
					{task.remindAt !== undefined && !task.done && (
						<span
							className={`tb-bell ${task.notified ? "fired" : ""}`}
							title={task.notified ? "Reminder sent" : "Reminder set"}
						>
							<BellRing size={12} strokeWidth={2} />
						</span>
					)}
					<button
						className="tb-del"
						onClick={() => onChange((prev) => prev.filter((t) => t.id !== task.id))}
						title="Delete"
					>
						<X size={12} strokeWidth={2.2} />
					</button>
				</div>
			</div>
		);
	};

	// While landing, keep showing the card as it looked when it was let go.
	const ghostTask = landing
		? ghostTaskRef.current
		: drag
			? tasks.find((t) => t.id === drag.id)
			: undefined;
	ghostTaskRef.current = ghostTask;

	const addTarget: TaskStatus = composer ?? "open";
	const addTargetLabel = COLUMNS.find((c) => c.id === addTarget)?.label ?? "Open";
	const submitTask = () => {
		if (!draft.trim()) return;
		onAdd(addTarget);
		onComposerChange(null);
	};

	return (
		<>
		<div className="tb-toolbar">
			{/* Header like the reference to-do list: an icon tile, the title and what is left. */}
			<span className="tb-head-tile" aria-hidden>
				<ListChecks size={14} strokeWidth={2.2} />
			</span>
			<div className="tb-head-text">
				<span className="tb-head-title">To-Do</span>
				<span className="tb-head-sub">{tasks.filter((t) => t.status !== "done").length} left</span>
			</div>
			<button
				className={`tb-group-toggle${grouped ? " on" : ""}`}
				onClick={toggleGrouped}
				title={grouped ? "Show one flat list" : "Group tasks by group"}
			>
				<Tag size={11} strokeWidth={2} />
				{grouped ? "Grouped" : "Flat"}
			</button>
		</div>
		<div className="tb-addrow">
			<input
				ref={addInputRef}
				className="tb-input"
				type="text"
				value={draft}
				maxLength={maxLength}
				placeholder={addTarget === "open" ? "Add a task…" : `Add a task to ${addTargetLabel}…`}
				spellCheck={false}
				onChange={(e) => onDraftChange(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						submitTask();
					} else if (e.key === "Escape") {
						onComposerChange(null);
						(e.target as HTMLInputElement).blur();
					}
				}}
			/>
			<input
				className="tb-time"
				type="time"
				value={time}
				title="Remind me at (optional)"
				onChange={(e) => onTimeChange(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						submitTask();
					}
				}}
			/>
			<button
				className="tb-icon-btn accent"
				onClick={submitTask}
				disabled={!draft.trim()}
				title="Add task"
			>
				<Plus size={14} strokeWidth={2.4} />
			</button>
		</div>
		<div
			ref={boardRef}
			className={`tb-board ${drag && !landing ? "dragging" : ""}`}
			onWheel={(e) => e.stopPropagation()}
			onPointerMove={handleMove}
			onPointerUp={handleUp}
			onPointerCancel={handleCancel}
			onLostPointerCapture={handleLostCapture}
		>
			{COLUMNS.map((col) => {
				const all = tasks.filter((t) => t.status === col.id);
				// Display order: pinned first, then by priority. The stored order is
				// left alone so a drag still writes a meaningful position.
				const shown = sortForDisplay(
					all.filter((t) => !drag || landing || t.id !== drag.id)
				);
				const dragHere = drag && !landing && drag.status === col.id ? drag : null;
				const overHere = !!dragHere;
				const items: ReactNode[] = [];
				const placeholder = (
					<div
						key="__placeholder"
						className="tb-placeholder"
						data-flip="__placeholder"
						style={{ height: dragHere ? dragHere.h : 0 }}
					/>
				);
				// Grouping splits the column into labelled runs. While a card is being
				// dragged the headers are dropped, so the placeholder maths above stays
				// anchored to a flat list.
				if (grouped && !dragHere) {
					let currentGroup: string | null = null;
					shown.forEach((t) => {
						const g = (t.group || "").trim();
						if (g !== currentGroup) {
							currentGroup = g;
							items.push(
								<div key={`__g-${col.id}-${g || "none"}`} className="tb-group-head">
									<span className="tb-group-name">{groupLabel(g)}</span>
									<span className="tb-group-count">
										{shown.filter((x) => (x.group || "").trim() === g).length}
									</span>
								</div>
							);
						}
						items.push(renderCard(t));
					});
				} else {
					shown.forEach((t, i) => {
						if (dragHere && dragHere.index === i) items.push(placeholder);
						items.push(renderCard(t));
					});
					if (dragHere && dragHere.index >= shown.length) items.push(placeholder);
				}

				return (
					<div
						key={col.id}
						className={`tb-col ${overHere ? "drop-target" : ""}${pulseCol === col.id ? " landed" : ""}`}
						data-col={col.id}
					>
						<div className="tb-col-head">
							<GripVertical size={12} strokeWidth={2} className="tb-grip" />
							<span className="tb-col-title">{col.label}</span>
							{col.id === "done" && all.length > 0 && (
								<button
									className="tb-clear"
									onClick={() => onChange((prev) => prev.filter((t) => t.status !== "done"))}
									title="Delete all done tasks"
								>
									Clear
								</button>
							)}
							<span className="tb-col-count">({all.length})</span>
						</div>
						<div className="tb-list">
							{items}
							{shown.length === 0 && !overHere && (
								<div className="tb-empty">
									<Plus size={12} strokeWidth={2} />
									No tasks
								</div>
							)}
						</div>
					</div>
				);
			})}

			{drag && ghostTask && (
				<div ref={ghostRef} className="tb-ghost" style={{ width: drag.w }}>
					{renderCard(ghostTask, true)}
				</div>
			)}
		</div>

		{/* Full-size editor, opened by right-clicking a task. An overlay inside the
		    board rather than a separate window, the way the calendar opens a day.
		    Nothing is written until Save, so Escape is always safe. */}
		{editingId && editDraft && (
			<div className="tb-editor-scrim" onClick={closeEditor}>
				<div
					className="tb-editor"
					onClick={(e) => e.stopPropagation()}
					onWheel={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "Escape") {
							e.preventDefault();
							closeEditor();
						} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							saveEditor();
						}
					}}
				>
					<div className="tb-editor-head">
						<span className="tb-editor-title">Edit task</span>
						<button className="tb-editor-close" onClick={closeEditor} title="Cancel">
							<X size={13} strokeWidth={2.2} />
						</button>
					</div>

					<label className="tb-editor-label" htmlFor="tb-ed-text">
						Task
					</label>
					<textarea
						id="tb-ed-text"
						ref={editTextRef}
						className="tb-editor-text"
						value={editDraft.text}
						maxLength={maxLength}
						placeholder="What needs doing?"
						onChange={(e) => setEditDraft({ ...editDraft, text: e.target.value })}
					/>

					<label className="tb-editor-label" htmlFor="tb-ed-notes">
						Notes
					</label>
					<textarea
						id="tb-ed-notes"
						className="tb-editor-notes"
						value={editDraft.notes}
						maxLength={NOTES_MAX_LENGTH}
						placeholder="Anything else about this task… (optional)"
						onChange={(e) => setEditDraft({ ...editDraft, notes: e.target.value })}
					/>

					<div className="tb-editor-grid">
						<div className="tb-editor-field">
							<span className="tb-editor-label">Group</span>
							<input
								className="tb-editor-input"
								type="text"
								list="tb-editor-groups"
								value={editDraft.group}
								maxLength={GROUP_MAX_LENGTH}
								placeholder="None"
								onChange={(e) => setEditDraft({ ...editDraft, group: e.target.value })}
							/>
							<datalist id="tb-editor-groups">
								{knownGroups.map((g) => (
									<option key={g} value={g} />
								))}
							</datalist>
						</div>

						<div className="tb-editor-field">
							<span className="tb-editor-label">Column</span>
							<div className="tb-editor-segments">
								{COLUMNS.map((c) => (
									<button
										key={c.id}
										className={`tb-editor-seg${editDraft.status === c.id ? " on" : ""}`}
										onClick={() => setEditDraft({ ...editDraft, status: c.id })}
									>
										{c.label}
									</button>
								))}
							</div>
						</div>
					</div>

					<div className="tb-editor-grid">
						<div className="tb-editor-field">
							<span className="tb-editor-label">Priority</span>
							<div className="tb-editor-segments">
								{[3, 2, 1].map((p) => (
									<button
										key={p}
										className={`tb-editor-seg prio p${p}${editDraft.priority === p ? " on" : ""}`}
										onClick={() => setEditDraft({ ...editDraft, priority: p })}
									>
										<i className={`tb-editor-swatch p${p}`} aria-hidden />
										{PRIORITY_LABEL[p]}
									</button>
								))}
							</div>
						</div>

						<div className="tb-editor-field">
							<span className="tb-editor-label">Pin</span>
							<button
								className={`tb-editor-pin${editDraft.pinned ? " on" : ""}`}
								onClick={() => setEditDraft({ ...editDraft, pinned: !editDraft.pinned })}
								title="Pinned tasks sort to the top of their column"
							>
								<Pin size={12} strokeWidth={2} />
								{editDraft.pinned ? "Pinned" : "Not pinned"}
							</button>
						</div>
					</div>

					<div className="tb-editor-footer">
						<span className="tb-editor-hint">Esc cancels · Ctrl+Enter saves</span>
						<div className="tb-editor-actions">
							<button className="tb-editor-btn danger" onClick={deleteFromEditor}>
								Delete
							</button>
							<button className="tb-editor-btn primary" onClick={saveEditor}>
								Save
							</button>
						</div>
					</div>
				</div>
			</div>
		)}
		</>
	);
}
