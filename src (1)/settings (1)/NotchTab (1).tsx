import {
	PanelTop,
	Calendar,
	BellRing,
	Music,
	Minimize2,
	LayoutList,
	Sparkles,
	Gauge,
	Circle,
	CloudSun,
	Timer,
	X,
	Volume2,
	FileAudio,
	Play,
	Disc
} from "lucide-react";
import { TimeGunSoundSettings } from "./TimeGunSoundSettings";
import { SettingRow } from "./SettingRow";
import { StatusWidgetConfig } from "../components/StatusWidgetConfig";
import type { WidgetConfig } from "./types";
import { hasCustomTimerSound } from "../timerSound";
import type { ReminderKind } from "../reminderSound";
import {
	Bell as ReminderBellIcon,
	ListChecks as TaskSoundIcon,
	CalendarClock as CalendarSoundIcon,
	CheckCircle2 as CompleteSoundIcon,
	Move as SnapSoundIcon
} from "lucide-react";

interface NotchTabProps {
	notchMode: string;
	setNotchModeValue: (mode: string) => void;
	notchEdgeDelay: number;
	handleNotchEdgeDelayChange: (val: number) => void;
	calendarEnabled: boolean;
	toggleCalendar: () => void;
	timerSoundEnabled: boolean;
	toggleTimerSound: () => void;
	timerVolume: number;
	handleTimerVolumeChange: (val: number) => void;
	timerSoundFile: string;
	timerSoundError: string;
	chooseTimerSound: () => void;
	resetTimerSound: () => void;
	previewTimerSound: () => void;
	reminderSoundEnabled: boolean;
	toggleReminderSound: () => void;
	reminderVolume: number;
	handleReminderVolumeChange: (val: number) => void;
	taskSoundFile: string;
	calendarSoundFile: string;
	completeSoundFile: string;
	snapSoundFile: string;
	reminderSoundError: string;
	chooseReminderSound: (kind: ReminderKind) => void;
	resetReminderSound: (kind: ReminderKind) => void;
	previewReminderSound: (kind: ReminderKind) => void;
	musicModeEnabled: boolean;
	toggleMusicMode: () => void;
	musicCompactNotch: boolean;
	toggleMusicCompactNotch: () => void;
	mediaLayout: "classic" | "compact";
	toggleMediaLayout: (layout: "classic" | "compact") => void;
	mediaAmbienceEnabled: boolean;
	toggleAmbience: () => void;
	mediaSmoothOpen: boolean;
	toggleSmoothOpen: () => void;
	dashKeepAlive: boolean;
	toggleDashKeepAlive: () => void;
	mediaCompactGlowEnabled: boolean;
	toggleCompactGlow: () => void;
	dashDiskVariant: 1 | 2;
	chooseDashDisk: (variant: 1 | 2) => void;
	mediaDiskVariant: 1 | 2;
	chooseMediaDisk: (variant: 1 | 2) => void;
	weatherEnabled: boolean;
	toggleWeather: () => void;
	tempUnitFahrenheit: boolean;
	toggleTempUnit: () => void;
	cityName: string;
	setCityName: (name: string) => void;
	citySearchResults: Array<{ name: string; country: string; latitude: number; longitude: number }>;
	showCityDropdown: boolean;
	setShowCityDropdown: (show: boolean) => void;
	selectCity: (city: {
		name: string;
		country: string;
		latitude: number;
		longitude: number;
	}) => void;
	handleCityClear: () => void;
	statusWidgets: WidgetConfig;
	handleWidgetsChange: (config: WidgetConfig) => void;
}

