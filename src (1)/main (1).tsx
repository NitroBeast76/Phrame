import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import WallpaperPreview from "./WallpaperPreview";

// The wallpaper preview window ("wp-preview", built in wallpaper.rs) loads this same page but only
// draws the preview, not the whole Bloom UI.
let isPreview = false;
try {
	isPreview = getCurrentWebviewWindow().label === "wp-preview";
} catch {
	// not running inside Tauri
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>{isPreview ? <WallpaperPreview /> : <App />}</React.StrictMode>
);
