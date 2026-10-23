import {
	useEffect,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
	Activity,
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Cpu,
	HardDrive,
	MemoryStick,
	Monitor,
	Thermometer,
	X
} from "lucide-react";
import "./Performance.css";
import "./PerformanceSkin.css";
import "./PerformanceGlass.css";

export interface NetworkUsage {
	downPerSec: number;
	upPerSec: number;
	downTotal: number;
	upTotal: number;
}

const GIB = 1024 ** 3;
const gib = (bytes: number, digits = 1) => (bytes / GIB).toFixed(digits);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Trims trademark marks and marketing suffixes so a processor name fits the card.
const cleanChipName = (name: string): string =>
	name
		.replace(/\((R|TM)\)/gi, "")
		.replace(/\s+CPU\b/i, "")
		.replace(/\s*@.*$/, "")
		.replace(/\s+with .*$/i, "")
		.replace(/\s+/g, " ")
		.trim();

const formatRate = (bytes: number): string => {
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
	return `${Math.round(bytes)} B/s`;
};

const formatTotal = (bytes: number): string =>
	bytes >= GIB ? `${(bytes / GIB).toFixed(2)}GB` : `${(bytes / 1024 ** 2).toFixed(1)}MB`;

// A 270-degree gauge with the gap at the bottom; the percentage sits in the middle.
function Ring({
	fraction,
	size,
	icon,
	title,
	onOpen,
	grow
}: {
	fraction: number;
	size: number;
	icon?: ReactNode;
	title?: string;
	onOpen?: (e: HitEvent) => void;
	grow?: boolean;
}) {
	const r = 42;
	const circumference = 2 * Math.PI * r;
	const arc = circumference * 0.75;
	const f = clamp01(fraction);
	return (
		<div
			className={`pf-ring${onOpen ? " pf-hit" : ""}${onOpen || grow ? " pf-grow" : ""}`}
			style={{ width: size, height: size }}
			title={title}
			{...(onOpen
				? { role: "button", tabIndex: 0, onClick: onOpen, onKeyDown: onActivate(onOpen) }
				: {})}
		>
			<svg viewBox="0 0 100 100">
				<circle
					className="pf-ring-track"
					cx="50"
					cy="50"
					r={r}
					strokeDasharray={`${arc} ${circumference}`}
				/>
				<circle
					className="pf-ring-value"
					cx="50"
					cy="50"
					r={r}
					strokeDasharray={`${arc * f} ${circumference}`}
					style={{ opacity: f > 0 ? 1 : 0 }}
				/>
			</svg>
			<div className="pf-ring-center">
				{icon}
				<span className="pf-ring-num">{Math.round(f * 100)}%</span>
				<span className="pf-ring-label">Used</span>
			</div>
		</div>
	);
}

// The small circular badge on the CPU and GPU cards: usage as an arc around an icon.
function MiniRing({ fraction, icon }: { fraction: number; icon: ReactNode }) {
	const r = 15;
	const circumference = 2 * Math.PI * r;
	const f = clamp01(fraction);
	return (
		<div className="pf-mini-ring">
			<svg viewBox="0 0 36 36">
				<circle className="pf-ring-track" cx="18" cy="18" r={r} />
				<circle
					className="pf-ring-value"
					cx="18"
					cy="18"
					r={r}
					strokeDasharray={`${circumference * f} ${circumference}`}
					style={{ opacity: f > 0 ? 1 : 0, transform: "rotate(-90deg)", transformOrigin: "center" }}
				/>
			</svg>
			{icon}
		</div>
	);
}

function ChipCard({
	icon,
	name,
	model,
	usage,
	temp,
	tempTitle
}: {
	icon: ReactNode;
	name: string;
	model: string;
	usage: number | null;
	temp: number | null;
	tempTitle?: string;
}) {
	return (
		<div className="pf-card pf-chip">
			<div className="pf-chip-head">
				<MiniRing fraction={(usage ?? 0) / 100} icon={icon} />
				<div className="pf-chip-title">
					<span className="pf-title">{name}</span>
					<span className="pf-sub" title={model}>
						{model || "--"}
					</span>
				</div>
				<div className="pf-usage">
					<span className="pf-usage-label">Usage</span>
					<span className="pf-usage-value">{usage !== null ? `${Math.round(usage)}%` : "--"}</span>
				</div>
			</div>
			<div className="pf-temp" title={tempTitle}>
				<Thermometer size={12} />
				<span className="pf-temp-value">{temp !== null ? `${Math.round(temp)}°C` : "--"}</span>
				<div className="pf-bar">
					<div
						className={`pf-bar-fill${temp !== null && temp >= 85 ? " hot" : ""}`}
						style={{ width: `${temp !== null ? clamp01(temp / 100) * 100 : 0}%` }}
					/>
				</div>
			</div>
		</div>
	);
}

