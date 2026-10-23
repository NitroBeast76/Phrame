import { useEffect, useState } from "react";

// Which floppy disk to draw: 1 is the clear black one, 2 is the yellow one. "dash" is the Now Playing
// card, "media" is the Media tab; each has its own setting (Settings > Notch). App.tsx mirrors the
// settings onto the root element (data-dash-disk, data-mt-disk), the same way it does for smooth
// open, and this hook follows them, so changing the setting changes the disk straight away.
type Which = "dash" | "media";
export type DiskVariant = 1 | 2;

const ATTR = { dash: "data-dash-disk", media: "data-mt-disk" } as const;
const KEY = { dash: "bloom-dash-disk-variant", media: "bloom-media-disk-variant" } as const;
// What it was before this setting existed: black on the card, yellow on the Media tab.
const DEFAULT: Record<Which, DiskVariant> = { dash: 1, media: 2 };

function read(which: Which): DiskVariant {
	let v: string | null = document.documentElement.getAttribute(ATTR[which]);
	// Before App.tsx has mirrored it (the first render), use the saved value.
	if (v === null) {
		try {
			v = localStorage.getItem(KEY[which]);
		} catch {
			v = null;
		}
	}
	return v === "1" ? 1 : v === "2" ? 2 : DEFAULT[which];
}

export function useDiskVariant(which: Which): DiskVariant {
	const [variant, setVariant] = useState<DiskVariant>(() => read(which));
	useEffect(() => {
		const update = () => setVariant(read(which));
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR[which]] });
		return () => observer.disconnect();
	}, [which]);
	return variant;
}
