//! The picture or gif shown beside the cover in the Media tab. The chosen file is
//! copied as-is (so gifs keep their animation) and handed to the frontend as a
//! data URI.

use base64::{engine::general_purpose, Engine};
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 12 * 1024 * 1024;
const EXTENSIONS: [&str; 5] = ["gif", "png", "jpg", "jpeg", "webp"];

fn slot_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("profile");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir)
}

/// The saved file, whichever extension it has.
fn find_slot_file(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    EXTENSIONS
        .iter()
        .map(|ext| dir.join(format!("media-slot.{ext}")))
        .find(|p| p.is_file())
}

fn remove_slot_files(dir: &std::path::Path) {
    for ext in EXTENSIONS {
        let _ = std::fs::remove_file(dir.join(format!("media-slot.{ext}")));
    }
}

/// Checks the file really is the image type its extension claims.
fn mime_for(bytes: &[u8], ext: &str) -> Option<&'static str> {
    match ext {
        "gif" if bytes.starts_with(b"GIF8") => Some("image/gif"),
        "png" if bytes.starts_with(&[0x89, b'P', b'N', b'G']) => Some("image/png"),
        "jpg" | "jpeg" if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) => Some("image/jpeg"),
        "webp" if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            Some("image/webp")
        }
        _ => None,
    }
}

fn to_data_uri(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = mime_for(&bytes, &ext)?;
    Some(format!(
        "data:{mime};base64,{}",
        general_purpose::STANDARD.encode(&bytes)
    ))
}

/// The saved picture as a data URI, or None when none was chosen.
#[tauri::command]
pub async fn get_media_slot(app: AppHandle) -> Option<String> {
    let dir = slot_dir(&app).ok()?;
    tauri::async_runtime::spawn_blocking(move || to_data_uri(&find_slot_file(&dir)?))
        .await
        .ok()
        .flatten()
}

/// Copies the chosen gif or image into Bloom's settings folder and returns it.
#[tauri::command]
pub async fn set_media_slot(app: AppHandle, path: String) -> Result<String, String> {
    let dir = slot_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let src = std::path::PathBuf::from(&path);
        let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > MAX_BYTES {
            return Err("Pick a gif or image under 12 MB".to_string());
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !EXTENSIONS.contains(&ext.as_str()) {
            return Err("Use a gif, png, jpg or webp file".to_string());
        }
        let bytes = std::fs::read(&src).map_err(|e| e.to_string())?;
        if mime_for(&bytes, &ext).is_none() {
            return Err("That file isn't a valid image".to_string());
        }
        remove_slot_files(&dir);
        let dest = dir.join(format!("media-slot.{ext}"));
        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        to_data_uri(&dest).ok_or_else(|| "Couldn't read the saved picture".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_media_slot(app: AppHandle) -> Result<(), String> {
    let dir = slot_dir(&app)?;
    remove_slot_files(&dir);
    Ok(())
}
