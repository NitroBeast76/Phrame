//! Small on-disk cache for the dashboard's slow-to-read info (profile details and picture), kept in
//! the app cache folder (`<app cache dir>/ui/`). The UI shows it straight away and refreshes it in
//! the background, so opening the notch never waits on these reads.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Only these files can be touched, so a name from the UI can never point outside the folder.
const ALLOWED: [&str; 2] = ["profile.json", "avatar.txt"];

fn cache_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("unknown cache file: {name}"));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ui");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// The cached text, or None when there is nothing cached yet.
#[tauri::command]
pub async fn ui_cache_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = cache_file(&app, &name)?;
        match std::fs::read_to_string(file) {
            Ok(text) if !text.is_empty() => Ok(Some(text)),
            _ => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the text; a null value deletes the cached file.
#[tauri::command]
pub async fn ui_cache_write(
    app: AppHandle,
    name: String,
    value: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = cache_file(&app, &name)?;
        match value {
            Some(text) => {
                // Write then rename, so a crash never leaves half a file behind.
                let tmp = file.with_extension("tmp");
                std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
            }
            None => {
                let _ = std::fs::remove_file(&file);
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
