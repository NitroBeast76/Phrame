import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PanelLeft, PanelBottom, Eye, EyeOff, ArrowLeftRight, CircleUserRound, ImagePlus, RotateCcw, Layers, Contrast } from "lucide-react";
import { SettingRow } from "./SettingRow";

// Self-contained: owns its state and persists the same way the other settings do
// (localStorage mirror + save_setting, which broadcasts "settings-changed").
const BTN_STYLE: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 6,
	padding: "6px 12px",
	marginLeft: 8,
	border: "none",
	borderRadius: 8,
	background: "rgba(255,255,255,0.08)",
	color: "inherit",
	font: "inherit",
	cursor: "pointer"
};
const read = (key: string, fallback: string) => {
	try {
		return localStorage.getItem(key) || fallback;
	} catch {
		return fallback;
	}
};
const save = (key: string, value: string) => {
	try {
		localStorage.setItem(key, value);
	} catch {}
	invoke("save_setting", { key, value }).catch(() => {});
};

// The notch and the side bar keep their own modes. An earlier version locked the notch to Peek/Smart
// while the side bar was on; if that left a remembered mode behind, put it back once.
const PREV_NOTCH = "bloom-sidebar-prev-notch-mode";
const releaseOldNotchLock = () => {
	const prev = read(PREV_NOTCH, "");
	if (!prev) return;
	save("bloom-notch-mode", prev);
	save(PREV_NOTCH, "");
};

// Same circle-cropped 128px PNG the bar's middle-click makes.
const pickCircleImage = (file: File, done: (dataUrl: string) => void) => {
	const url = URL.createObjectURL(file);
	const img = new Image();
	img.onload = () => {
		const c = document.createElement("canvas");
		c.width = c.height = 128;
		const g = c.getContext("2d");
		if (g) {
			const k = Math.max(128 / img.width, 128 / img.height);
			const w = img.width * k, h = img.height * k;
			g.beginPath();
			g.arc(64, 64, 64, 0, Math.PI * 2);
			g.clip();
			g.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
			done(c.toDataURL("image/png"));
		}
		URL.revokeObjectURL(url);
	};
	img.onerror = () => URL.revokeObjectURL(url);
	img.src = url;
};

