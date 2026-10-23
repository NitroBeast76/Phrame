import { useEffect, useState } from "react";

// The picture on the dashboard's GIF card. The file is kept in IndexedDB (a GIF is too big for
// localStorage) and shown through an object URL. It lives at module level, so the card shows the
// picture straight away when the dashboard is hovered again, and a pick still lands if the panel
// collapses while the file dialog is open.

const DB_NAME = "bloom-dashboard";
const STORE = "kv";
const KEY = "gif";

let url: string | null = null;
let loadStarted = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

const run = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const open = indexedDB.open(DB_NAME, 1);
		open.onupgradeneeded = () => open.result.createObjectStore(STORE);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			const t = db.transaction(STORE, mode);
			const req = fn(t.objectStore(STORE));
			t.oncomplete = () => {
				db.close();
				resolve(req.result);
			};
			t.onerror = () => {
				db.close();
				reject(t.error);
			};
			t.onabort = t.onerror;
		};
	});

const show = (blob: Blob | null) => {
	if (url) URL.revokeObjectURL(url);
	url = blob ? URL.createObjectURL(blob) : null;
	emit();
};

const load = () => {
	if (loadStarted) return;
	loadStarted = true;
	run<Blob | undefined>("readonly", (s) => s.get(KEY))
		.then((blob) => {
			if (blob) show(blob);
		})
		.catch(() => {});
};

// Opens the file dialog. The input is created here, not rendered by React, so it still works if
// the dashboard unmounts while the dialog is open.
export function pickDashGif() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/gif,image/*";
	input.addEventListener("change", async () => {
		const file = input.files?.[0];
		if (!file) return;
		try {
			// Copy the bytes, so the picture survives the original file being moved or deleted.
			const blob = new Blob([await file.arrayBuffer()], { type: file.type || "image/gif" });
			show(blob);
			await run("readwrite", (s) => s.put(blob, KEY));
		} catch {
			// Still shown for this session if it could not be saved.
		}
	});
	input.click();
}

export function clearDashGif() {
	show(null);
	run("readwrite", (s) => s.delete(KEY)).catch(() => {});
}

export function useDashGif(): string | null {
	const [value, setValue] = useState(url);
	useEffect(() => {
		const sync = () => setValue(url);
		listeners.add(sync);
		load();
		sync();
		return () => {
			listeners.delete(sync);
		};
	}, []);
	return value;
}