export function NotchTab({
	notchMode,
	setNotchModeValue,
	notchEdgeDelay,
	handleNotchEdgeDelayChange,
	calendarEnabled,
	toggleCalendar,
	timerSoundEnabled,
	toggleTimerSound,
	timerVolume,
	handleTimerVolumeChange,
	timerSoundFile,
	timerSoundError,
	chooseTimerSound,
	resetTimerSound,
	previewTimerSound,
	reminderSoundEnabled,
	toggleReminderSound,
	reminderVolume,
	handleReminderVolumeChange,
	taskSoundFile,
	calendarSoundFile,
	completeSoundFile,
	snapSoundFile,
	reminderSoundError,
	chooseReminderSound,
	resetReminderSound,
	previewReminderSound,
	musicModeEnabled,
	toggleMusicMode,
	musicCompactNotch,
	toggleMusicCompactNotch,
	mediaLayout,
	toggleMediaLayout,
	mediaAmbienceEnabled,
	toggleAmbience,
	mediaSmoothOpen,
	toggleSmoothOpen,
	dashKeepAlive,
	toggleDashKeepAlive,
	mediaCompactGlowEnabled,
	toggleCompactGlow,
	dashDiskVariant,
	chooseDashDisk,
	mediaDiskVariant,
	chooseMediaDisk,
	weatherEnabled,
	toggleWeather,
	tempUnitFahrenheit,
	toggleTempUnit,
	cityName,
	setCityName,
	citySearchResults,
	showCityDropdown,
	setShowCityDropdown,
	selectCity,
	handleCityClear,
	statusWidgets,
	handleWidgetsChange
}: NotchTabProps) {
	return (
		<>
			{/* Settings > Notch is split into groups, top to bottom: the notch itself, calendar and timer,
			    reminders, music, how the media screens look, how they perform, weather, status widgets. A row
			    only has a divider line under it when another row follows it in the same group. */}
			<div className="setting-group-label">Notch</div>
			<div className="setting-group">
				<SettingRow icon={PanelTop} label="Notch Behavior" desc="Choose how the notch appears" divider={notchMode !== "fixed"}>
					<select
						className="settings-select"
						value={notchMode}
						onChange={(e) => setNotchModeValue(e.target.value)}
					>
						<option value="fixed">Fixed</option>
						<option value="smart">Smart</option>
						<option value="peek">Peek</option>
					</select>
				</SettingRow>

				{notchMode !== "fixed" && (
					<SettingRow
						icon={Timer}
						label="Peek Delay"
						desc={
							notchEdgeDelay === 0
								? "Reveal instantly on top-edge contact"
								: `Rest on the top edge for ${notchEdgeDelay}ms to reveal`
						}
						divider={false}
					>
						<input
							type="range"
							min="0"
							max="800"
							step="50"
							value={notchEdgeDelay}
							onChange={(e) => handleNotchEdgeDelayChange(parseInt(e.target.value))}
							className="settings-slider"
						/>
					</SettingRow>
				)}
			</div>

			<div className="setting-group-label">Calendar &amp; Timer</div>
			<div className="setting-group">
				<SettingRow icon={Calendar} label="Calendar & Timer" desc="Enable productivity split-view" divider={calendarEnabled}>
					<label className="toggle-switch">
						<input type="checkbox" checked={calendarEnabled} onChange={toggleCalendar} />
						<span className="slider"></span>
					</label>
				</SettingRow>

				{calendarEnabled && (
					<SettingRow
						icon={BellRing}
						label="Timer Sound"
						desc="Play a chime when the timer finishes"
						divider={timerSoundEnabled}
					>
						<label className="toggle-switch">
							<input type="checkbox" checked={timerSoundEnabled} onChange={toggleTimerSound} />
							<span className="slider"></span>
						</label>
					</SettingRow>
				)}

				{calendarEnabled && timerSoundEnabled && (
					<>
						<SettingRow
							icon={Volume2}
							label="Timer Volume"
							desc={`Loudness (${timerVolume}%) — 50% is the normal level`}
						>
							<input
								type="range"
								min="0"
								max="100"
								step="5"
								value={timerVolume}
								onChange={(e) => handleTimerVolumeChange(parseInt(e.target.value))}
								className="settings-slider"
							/>
						</SettingRow>

						<SettingRow
							icon={FileAudio}
							label="Custom Sound"
							desc={
								timerSoundError ||
								(hasCustomTimerSound(timerSoundFile) ? timerSoundFile : "Built-in chime")
							}
						>
							<div className="timer-sound-actions">
								<button className="timer-sound-btn" onClick={chooseTimerSound}>
									Choose…
								</button>
								{hasCustomTimerSound(timerSoundFile) && (
									<button className="timer-sound-btn" onClick={resetTimerSound}>
										Reset
									</button>
								)}
							</div>
						</SettingRow>

						<SettingRow icon={Play} label="Preview" desc="Play the timer sound at this volume" divider={false}>
							<button className="timer-sound-btn" onClick={previewTimerSound}>
								Play
							</button>
						</SettingRow>
					</>
				)}
			</div>

			{calendarEnabled && <TimeGunSoundSettings />}

			<div className="setting-group-label">Reminders</div>
			<div className="setting-group">
				<SettingRow
					icon={ReminderBellIcon}
					label="Reminder Sounds"
					desc="Play a sound for task and calendar reminders, when a task is completed, and when a card snaps into place"
					divider={reminderSoundEnabled}
				>
					<label className="toggle-switch">
						<input type="checkbox" checked={reminderSoundEnabled} onChange={toggleReminderSound} />
						<span className="slider"></span>
					</label>
				</SettingRow>

				{reminderSoundEnabled && (
					<>
						<SettingRow
							icon={Volume2}
							label="Reminder Volume"
							desc={`Loudness (${reminderVolume}%) — 50% is the normal level`}
						>
							<input
								type="range"
								min="0"
								max="100"
								step="5"
								value={reminderVolume}
								onChange={(e) => handleReminderVolumeChange(parseInt(e.target.value))}
								className="settings-slider"
							/>
						</SettingRow>

						{(["task", "calendar", "complete", "snap"] as const).map((kind) => {
							const file =
								kind === "task"
									? taskSoundFile
									: kind === "calendar"
										? calendarSoundFile
										: kind === "complete"
											? completeSoundFile
											: snapSoundFile;
							const custom = hasCustomTimerSound(file);
							return (
								<SettingRow
									key={kind}
									divider={kind !== "snap"}
									icon={
										kind === "task"
											? TaskSoundIcon
											: kind === "calendar"
												? CalendarSoundIcon
												: kind === "complete"
													? CompleteSoundIcon
													: SnapSoundIcon
									}
									label={
										kind === "task"
											? "Task Reminder Sound"
											: kind === "calendar"
												? "Calendar Reminder Sound"
												: kind === "complete"
													? "Task Complete Sound"
													: "Card Snap Sound"
									}
									desc={
									reminderSoundError ||
									(custom ? file : kind === "snap" ? "Built-in tock" : "Built-in chime")
								}
								>
									<div className="timer-sound-actions">
										<button className="timer-sound-btn" onClick={() => chooseReminderSound(kind)}>
											Choose…
										</button>
										{custom && (
											<button className="timer-sound-btn" onClick={() => resetReminderSound(kind)}>
												Reset
											</button>
										)}
										<button className="timer-sound-btn" onClick={() => previewReminderSound(kind)}>
											Play
										</button>
									</div>
								</SettingRow>
							);
						})}
					</>
				)}
			</div>

			<div className="setting-group-label">Music</div>
			<div className="setting-group">
				<SettingRow icon={Music} label="Music Mode" desc="Interactive live music widget" divider={musicModeEnabled}>
					<label className="toggle-switch">
						<input type="checkbox" checked={musicModeEnabled} onChange={toggleMusicMode} />
						<span className="slider"></span>
					</label>
				</SettingRow>

				{musicModeEnabled && (
					<>
						<SettingRow
							icon={Minimize2}
							label="Compact Mode"
							desc="Show visualizer & artwork when collapsed"
						>
							<label className="toggle-switch">
								<input
									type="checkbox"
									checked={musicCompactNotch}
									onChange={toggleMusicCompactNotch}
								/>
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow icon={LayoutList} label="Media Layout" desc="Choose expanded player style" divider={false}>
							<div className="unit-toggle-minimal wide">
								<span
									className={mediaLayout === "classic" ? "active" : ""}
									onClick={() => toggleMediaLayout("classic")}
								>
									Classic
								</span>
								<span
									className={mediaLayout === "compact" ? "active" : ""}
									onClick={() => toggleMediaLayout("compact")}
								>
									Compact
								</span>
							</div>
						</SettingRow>
					</>
				)}
			</div>

			{musicModeEnabled && (
				<>
				<div className="setting-group-label">Media Visuals</div>
				<div className="setting-group">
						<SettingRow
							icon={Disc}
							label="Media Tab Disk"
							desc="Floppy disk on the Media tab: variant 1 is the clear black one, variant 2 is the yellow one"
						>
							<div className="unit-toggle-minimal wide">
								<span
									className={mediaDiskVariant === 1 ? "active" : ""}
									onClick={() => chooseMediaDisk(1)}
								>
									Variant 1
								</span>
								<span
									className={mediaDiskVariant === 2 ? "active" : ""}
									onClick={() => chooseMediaDisk(2)}
								>
									Variant 2
								</span>
							</div>
						</SettingRow>

						<SettingRow
							icon={Disc}
							label="Now Playing Disk"
							desc="Floppy disk on the Now Playing card: variant 1 is the clear black one, variant 2 is the yellow one"
						>
							<div className="unit-toggle-minimal wide">
								<span
									className={dashDiskVariant === 1 ? "active" : ""}
									onClick={() => chooseDashDisk(1)}
								>
									Variant 1
								</span>
								<span
									className={dashDiskVariant === 2 ? "active" : ""}
									onClick={() => chooseDashDisk(2)}
								>
									Variant 2
								</span>
							</div>
						</SettingRow>

						<SettingRow
							icon={Sparkles}
							label="Ambient Glow"
							desc="Colored glow behind expanded album art"
						>
							<label className="toggle-switch">
								<input type="checkbox" checked={mediaAmbienceEnabled} onChange={toggleAmbience} />
								<span className="slider"></span>
							</label>
						</SettingRow>

						<SettingRow
							icon={Circle}
							label="Compact Glow"
							desc="Glow around collapsed thumbnail"
							divider={false}
						>
							<label className="toggle-switch">
								<input
									type="checkbox"
									checked={mediaCompactGlowEnabled}
									onChange={toggleCompactGlow}
								/>
								<span className="slider"></span>
							</label>
						</SettingRow>
				</div>

				<div className="setting-group-label">Media Performance</div>
				<div className="setting-group">
						<SettingRow
							icon={Gauge}
							label="Smooth Open"
							desc="Load the backdrop and waveform just after the Media tab opens, so opening it doesn't stutter"
							divider={false}
						>
							<label className="toggle-switch">
								<input type="checkbox" checked={mediaSmoothOpen} onChange={toggleSmoothOpen} />
								<span className="slider"></span>
							</label>
						</SettingRow>

				</div>
				</>
			)}

			<div className="setting-group-label">Weather</div>
			<div className="setting-group">
				<SettingRow
					icon={CloudSun}
					label="Weather Status"
					desc={cityName || "Auto-detect location"}
				>
					<div className="weather-controls">
						<div className="unit-toggle-minimal" onClick={toggleTempUnit}>
							<span className={!tempUnitFahrenheit ? "active" : ""}>C</span>
							<span className={tempUnitFahrenheit ? "active" : ""}>F</span>
						</div>
						<label className="toggle-switch">
							<input type="checkbox" checked={weatherEnabled} onChange={toggleWeather} />
							<span className="slider"></span>
						</label>
					</div>
				</SettingRow>

				{weatherEnabled && (
					<div className="manual-city-input">
						<div className="city-input-row">
							<input
								type="text"
								placeholder="Search city..."
								value={cityName}
								onChange={(e) => setCityName(e.target.value)}
								onFocus={() => citySearchResults.length > 0 && setShowCityDropdown(true)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && citySearchResults.length > 0) {
										e.preventDefault();
										selectCity(citySearchResults[0]);
									}
									if (e.key === "Escape") {
										setShowCityDropdown(false);
									}
								}}
								onBlur={() => setTimeout(() => setShowCityDropdown(false), 150)}
							/>
							{cityName && (
								<button
									className="city-clear-btn"
									onMouseDown={(e) => {
										e.preventDefault();
										handleCityClear();
									}}
									title="Clear city"
								>
									<X size={10} strokeWidth={2.5} />
								</button>
							)}
						</div>
						{showCityDropdown && citySearchResults.length > 0 && (
							<div className="city-dropdown">
								{citySearchResults.map((city) => (
									<button
										key={`${city.name}-${city.latitude}`}
										className="city-dropdown-item"
										onMouseDown={(e) => {
											e.preventDefault();
											selectCity(city);
										}}
									>
										<span className="city-dropdown-name">{city.name}</span>
										<span className="city-dropdown-country">{city.country}</span>
									</button>
								))}
							</div>
						)}
					</div>
				)}
			</div>

			<div className="setting-group-label">Widgets</div>
			<div className="setting-group">
				<StatusWidgetConfig value={statusWidgets} onChange={handleWidgetsChange} />
			</div>

			<div className="setting-group-label">Experimental</div>
			<div className="setting-group">
				<SettingRow
					icon={Gauge}
					label="Keep Dashboard Loaded"
					desc="Side bar only. Builds the dashboard once and keeps it ready, so the notch opens without lag. Uses more memory and a little CPU"
					divider={false}
				>
					<label className="toggle-switch">
						<input type="checkbox" checked={dashKeepAlive} onChange={toggleDashKeepAlive} />
						<span className="slider"></span>
					</label>
				</SettingRow>
			</div>
		</>
	);
}