function Sparkline({ down, up }: { down: number[]; up: number[] }) {
	const width = 100;
	const height = 30;
	// A floor on the scale keeps an idle connection from looking like a wild graph.
	const max = Math.max(50 * 1024, ...down, ...up);
	const points = (values: number[]) =>
		values
			.map((v, i) => {
				const x = values.length > 1 ? (i / (values.length - 1)) * width : width;
				const y = height - 1 - (v / max) * (height - 4);
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(" ");
	const downPoints = points(down);
	return (
		<svg className="pf-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
			{down.length > 1 && (
				<polygon className="pf-spark-area" points={`0,${height} ${downPoints} ${width},${height}`} />
			)}
			{up.length > 1 && <polyline className="pf-spark-up" points={points(up)} />}
			{down.length > 1 && <polyline className="pf-spark-down" points={downPoints} />}
		</svg>
	);
}

// Where the window opens: beside the card, on the side with room, level with the part that was clicked.
interface PerfPopup {
	side: "left" | "right";
	x: number;
	y: number;
	arrow: number;
}

type HitEvent = { currentTarget: HTMLElement };

// Enter or Space on a focused clickable area does what a click does.
const onActivate = (action: (e: HitEvent) => void) => (e: ReactKeyboardEvent<HTMLElement>) => {
	if (e.target !== e.currentTarget) return;
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		action(e);
	}
};

// Position of an element inside a positioned ancestor, by walking up its offset parents (this does
// not depend on how the notch is scaled, unlike getBoundingClientRect).
const offsetWithin = (el: HTMLElement, root: HTMLElement) => {
	let x = 0;
	let y = 0;
	let node: HTMLElement | null = el;
	while (node && node !== root) {
		x += node.offsetLeft;
		y += node.offsetTop;
		node = node.offsetParent as HTMLElement | null;
	}
	return { x, y };
};

// The window comes in the same way as the power panel on the dashboard: a short slide up with a
// soft spring (the same numbers as DASH_SPRING in Dashboard.tsx) and a quick fade.
const POPUP_SPRING = { type: "spring", stiffness: 210, damping: 18, mass: 0.9 } as const;
const POPUP_FADE_IN = { duration: 0.16, ease: "easeOut" } as const;
const POPUP_FADE_OUT = { duration: 0.12, ease: "easeOut" } as const;

// Half the height the window is assumed to have, so its centre stays inside the tab.
const POPUP_HALF_HEIGHT = 74;
const POPUP_GAP = 8;

const popupFor = (e: HitEvent): PerfPopup | null => {
	const hit = e.currentTarget;
	const grid = hit.closest<HTMLElement>(".pf-grid");
	const card = hit.closest<HTMLElement>(".pf-card");
	if (!grid || !card) return null;
	const c = offsetWithin(card, grid);
	const h = offsetWithin(hit, grid);
	const side = c.x + card.offsetWidth / 2 < grid.clientWidth / 2 ? "right" : "left";
	const x = side === "right" ? c.x + card.offsetWidth + POPUP_GAP : grid.clientWidth - c.x + POPUP_GAP;
	const centre = h.y + hit.offsetHeight / 2;
	const y = Math.min(Math.max(centre, POPUP_HALF_HEIGHT), grid.clientHeight - POPUP_HALF_HEIGHT);
	return { side, x, y, arrow: centre - y };
};

// The window that opens beside the memory card when its gauge is clicked: the gauge and the
// used / free / total numbers, which used to be a tooltip. Click outside or press Esc to close.
function MemoryPopup({
	used,
	total,
	onClose
}: {
	used: number | null;
	total: number | null;
	onClose: () => void;
}) {
	const known = used !== null && total !== null && total > 0;
	const fraction = known ? used / total : 0;
	return (
		<div className="pf-pop" role="dialog" aria-label="Memory details">
			<div className="pf-pop-head">
				<span className="pf-pop-tag">Memory</span>
				<button className="pf-pop-close" onClick={onClose} title="Close">
					<X size={10} />
				</button>
			</div>
			<div className="pf-pop-body">
				<Ring fraction={fraction} size={62} />
				<div className="pf-pop-tiles">
					<div className="pf-pop-tile">
						<i>Used</i>
						<b>{known ? `${gib(used)} GiB` : "--"}</b>
					</div>
					<div className="pf-pop-tile">
						<i>Free</i>
						<b>{known ? `${gib(total - used)} GiB` : "--"}</b>
					</div>
					<div className="pf-pop-tile">
						<i>Total</i>
						<b>{known ? `${gib(total)} GiB` : "--"}</b>
					</div>
				</div>
			</div>
		</div>
	);
}

// The storage details open inside the card, over everything in it, the way the calendar's note
// editor does (same spring): a tag and close button, a usage bar, the numbers and a drive switch.
function StoragePanel({
	used,
	total,
	drive,
	onCycleDrive,
	onClose
}: {
	used: number | null;
	total: number | null;
	drive: string;
	onCycleDrive: () => void;
	onClose: () => void;
}) {
	const known = used !== null && total !== null && total > 0;
	const fraction = known ? used / total : 0;
	return (
		<motion.div
			className="pf-store-panel"
			role="dialog"
			aria-label="Storage details"
			onClick={(e) => e.stopPropagation()}
			initial={{ opacity: 0, y: 12, scale: 0.97 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
			transition={{ type: "spring", stiffness: 420, damping: 32 }}
		>
			<div className="pf-pop-head">
				<span className="pf-pop-tag">{`Storage · ${drive}:`}</span>
				<button className="pf-pop-close" onClick={onClose} title="Close">
					<X size={10} />
				</button>
			</div>
			<div className="pf-store-meter">
				<div className="pf-bar">
					<div className="pf-bar-fill" style={{ width: `${clamp01(fraction) * 100}%` }} />
				</div>
				<b>{Math.round(clamp01(fraction) * 100)}%</b>
			</div>
			<div className="pf-store-tiles">
				<div className="pf-pop-tile">
					<i>Used</i>
					<b>{known ? gib(used) : "--"}</b>
				</div>
				<div className="pf-pop-tile">
					<i>Free</i>
					<b>{known ? gib(total - used) : "--"}</b>
				</div>
				<div className="pf-pop-tile">
					<i>Total</i>
					<b>{known ? gib(total, 0) : "--"}</b>
				</div>
			</div>
			<button className="pf-pop-action" onClick={onCycleDrive} title="Switch to the next drive">
				<HardDrive size={11} />
				<span>Switch drive</span>
				<ChevronRight size={11} />
			</button>
		</motion.div>
	);
}

export function PerformanceTab({
	cpuUsage,
	cpuTemp,
	cpuName,
	gpuUsage,
	gpuTemp,
	gpuName,
	ramUsed,
	ramTotal,
	diskUsed,
	diskTotal,
	drive,
	onCycleDrive,
	net,
	downHistory,
	upHistory
}: {
	cpuUsage: number;
	cpuTemp: number | null;
	cpuName: string;
	gpuUsage: number | null;
	gpuTemp: number | null;
	gpuName: string;
	ramUsed: number | null;
	ramTotal: number | null;
	diskUsed: number | null;
	diskTotal: number | null;
	drive: string;
	onCycleDrive: () => void;
	net: NetworkUsage | null;
	downHistory: number[];
	upHistory: number[];
}) {
	const [detail, setDetail] = useState<PerfPopup | null>(null);
	const [storageOpen, setStorageOpen] = useState(false);
	const openMemory = (e: HitEvent) => setDetail(popupFor(e));
	// Right-click on the memory card (its gauge icon and its text) opens Task Manager.
	const openTaskManager = (e: ReactMouseEvent) => {
		e.preventDefault();
		invoke("open_task_manager").catch((err) => console.error("Failed to open Task Manager:", err));
	};
	useEffect(() => {
		if (!detail && !storageOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setDetail(null);
				setStorageOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [detail, storageOpen]);

	const diskFraction = diskUsed !== null && diskTotal ? diskUsed / diskTotal : 0;
	const ramFraction = ramUsed !== null && ramTotal ? ramUsed / ramTotal : 0;
	return (
		<div className="pf-grid">
			<div className="pf-row top">
				<ChipCard
					icon={<Cpu size={14} />}
					name="CPU"
					model={cleanChipName(cpuName)}
					usage={cpuUsage}
					temp={cpuTemp}
					tempTitle="Temperature is the ACPI thermal zone, which may not be the CPU die sensor"
				/>
				<ChipCard
					icon={<Monitor size={14} />}
					name="GPU"
					model={gpuName.replace(/^NVIDIA GeForce /i, "")}
					usage={gpuUsage}
					temp={gpuTemp}
				/>
			</div>
			<div className="pf-row bottom">
				<div
					className="pf-card pf-storage"
					onContextMenu={(e) => {
						e.preventDefault();
						onCycleDrive();
					}}
				>
					<div
						className="pf-storage-top pf-hit"
						role="button"
						tabIndex={0}
						aria-label="Storage details"
						onClick={() => setStorageOpen(true)}
						onKeyDown={onActivate(() => setStorageOpen(true))}
					>
						<Ring fraction={diskFraction} size={84} icon={<HardDrive size={11} />} grow />
						<div className="pf-storage-text">
							<span className="pf-title">Storage</span>
							<span className="pf-detail">
								{diskUsed !== null && diskTotal !== null
									? `${gib(diskUsed)} / ${gib(diskTotal, 0)} GiB`
									: "--"}
							</span>
						</div>
					</div>
					<div className="pf-drive-row">
						<button className="pf-drive" onClick={onCycleDrive} title="Click to switch drive">
							<HardDrive size={12} />
							<span>{drive}:</span>
						</button>
						<button className="pf-drive-chevron" onClick={onCycleDrive} title="Switch drive">
							<ChevronDown size={12} />
						</button>
					</div>
					<AnimatePresence>
						{storageOpen && (
							<StoragePanel
								key="storage"
								used={diskUsed}
								total={diskTotal}
								drive={drive}
								onCycleDrive={onCycleDrive}
								onClose={() => setStorageOpen(false)}
							/>
						)}
					</AnimatePresence>
				</div>
				<div className="pf-card pf-network">
					<div className="pf-heading">
						<span className="pf-title">Network</span>
					</div>
					<Sparkline down={downHistory} up={upHistory} />
					<div className="pf-net-row down">
						<ArrowDown size={12} />
						<span>Download</span>
						<b>{formatRate(net?.downPerSec ?? 0)}</b>
					</div>
					<div className="pf-net-row up">
						<ArrowUp size={12} />
						<span>Upload</span>
						<b>{formatRate(net?.upPerSec ?? 0)}</b>
					</div>
					<div className="pf-net-row">
						<Activity size={12} />
						<span>Total</span>
						<b>
							↓{formatTotal(net?.downTotal ?? 0)} ↑{formatTotal(net?.upTotal ?? 0)}
						</b>
					</div>
				</div>
				<div className="pf-card pf-memory" onContextMenu={openTaskManager}>
					<div className="pf-heading">
						<span className="pf-title">Memory</span>
					</div>
					<Ring
						fraction={ramFraction}
						size={84}
						icon={<MemoryStick size={11} />}
						onOpen={openMemory}
						title="Click: details · Right-click: Task Manager"
					/>
					<span
						className="pf-detail pf-hit"
						role="button"
						tabIndex={0}
						aria-label="Memory details"
						title="Click: details · Right-click: Task Manager"
						onClick={openMemory}
						onKeyDown={onActivate(openMemory)}
					>
						{ramUsed !== null && ramTotal !== null ? `${gib(ramUsed)} / ${gib(ramTotal)} GiB` : "--"}
					</span>
				</div>
			</div>
			{/* Invisible: a click anywhere else closes the window. */}
			{detail && <div className="pf-pop-backdrop" onClick={() => setDetail(null)} />}
			<AnimatePresence>
				{detail && (
					<motion.div
						key="memory"
						className={`pf-pop-anchor ${detail.side}`}
						style={{
							top: detail.y,
							...(detail.side === "right" ? { left: detail.x } : { right: detail.x }),
							["--pf-arrow" as string]: `${detail.arrow}px`
						}}
						initial={{ opacity: 0, y: 16, scale: 0.98 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 10, scale: 0.99, transition: POPUP_FADE_OUT }}
						transition={{ y: POPUP_SPRING, scale: POPUP_SPRING, opacity: POPUP_FADE_IN }}
					>
						<MemoryPopup used={ramUsed} total={ramTotal} onClose={() => setDetail(null)} />
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
