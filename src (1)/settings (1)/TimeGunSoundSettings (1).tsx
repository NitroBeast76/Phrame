import { useState } from "react";
import { Crosshair, Flame, RotateCcw } from "lucide-react";
import { SettingRow } from "./SettingRow";
import {
	TIMEGUN_SOUNDS,
	getTimeGunVolume,
	previewTimeGunSound,
	setTimeGunVolume,
	type TimeGunSoundKey
} from "../timeGunSound";

const ICONS = { hit: Crosshair, cock: RotateCcw, fire: Flame };

// Settings > Notch > Time Gun Sounds: one volume slider for each sound of the time gun. 100% is the loudest the sound can
// be played without clipping (timeGunSound.ts measures each sound's peak). Letting go of a slider plays the sound once.
export function TimeGunSoundSettings() {
	const [levels, setLevels] = useState<Record<TimeGunSoundKey, number>>(() => ({
		hit: getTimeGunVolume("hit"),
		cock: getTimeGunVolume("cock"),
		fire: getTimeGunVolume("fire")
	}));

	const change = (key: TimeGunSoundKey, percent: number) => {
		const level = percent / 100;
		setTimeGunVolume(key, level);
		setLevels((prev) => ({ ...prev, [key]: level }));
	};

	return (
		<>
			<div className="setting-group-label">Time Gun Sounds</div>
			<div className="setting-group">
				{TIMEGUN_SOUNDS.map(({ key, label, desc }, i) => {
					const percent = Math.round(levels[key] * 100);
					return (
						<SettingRow
							key={key}
							icon={ICONS[key]}
							label={label}
							desc={`${desc}. 100% is the loudest it can go without clipping`}
							divider={i < TIMEGUN_SOUNDS.length - 1}
						>
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<input
									type="range"
									min={0}
									max={100}
									step={1}
									value={percent}
									aria-label={`${label} volume`}
									onChange={(e) => change(key, Number(e.target.value))}
									onPointerUp={() => previewTimeGunSound(key)}
									onKeyUp={(e) => {
										if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") previewTimeGunSound(key);
									}}
								/>
								<span style={{ minWidth: 38, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{percent}%</span>
							</div>
						</SettingRow>
					);
				})}
			</div>
		</>
	);
}
