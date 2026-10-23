import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

const CALENDAR_NOTE_MAX_LENGTH = 140;

export const calendarDateKey = (d: Date): string =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const DASH_DAY_NAMES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// ISO-8601 week number (weeks start on Monday, week 1 holds the year's first Thursday).
const isoWeek = (d: Date): number => {
	const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
	return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

// "full" is the big calendar; "dash" is the compact dashboard card, which adds a date header,
// week and weekend bands and the neighbouring months' days (styled in DashboardCalendar.css).
export function Calendar({
	notes,
	onSaveNote,
	variant = "full"
}: {
	notes: Record<string, string>;
	onSaveNote: (key: string, text: string) => void;
	variant?: "full" | "dash";
}) {
	const isDash = variant === "dash";
	const [date] = useState(new Date());
	const [editingDay, setEditingDay] = useState<number | null>(null);
	const [draft, setDraft] = useState("");
	const noteInputRef = useRef<HTMLTextAreaElement>(null);

	const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
	const firstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

	const currentMonth = date.getMonth();
	const currentYear = date.getFullYear();
	const monthName = date.toLocaleString("default", { month: "long" });

	const totalDays = daysInMonth(currentYear, currentMonth);
	const startDay = firstDayOfMonth(currentYear, currentMonth);
	const days = [];

	const keyFor = (day: number) => calendarDateKey(new Date(currentYear, currentMonth, day));

	const openEditor = (day: number) => {
		setDraft(notes[keyFor(day)] ?? "");
		setEditingDay(day);
	};
	const closeEditor = () => setEditingDay(null);
	const commitNote = () => {
		if (editingDay === null) return;
		onSaveNote(keyFor(editingDay), draft.trim());
		closeEditor();
	};
	const deleteNote = () => {
		if (editingDay === null) return;
		onSaveNote(keyFor(editingDay), "");
		closeEditor();
	};

	useEffect(() => {
		if (editingDay !== null) {
			noteInputRef.current?.focus();
			noteInputRef.current?.select();
		}
	}, [editingDay]);

	// Days of the neighbouring months only fill the dashboard card's grid, they are not editable.
	const swallowMenu = (e: ReactMouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
	};

	// Padding for start of month
	if (isDash) {
		const prevTotal = daysInMonth(currentYear, currentMonth - 1);
		for (let i = 0; i < startDay; i++) {
			days.push(
				<div key={`pre-${i}`} className="calendar-day outside" onContextMenu={swallowMenu}>
					{prevTotal - startDay + i + 1}
				</div>
			);
		}
	} else {
		for (let i = 0; i < startDay; i++) {
			days.push(<div key={`empty-${i}`} className="calendar-day empty" />);
		}
	}

	// Actual days
	const today = new Date().getDate();
	const isCurrentMonth =
		new Date().getMonth() === currentMonth && new Date().getFullYear() === currentYear;

	for (let i = 1; i <= totalDays; i++) {
		const note = notes[keyFor(i)];
		const column = (startDay + i - 1) % 7;
		const classes = [
			"calendar-day",
			column === 0 || column === 6 ? "weekend" : "",
			isCurrentMonth && i === today ? "today" : "",
			note ? "has-note" : "",
			editingDay === i ? "selected" : ""
		]
			.filter(Boolean)
			.join(" ");
		days.push(
			<div
				key={i}
				className={classes}
				title={note || undefined}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					openEditor(i);
				}}
			>
				{i}
			</div>
		);
	}

	if (isDash) {
		const trailing = (7 - ((startDay + totalDays) % 7)) % 7;
		for (let i = 1; i <= trailing; i++) {
			days.push(
				<div key={`post-${i}`} className="calendar-day outside" onContextMenu={swallowMenu}>
					{i}
				</div>
			);
		}
	}

	const rows = Math.ceil((startDay + totalDays) / 7);
	const weekRow = Math.floor((startDay + today - 1) / 7);
	const now = new Date();
	const daysLeft = totalDays - now.getDate();

	const editingKey = editingDay !== null ? keyFor(editingDay) : null;
	const editingLabel =
		editingDay !== null
			? new Date(currentYear, currentMonth, editingDay).toLocaleDateString(undefined, {
					weekday: "short",
					month: "short",
					day: "numeric"
				})
			: "";

	return (
		<div className="calendar-container">
			{isDash ? (
				<div className="calendar-header dash-cal-head">
					<span className="dash-cal-tile">
						<i>{now.toLocaleDateString(undefined, { weekday: "short" })}</i>
						<b>{now.getDate()}</b>
					</span>
					<span className="dash-cal-title">
						<span className="dash-cal-month">
							{monthName}
							<em className="dash-cal-year">{currentYear}</em>
						</span>
						<span className="dash-cal-sub">
							Week {isoWeek(now)} {"\u00b7"}{" "}
							{daysLeft === 0 ? "last day of the month" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
						</span>
					</span>
				</div>
			) : (
				<div className="calendar-header">
					<span className="month-year">
						{monthName} {currentYear}
					</span>
				</div>
			)}
			<div className="calendar-grid">
				{isDash && (
					<div
						className="cal-bands"
						aria-hidden
						style={{ gridTemplateRows: `repeat(${rows + 1}, 1fr)` }}
					>
						<i className="cal-band-names" style={{ gridColumn: "1 / -1", gridRow: 1 }} />
						<i className="cal-band-we" style={{ gridColumn: 1, gridRow: `2 / ${rows + 2}` }} />
						<i className="cal-band-we" style={{ gridColumn: 7, gridRow: `2 / ${rows + 2}` }} />
						{isCurrentMonth && (
							<i className="cal-band-week" style={{ gridColumn: "1 / -1", gridRow: weekRow + 2 }} />
						)}
					</div>
				)}
				{(isDash ? DASH_DAY_NAMES : ["S", "M", "T", "W", "T", "F", "S"]).map((d, i) => (
					<div
						key={`${d}-${i}`}
						className={[
							"day-name",
							i === 0 || i === 6 ? "weekend" : "",
							isDash && isCurrentMonth && i === now.getDay() ? "now" : ""
						]
							.filter(Boolean)
							.join(" ")}
					>
						{d}
					</div>
				))}
				{days}
			</div>

			<AnimatePresence>
				{editingDay !== null && (
					<motion.div
						className="calendar-note-editor"
						onClick={(e) => e.stopPropagation()}
						onWheel={(e) => e.stopPropagation()}
						initial={{ opacity: 0, y: 12, scale: 0.97 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
						transition={{ type: "spring", stiffness: 420, damping: 32 }}
					>
						<div className="calendar-note-header">
							<span className="calendar-note-title">{editingLabel}</span>
							<button className="calendar-note-close" onClick={closeEditor} title="Cancel">
								<X size={12} strokeWidth={2.2} />
							</button>
						</div>
						<textarea
							ref={noteInputRef}
							className="calendar-note-input"
							value={draft}
							maxLength={CALENDAR_NOTE_MAX_LENGTH}
							placeholder="Add a note for this day…"
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									commitNote();
								} else if (e.key === "Escape") {
									e.preventDefault();
									closeEditor();
								}
							}}
						/>
						<div className="calendar-note-footer">
							<span className="calendar-note-hint">
								{editingKey === calendarDateKey(new Date())
									? "Today — reminds on save"
									: "Reminds you that day"}
							</span>
							<div className="calendar-note-actions">
								{editingKey && notes[editingKey] && (
									<button className="calendar-note-btn" onClick={deleteNote}>
										Delete
									</button>
								)}
								<button className="calendar-note-btn primary" onClick={commitNote}>
									Save
								</button>
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