export function SidebarTab() {
	const [enabled, setEnabled] = useState(() => read("bloom-sidebar-enabled", "false") === "true");
	const [mode, setMode] = useState(() => read("bloom-sidebar-mode", "smart"));
	const [side, setSide] = useState(() => read("bloom-sidebar-side", "left"));
	const [iconKind, setIconKind] = useState(() => read("bloom-sidebar-icon", "bloom"));
	// Icon opacity in percent. Empty = each icon's own default (Eye 70, Recycle 95, the rest 100).
	const [iconOp, setIconOp] = useState(() => read("bloom-sidebar-icon-opacity", ""));
	const [workspaces, setWorkspaces] = useState(() => read("bloom-sidebar-workspaces", "false") === "true");
	const [hasCustom, setHasCustom] = useState(() => !!read("bloom-sidebar-icon-custom", ""));
	const [hideTaskbar, setHideTaskbar] = useState(
		() => read("bloom-hide-native-taskbar", "false") === "true"
	);

	const fileInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		releaseOldNotchLock();
	}, []);

	return (
		<>
			<div className="setting-group-label">Side Bar</div>
			<div className="setting-group">
				<SettingRow icon={PanelLeft} label="Side Bar" desc="Vertical bar on a screen edge" divider={enabled}>
					<label className="toggle-switch">
						<input
							type="checkbox"
							checked={enabled}
							onChange={() => {
								const next = !enabled;
								setEnabled(next);
								save("bloom-sidebar-enabled", String(next));
								}}
						/>
						<span className="slider"></span>
					</label>
				</SettingRow>
				{enabled && (
					<>
						<SettingRow
							icon={mode === "fixed" ? EyeOff : Eye}
							label="Behavior"
							desc="Independent of the bottom dock"
						>
							<select
								className="settings-select"
								value={mode}
								onChange={(e) => {
									setMode(e.target.value);
									save("bloom-sidebar-mode", e.target.value);
								}}
							>
								<option value="fixed">Fixed</option>
								<option value="smart">Smart</option>
								<option value="peek">Peek</option>
							</select>
						</SettingRow>
						<SettingRow icon={ArrowLeftRight} label="Side" desc="Which screen edge">
							<select
								className="settings-select"
								value={side}
								onChange={(e) => {
									setSide(e.target.value);
									save("bloom-sidebar-side", e.target.value);
								}}
							>
								<option value="left">Left</option>
								<option value="right">Right</option>
							</select>
						</SettingRow>
						<SettingRow
							icon={Layers}
							label="komorebi workspaces"
							desc="Workspace dots in the middle of the bar. Needs komorebi running"
						>
							<label className="toggle-switch">
								<input
									type="checkbox"
									checked={workspaces}
									onChange={() => {
										const next = !workspaces;
										setWorkspaces(next);
										save("bloom-sidebar-workspaces", String(next));
									}}
								/>
								<span className="slider"></span>
							</label>
						</SettingRow>
						<SettingRow
							icon={CircleUserRound}
							label="Bar icon"
							desc="Top button of the bar. Recycle is drawn like the bar's other icons"
						>
							<select
								className="settings-select"
								value={iconKind}
								onChange={(e) => {
									setIconKind(e.target.value);
									save("bloom-sidebar-icon", e.target.value);
								}}
							>
								<option value="bloom">Bloom</option>
								<option value="eye">Eye</option>
								<option value="recycle">Recycle</option>
								<option value="custom">Custom image</option>
							</select>
						</SettingRow>
						<SettingRow
							icon={Contrast}
							label="Icon opacity"
							desc="How solid the Bloom button's picture is"
						>
							<input
								type="range"
								min={10}
								max={100}
								step={5}
								value={iconOp || (iconKind === "eye" ? "70" : iconKind === "recycle" ? "95" : "100")}
								style={{ width: 120, accentColor: "var(--bloom-accent, currentColor)" }}
								onChange={(e) => {
									setIconOp(e.target.value);
									save("bloom-sidebar-icon-opacity", e.target.value);
								}}
							/>
							<span style={{ display: "inline-block", width: 40, textAlign: "right", opacity: 0.75 }}>
								{iconOp || (iconKind === "eye" ? "70" : iconKind === "recycle" ? "95" : "100")}%
							</span>
							<button
								style={{ ...BTN_STYLE, opacity: iconOp ? 1 : 0.4 }}
								disabled={!iconOp}
								title="Back to the icon's default"
								onClick={() => {
									setIconOp("");
									save("bloom-sidebar-icon-opacity", "");
								}}
							>
								<RotateCcw size={13} /> Reset
							</button>
						</SettingRow>
						<SettingRow
							icon={ImagePlus}
							label="Custom image"
							desc="Shown as a circle. Middle-click the button on the bar to pick one there too"
							divider={false}
						>
							<input
								ref={fileInput}
								type="file"
								accept="image/*"
								style={{ display: "none" }}
								onChange={(e) => {
									const f = e.target.files?.[0];
									e.target.value = "";
									if (!f) return;
									pickCircleImage(f, (data) => {
										save("bloom-sidebar-icon-custom", data);
										save("bloom-sidebar-icon", "custom");
										setHasCustom(true);
										setIconKind("custom");
									});
								}}
							/>
							<button style={BTN_STYLE} onClick={() => fileInput.current?.click()}>
								Choose image
							</button>
							<button
								style={{ ...BTN_STYLE, opacity: iconKind === "bloom" && !hasCustom ? 0.4 : 1 }}
								disabled={iconKind === "bloom" && !hasCustom}
								title="Back to the Bloom logo"
								onClick={() => {
									save("bloom-sidebar-icon", "bloom");
									save("bloom-sidebar-icon-custom", "");
									setHasCustom(false);
									setIconKind("bloom");
								}}
							>
								<RotateCcw size={13} /> Reset
							</button>
						</SettingRow>
					</>
				)}
			</div>
			<div className="setting-group-label">Windows Taskbar</div>
			<div className="setting-group">
				<SettingRow
					icon={PanelBottom}
					label="Hide Windows taskbar"
					desc="Turn off the native taskbar while Bloom is running"
					divider={false}
				>
					<label className="toggle-switch">
						<input
							type="checkbox"
							checked={hideTaskbar}
							onChange={() => {
								const next = !hideTaskbar;
								setHideTaskbar(next);
								save("bloom-hide-native-taskbar", String(next));
							}}
						/>
						<span className="slider"></span>
					</label>
				</SettingRow>
			</div>
		</>
	);
}
