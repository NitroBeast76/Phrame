//! Backend for the wallpaper notch panel (src/WallpaperPanel.tsx).
//!
//! Ported from the Python wallpaper switcher:
//!   * wallpaper_api.py  -> `wallpaper_state` / `wallpaper_apply` (IDesktopWallpaper COM interface,
//!                          with SystemParametersInfoW as the fallback)
//!   * update-colors.ps1 -> run after every change so pywal, YASB and Bloom's palette follow
//!   * app.py hotkey     -> `start_hotkey` / `wallpaper_set_hotkey` (global Alt+A by default)
//!
//! Changing the wallpaper is the real Windows one (Settings > Personalization > Background), not an
//! overlay, so it survives reboots and works with Bloom closed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt;
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
    GetCurrentThread, GetCurrentThreadId, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
    MOD_SHIFT, MOD_WIN,
};
use windows::Win32::UI::Shell::{
    DesktopWallpaper, IDesktopWallpaper, DESKTOP_WALLPAPER_POSITION, DWPOS_CENTER, DWPOS_FILL,
    DWPOS_FIT, DWPOS_SPAN, DWPOS_STRETCH, DWPOS_TILE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowPos,
    SystemParametersInfoW, MSG, PM_NOREMOVE, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE,
    SPI_SETDESKWALLPAPER, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WM_APP,
    WM_HOTKEY,
};

const IMAGE_EXTS: [&str; 6] = ["jpg", "jpeg", "png", "bmp", "gif", "webp"];
const SKIP_DIRS: [&str; 5] = [
    "__pycache__",
    ".git",
    "$RECYCLE.BIN",
    "System Volume Information",
    "node_modules",
];
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------------------------
// Folder scan
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct WallpaperEntry {
    pub path: String,
    pub name: String,
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn scan_dir(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 8 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            scan_dir(&path, out, depth + 1);
        } else if ft.is_file() && is_image(&path) {
            out.push(path);
        }
    }
}

/// Every image under `folder` (sub-folders included), sorted by path like the Python switcher.
#[tauri::command]
pub async fn wallpaper_list(app: AppHandle, folder: String) -> Result<Vec<WallpaperEntry>, String> {
    init_cache_dir(&app);
    let warm = folder.clone();
    let list: Vec<WallpaperEntry> = tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&folder);
        if !root.is_dir() {
            return Err(format!("Folder not found: {folder}"));
        }
        let mut files = Vec::new();
        scan_dir(&root, &mut files, 0);
        files.sort_by_key(|p| p.to_string_lossy().to_lowercase());
        Ok(files
            .into_iter()
            .map(|p| WallpaperEntry {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: p.to_string_lossy().to_string(),
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())??;
    // Whatever the user browses gets its thumbnails and previews built in the background.
    kick_warmup(warm);
    Ok(list)
}

/// Native folder picker (the dialog plugin is already part of Bloom).
#[tauri::command]
pub async fn wallpaper_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app.dialog().file().blocking_pick_folder();
        match picked {
            Some(p) => p
                .into_path()
                .map(|p| Some(p.to_string_lossy().to_string()))
                .map_err(|e| e.to_string()),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------------------------
// Thumbnails: crop-to-fill JPEGs as data URLs, cached across opens (like _SHARED_THUMBS)
// ---------------------------------------------------------------------------------------------

const THUMB_LIMIT: usize = 300;
// The size the panel asks for (THUMB_W x THUMB_H in WallpaperPanel.tsx); the warm-up builds the same.
const WARM_THUMB_W: u32 = 640;
const WARM_THUMB_H: u32 = 360;
// Thumbnails built ahead of time (nearest the wallpaper in use first). Kept below THUMB_LIMIT so the
// far ones can't push the near ones out of the memory cache.
const WARM_THUMB_MAX: usize = 250;
// The disk cache (thumbnails + previews) never grows past this; the oldest files go first.
const CACHE_MAX_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Default)]
struct ThumbCache {
    map: HashMap<String, String>,
    order: VecDeque<String>,
}

static THUMBS: OnceLock<Mutex<ThumbCache>> = OnceLock::new();

fn thumbs() -> &'static Mutex<ThumbCache> {
    THUMBS.get_or_init(|| Mutex::new(ThumbCache::default()))
}

fn cache_put(cache: &Mutex<ThumbCache>, key: String, url: String, limit: usize) {
    if let Ok(mut c) = cache.lock() {
        if c.map.insert(key.clone(), url).is_none() {
            c.order.push_back(key);
        }
        while c.order.len() > limit {
            if let Some(old) = c.order.pop_front() {
                c.map.remove(&old);
            }
        }
    }
}

// --- Disk cache: thumbnails and previews survive a restart of Bloom --------------------------------

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

fn init_cache_dir(app: &AppHandle) {
    if CACHE_DIR.get().is_some() {
        return;
    }
    if let Ok(dir) = app.path().app_cache_dir() {
        let dir = dir.join("wallpaper");
        let _ = std::fs::create_dir_all(dir.join("thumbs"));
        let _ = std::fs::create_dir_all(dir.join("previews"));
        let _ = std::fs::create_dir_all(dir.join("palettes"));
        let _ = CACHE_DIR.set(dir);
    }
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The wallpaper's file name as a safe prefix for its cache files ("sunset beach.png" -> "sunset-beach").
/// Every cache file of a wallpaper (thumbnail, preview, palette) is "<this>-<hash>.<ext>", so they are
/// easy to find and delete by hand.
fn cache_stem(path: &str) -> String {
    let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("wallpaper");
    let mut out = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(40).collect();
    if out.is_empty() { "wallpaper".to_string() } else { out }
}

/// Cache file for `path`: the name changes when the picture is edited, so stale copies are never used.
fn disk_cache_file_ext(kind: &str, path: &str, tag: &str, ext: &str) -> Option<PathBuf> {
    let dir = CACHE_DIR.get()?;
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = format!("{}|{}|{}|{}", path.to_lowercase(), meta.len(), mtime, tag);
    Some(dir.join(kind).join(format!("{}-{:016x}.{}", cache_stem(path), fnv1a(&key), ext)))
}

fn disk_cache_file(kind: &str, path: &str, tag: &str) -> Option<PathBuf> {
    disk_cache_file_ext(kind, path, tag, "jpg")
}

/// The pywal palette of a wallpaper (colors.css text), kept next to its thumbnail and preview.
const PALETTE_TAG: &str = "palette-v1";
fn palette_file(path: &str) -> Option<PathBuf> {
    disk_cache_file_ext("palettes", path, PALETTE_TAG, "css")
}

fn jpeg_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn disk_read(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(jpeg_data_url(&bytes))
}

fn disk_write(file: &Path, jpeg: &[u8]) {
    let tmp = file.with_extension("tmp");
    if std::fs::write(&tmp, jpeg).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

/// Cache file names that belong to the pictures that exist right now.
fn cache_names(paths: &[String]) -> HashSet<std::ffi::OsString> {
    let thumb_tag = format!("{WARM_THUMB_W}x{WARM_THUMB_H}-{THUMB_CROP_TAG}");
    let preview_tag = format!("{PREVIEW_MAX_W}x{PREVIEW_MAX_H}");
    let mut keep = HashSet::new();
    for p in paths {
        if let Some(name) = palette_file(p).as_ref().and_then(|f| f.file_name()) {
            keep.insert(name.to_os_string());
        }
        for (kind, tag) in [("thumbs", &thumb_tag), ("previews", &preview_tag)] {
            if let Some(file) = disk_cache_file(kind, p, tag) {
                if let Some(name) = file.file_name() {
                    keep.insert(name.to_os_string());
                }
            }
        }
    }
    keep
}

/// Deletes cache files of pictures that were deleted, moved or edited (and of folders no longer used).
fn remove_orphans(keep: &HashSet<std::ffi::OsString>) {
    let Some(dir) = CACHE_DIR.get() else {
        return;
    };
    for (kind, ext) in [("thumbs", "jpg"), ("previews", "jpg"), ("palettes", "css")] {
        let Ok(read) = std::fs::read_dir(dir.join(kind)) else {
            continue;
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some(ext) {
                continue;
            }
            if !keep.contains(&entry.file_name()) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Keeps the cache under `max_bytes`: previews (big, cheap to rebuild) go first, then thumbnails,
/// the oldest first, until the cache is down to 80% of the limit.
fn enforce_cache_cap(max_bytes: u64) {
    let Some(dir) = CACHE_DIR.get() else {
        return;
    };
    // (0 = preview / 1 = thumbnail, written at, size, file)
    let mut files: Vec<(u8, std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total: u64 = 0;
    for (rank, kind) in [(0u8, "previews"), (1u8, "thumbs")] {
        let Ok(read) = std::fs::read_dir(dir.join(kind)) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            total += meta.len();
            let written = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            files.push((rank, written, meta.len(), entry.path()));
        }
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|f| (f.0, f.1));
    let target = max_bytes / 10 * 8;
    for (_, _, len, path) in files {
        if total <= target {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

// Windows' "Fill" cuts a picture that is taller than the screen off at the top and bottom, but not
// evenly: only this fraction of the surplus comes off the top (measured: a third, not a half).
// Keep in step with FILL_Y in WallpaperPreview.tsx.
const FILL_ANCHOR_Y: f64 = 1.0 / 3.0;
// Part of the thumbnail cache file names: bump it when the crop changes, the old files are then dropped.
const THUMB_CROP_TAG: &str = "y33";

/// Scales `img` to cover width x height and cuts the rest off the way Windows' "Fill" does: centred
/// sideways, and FILL_ANCHOR_Y of the vertical surplus taken from the top.
fn cover_crop(img: &image::DynamicImage, width: u32, height: u32) -> image::RgbImage {
    let (iw, ih) = (img.width() as f64, img.height() as f64);
    let scale = (width as f64 / iw).max(height as f64 / ih);
    let nw = ((iw * scale).round() as u32).max(width);
    let nh = ((ih * scale).round() as u32).max(height);
    let resized = img.resize_exact(nw, nh, image::imageops::FilterType::Triangle);
    let x = (nw - width) / 2;
    let y = ((nh - height) as f64 * FILL_ANCHOR_Y).round() as u32;
    resized.crop_imm(x, y, width, height).to_rgb8()
}

fn make_thumbnail_jpeg(path: &str, width: u32, height: u32) -> Result<Vec<u8>, String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    let img = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    let thumb = cover_crop(&img, width, height);
    let mut buf: Vec<u8> = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, 82)
        .write_image(thumb.as_raw(), width, height, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Thumbnail as a data URL: memory, then the disk cache, then decoded from the picture.
fn thumb_data_url(path: &str, width: u32, height: u32) -> Result<String, String> {
    let key = format!("{path}|{width}x{height}");
    if let Ok(cache) = thumbs().lock() {
        if let Some(hit) = cache.map.get(&key) {
            return Ok(hit.clone());
        }
    }
    let file = disk_cache_file("thumbs", path, &format!("{width}x{height}-{THUMB_CROP_TAG}"));
    let url = match file.as_ref().and_then(|f| disk_read(f)) {
        Some(url) => url,
        None => {
            let jpeg = make_thumbnail_jpeg(path, width, height)?;
            if let Some(f) = &file {
                disk_write(f, &jpeg);
            }
            jpeg_data_url(&jpeg)
        }
    };
    cache_put(thumbs(), key, url.clone(), THUMB_LIMIT);
    Ok(url)
}

#[tauri::command]
pub async fn wallpaper_thumbnail(path: String, width: u32, height: u32) -> Result<String, String> {
    let width = width.clamp(16, 1024);
    let height = height.clamp(16, 1024);
    tauri::async_runtime::spawn_blocking(move || thumb_data_url(&path, width, height))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------------------------
// Preview on the real screen, without applying anything
//
// The picture is drawn by a window of its own ("wp-preview": index.html -> main.tsx ->
// src/WallpaperPreview.tsx). It is NOT topmost: it is slipped into the z-order directly above the
// desktop, so everything draws over it the way it would over the real wallpaper - app windows, the
// Windows taskbar, the Bloom dock and the notch. Desktop icons are hidden while it is up.
// It has no IPC of its own; this file talks to its page with eval().
// ---------------------------------------------------------------------------------------------

const PREVIEW_LABEL: &str = "wp-preview";
// The window starts this many physical pixels above the top of the screen (and is that much taller), so whatever
// shaves its top corners - Windows rounds them - falls off-screen. The page lays its picture out on the real
// screen rectangle (PREVIEW_TOP_BLEED in WallpaperPreview.tsx), so the wallpaper sits exactly where it would.
const PREVIEW_TOP_BLEED: i32 = 12;
const PREVIEW_MAX_W: u32 = 1920;
const PREVIEW_MAX_H: u32 = 1080;
const PREVIEW_LIMIT: usize = 20;
// Keep in step with FADE_OUT_MS in WallpaperPreview.tsx.
const PREVIEW_FADE_OUT_MS: u64 = 200;
// After the wallpaper was set, the preview stays up until Windows has painted the new one (otherwise
// the fade-out shows the OLD wallpaper for a moment before the new one pops in). While it is up it
// covers the screen, so this should be as short as possible:
// - once Explorer's wallpaper cache files changed and then stayed quiet for SETTLE, Windows is done
//   (MIN is a floor after the apply call returned, in case that signal comes early),
// - if no change in those files is ever seen, leave after FALLBACK (Windows needs about 1.2 s),
//   which is why MIN must not be lower than that: the fade-out starts at the moment of leaving, and
//   until Windows has painted, what shines through is still the old wallpaper,
// - in any case leave after MAX.
// If the old wallpaper flashes up briefly before the new one appears, raise MIN / FALLBACK.
const PREVIEW_PAINT_MIN_MS: u64 = 1300;
const PREVIEW_PAINT_SETTLE_MS: u64 = 300;
const PREVIEW_PAINT_FALLBACK_MS: u64 = 1500;
const PREVIEW_PAINT_MAX_MS: u64 = 5000;

/// Newest change among the files Explorer writes when it renders a new wallpaper.
fn newest_wallpaper_cache_mtime() -> std::time::SystemTime {
    let mut newest = std::time::UNIX_EPOCH;
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return newest;
    };
    let dir = PathBuf::from(appdata).join("Microsoft").join("Windows").join("Themes");
    let mut check = |p: &Path| {
        if let Ok(t) = std::fs::metadata(p).and_then(|m| m.modified()) {
            if t > newest {
                newest = t;
            }
        }
    };
    check(&dir.join("TranscodedWallpaper"));
    if let Ok(read) = std::fs::read_dir(dir.join("CachedFiles")) {
        for entry in read.flatten() {
            check(&entry.path());
        }
    }
    newest
}

/// One line into <cache dir>\wallpaper\repaint.log: when the preview left and why (kept small).
fn log_line(line: &str) {
    use std::io::Write;
    let Some(dir) = CACHE_DIR.get() else {
        return;
    };
    let file = dir.join("repaint.log");
    if std::fs::metadata(&file).map(|m| m.len() > 50_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&file);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{line}");
    }
}

// What newest_wallpaper_cache_mtime() was right before the last wallpaper_apply.
static APPLY_BEFORE: Mutex<Option<std::time::SystemTime>> = Mutex::new(None);

// The files above only say that Explorer has started working, not that the new wallpaper is on screen: a big picture
// takes longer to decode, Explorer writes more than once, SetPosition repaints again, and Windows fades the old
// wallpaper into the new one. So the preview also looks at the desktop itself. Right before the wallpaper is applied
// the preview is hidden from screen capture (it stays on screen as it is) and the desktop under it is photographed
// small; after that it is photographed again and again until it has changed and then stayed still. It can only make the
// preview stay longer, never leave earlier than the rules above allow. Set PREVIEW_PROBE to false to switch it off.
const PREVIEW_PROBE: bool = true;
// A look at the screen differs from the one before the apply by at least this share of pixels: the wallpaper changed.
const PREVIEW_PROBE_MOVED: f32 = 0.03;
// Two looks in a row differing by less than this share count as the same.
const PREVIEW_PROBE_STILL: f32 = 0.006;
// How long the screen has to stay the same after it changed (Windows' fade-in is over by then).
const PREVIEW_PROBE_STILL_MS: u64 = 400;
// If the screen never changes (the desktop is covered by windows, or the two wallpapers look alike) leave after this.
const PREVIEW_PAINT_NOCHANGE_MS: u64 = 2800;

/// Looking at the real desktop under the preview window.
mod probe {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    /// The size every look is shrunk to.
    pub const W: usize = 128;
    pub const H: usize = 72;

    /// BGRA, W * H pixels.
    pub struct Frame(pub Vec<u8>);

    /// Hides (true) or shows (false) `hwnd` to screen capture; the window itself stays on screen as it is.
    /// False when Windows refuses (before Windows 10 version 2004).
    pub fn exclude(hwnd: HWND, on: bool) -> bool {
        let how = if on { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        unsafe { SetWindowDisplayAffinity(hwnd, how).is_ok() }
    }

    /// The screen rectangle (physical pixels), shrunk to W x H.
    pub fn grab(x: i32, y: i32, w: i32, h: i32) -> Option<Frame> {
        if w <= 0 || h <= 0 {
            return None;
        }
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return None;
            }
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, W as i32, H as i32);
            let mut out = None;
            if !mem.is_invalid() && !bmp.is_invalid() {
                let old = SelectObject(mem, bmp.into());
                let _ = SetStretchBltMode(mem, HALFTONE);
                let copied = StretchBlt(
                    mem,
                    0,
                    0,
                    W as i32,
                    H as i32,
                    Some(screen),
                    x,
                    y,
                    w,
                    h,
                    SRCCOPY | CAPTUREBLT,
                );
                if copied.as_bool() {
                    let mut info = BITMAPINFO::default();
                    info.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: W as i32,
                        biHeight: -(H as i32), // top-down
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    };
                    let mut pixels = vec![0u8; W * H * 4];
                    let lines = GetDIBits(
                        mem,
                        bmp,
                        0,
                        H as u32,
                        Some(pixels.as_mut_ptr() as *mut c_void),
                        &mut info,
                        DIB_RGB_COLORS,
                    );
                    if lines == H as i32 {
                        out = Some(Frame(pixels));
                    }
                }
                SelectObject(mem, old);
            }
            if !bmp.is_invalid() {
                let _ = DeleteObject(bmp.into());
            }
            if !mem.is_invalid() {
                let _ = DeleteDC(mem);
            }
            ReleaseDC(None, screen);
            out
        }
    }

    /// Share (0..1) of the pixels that differ between two looks. Only the middle of the screen counts: the notch is
    /// above it and the dock below, and they move while the panel closes.
    pub fn difference(a: &Frame, b: &Frame) -> f32 {
        let (y0, y1) = (H * 30 / 100, H * 92 / 100);
        let (mut diff, mut total) = (0u32, 0u32);
        for y in y0..y1 {
            for x in 0..W {
                let i = (y * W + x) * 4;
                let d: i32 = (0..3).map(|c| (a.0[i + c] as i32 - b.0[i + c] as i32).abs()).sum();
                if d > 36 {
                    diff += 1;
                }
                total += 1;
            }
        }
        diff as f32 / total.max(1) as f32
    }
}

/// The desktop as it looked right before the last wallpaper_apply, and where it was photographed.
struct ProbeBase {
    frame: probe::Frame,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    hwnd: isize,
}
static PROBE_BASE: Mutex<Option<ProbeBase>> = Mutex::new(None);
static PROBE_EPOCH: AtomicU64 = AtomicU64::new(0);

fn probe_show_again(hwnd: isize) {
    let _ = probe::exclude(HWND(hwnd as *mut c_void), false);
}

/// Hides the preview from screen capture and photographs the desktop under it, right before the wallpaper is applied.
/// Does nothing when no preview is up.
fn probe_begin(app: &AppHandle) {
    if let Ok(mut base) = PROBE_BASE.lock() {
        if let Some(old) = base.take() {
            probe_show_again(old.hwnd);
        }
    }
    if !PREVIEW_UP.load(Ordering::SeqCst) {
        return;
    }
    let Some(win) = app.get_webview_window(PREVIEW_LABEL) else {
        return;
    };
    let (Ok(hwnd), Ok(pos), Ok(size)) = (win.hwnd(), win.outer_position(), win.outer_size()) else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    if !probe::exclude(HWND(hwnd as *mut c_void), true) {
        return;
    }
    // The change takes a frame or two to reach the compositor.
    std::thread::sleep(Duration::from_millis(80));
    // The window starts PREVIEW_TOP_BLEED above the screen (see place_preview).
    let (x, y) = (pos.x, pos.y + PREVIEW_TOP_BLEED);
    let (w, h) = (size.width as i32, size.height as i32 - PREVIEW_TOP_BLEED);
    let Some(frame) = probe::grab(x, y, w, h) else {
        probe_show_again(hwnd);
        return;
    };
    if let Ok(mut base) = PROBE_BASE.lock() {
        *base = Some(ProbeBase { frame, x, y, w, h, hwnd });
    }
    // However the preview ends, the window must not stay hidden from capture.
    let epoch = PROBE_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(PREVIEW_PAINT_MAX_MS + 3000));
        if PROBE_EPOCH.load(Ordering::SeqCst) == epoch {
            probe_show_again(hwnd);
        }
    });
}

/// The preview was dropped without a wallpaper being applied: show it to screen capture again.
fn probe_cancel() {
    if let Ok(mut base) = PROBE_BASE.lock() {
        if let Some(old) = base.take() {
            probe_show_again(old.hwnd);
        }
    }
}

/// Shows the preview to screen capture again when it goes out of scope.
struct ProbeGuard(ProbeBase);
impl Drop for ProbeGuard {
    fn drop(&mut self) {
        probe_show_again(self.0.hwnd);
    }
}

/// Blocks until Windows seems to have painted the new wallpaper (see the constants above). False if a
/// newer preview request took over meanwhile.
fn wait_for_repaint(seq: u64, fallback_ms: u64) -> bool {
    let start = Instant::now();
    let mut last_seen = APPLY_BEFORE
        .lock()
        .ok()
        .and_then(|m| *m)
        .unwrap_or_else(newest_wallpaper_cache_mtime);
    let mut changed = false;
    let mut last_change = Instant::now();
    // The desktop itself (see PREVIEW_PROBE): has it changed since before the apply, and has it stayed still since?
    let watch = PROBE_BASE.lock().ok().and_then(|mut b| b.take()).map(ProbeGuard);
    let mut screen_moved = false;
    let mut screen_still_since = Instant::now();
    let mut screen_prev: Option<probe::Frame> = None;
    loop {
        if PREVIEW_SEQ.load(Ordering::SeqCst) != seq {
            return false;
        }
        let now = newest_wallpaper_cache_mtime();
        if now > last_seen {
            if !changed {
                log_line(&format!("explorer files changed after {} ms", start.elapsed().as_millis()));
            }
            last_seen = now;
            changed = true;
            last_change = Instant::now();
        }
        let elapsed = start.elapsed().as_millis() as u64;
        if let Some(ProbeGuard(p)) = watch.as_ref() {
            if let Some(look) = probe::grab(p.x, p.y, p.w, p.h) {
                if !screen_moved && probe::difference(&look, &p.frame) > PREVIEW_PROBE_MOVED {
                    screen_moved = true;
                    screen_still_since = Instant::now();
                    log_line(&format!("desktop changed after {elapsed} ms"));
                }
                if let Some(prev) = screen_prev.as_ref() {
                    if probe::difference(&look, prev) > PREVIEW_PROBE_STILL {
                        screen_still_since = Instant::now();
                    }
                }
                screen_prev = Some(look);
            }
        }
        let files_done = if changed {
            elapsed >= PREVIEW_PAINT_MIN_MS
                && last_change.elapsed().as_millis() as u64 >= PREVIEW_PAINT_SETTLE_MS
        } else {
            elapsed >= fallback_ms
        };
        let screen_done = match watch {
            None => true,
            Some(_) if screen_moved => {
                screen_still_since.elapsed().as_millis() as u64 >= PREVIEW_PROBE_STILL_MS
            }
            Some(_) => elapsed >= PREVIEW_PAINT_NOCHANGE_MS,
        };
        if (files_done && screen_done) || elapsed >= PREVIEW_PAINT_MAX_MS {
            let why = if elapsed >= PREVIEW_PAINT_MAX_MS {
                "limit"
            } else if changed {
                "files settled"
            } else {
                "no file change seen, fallback"
            };
            let screen = match (&watch, screen_moved) {
                (None, _) => "not watched",
                (Some(_), true) => "changed and still",
                (Some(_), false) => "never changed",
            };
            log_line(&format!("preview left after {elapsed} ms ({why}; desktop {screen})"));
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
// A freshly built webview needs a moment before its page can take a script.
const PREVIEW_WARMUP_MS: u64 = 900;

// Bumped by every show / end, so a slower earlier request can tell it has been overtaken.
static PREVIEW_SEQ: AtomicU64 = AtomicU64::new(0);
static PREVIEW_UP: AtomicBool = AtomicBool::new(false);
static PREVIEW_BORN: Mutex<Option<Instant>> = Mutex::new(None);
static PREVIEW_LAST: Mutex<String> = Mutex::new(String::new());
// "path|style" of the sharp picture that is up right now (empty while only a thumbnail is).
static PREVIEW_FULL: Mutex<String> = Mutex::new(String::new());

static PREVIEWS: OnceLock<Mutex<ThumbCache>> = OnceLock::new();

fn previews() -> &'static Mutex<ThumbCache> {
    PREVIEWS.get_or_init(|| Mutex::new(ThumbCache::default()))
}

/// Screen-sized JPEG of the file: same aspect ratio, never scaled up. The fit style (fill / fit /
/// stretch ...) is applied by CSS in the preview page.
fn make_preview_jpeg(path: &str) -> Result<Vec<u8>, String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageEncoder};

    let img = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;
    // thumbnail() is the fast downscaler; it would also scale a small picture up, so skip it then.
    let small = if img.width() > PREVIEW_MAX_W || img.height() > PREVIEW_MAX_H {
        img.thumbnail(PREVIEW_MAX_W, PREVIEW_MAX_H).to_rgb8()
    } else {
        img.to_rgb8()
    };
    let (w, h) = small.dimensions();
    let mut buf: Vec<u8> = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, 85)
        .write_image(small.as_raw(), w, h, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// The screen-sized picture if it is already in memory.
fn preview_cached(path: &str) -> Option<String> {
    previews().lock().ok().and_then(|c| c.map.get(path).cloned())
}

/// Memory, then the disk cache, then decoded from the picture. With `to_memory` false it only makes
/// sure the disk copy exists (background pre-rendering of pictures that are far away).
fn preview_build(path: &str, to_memory: bool) -> Result<Option<String>, String> {
    if let Some(hit) = preview_cached(path) {
        return Ok(Some(hit));
    }
    let file = disk_cache_file("previews", path, &format!("{PREVIEW_MAX_W}x{PREVIEW_MAX_H}"));
    if let Some(f) = &file {
        if f.is_file() {
            if !to_memory {
                return Ok(None);
            }
            if let Some(url) = disk_read(f) {
                cache_put(previews(), path.to_string(), url.clone(), PREVIEW_LIMIT);
                return Ok(Some(url));
            }
        }
    }
    let jpeg = make_preview_jpeg(path)?;
    if let Some(f) = &file {
        disk_write(f, &jpeg);
    }
    if to_memory {
        let url = jpeg_data_url(&jpeg);
        cache_put(previews(), path.to_string(), url.clone(), PREVIEW_LIMIT);
        Ok(Some(url))
    } else {
        Ok(None)
    }
}

async fn preview_url(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() || !is_image(&p) {
        return Err(format!("Not an image file: {path}"));
    }
    if let Some(hit) = preview_cached(&path) {
        return Ok(hit);
    }
    let url = tauri::async_runtime::spawn_blocking(move || preview_build(&path, true))
        .await
        .map_err(|e| e.to_string())??;
    url.ok_or_else(|| "preview unavailable".to_string())
}

// WebView2 makes every window that shares a profile use the same browser arguments, and a window with
// different ones cannot be created. The four windows in tauri.conf.json run with the no-throttling flags
// (they keep the notch smooth), but the preview window does not need them, so it gets a profile of its
// own and runs with the defaults. If that folder cannot be resolved it falls back to the same flags as
// the other windows, which are kept in step with "additionalBrowserArgs" in tauri.conf.json.
const WEBVIEW_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling";

fn preview_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(PREVIEW_LABEL) {
        return Ok(w);
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        PREVIEW_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Bloom wallpaper preview")
    .decorations(false)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible(false);
    builder = match app.path().app_local_data_dir() {
        Ok(dir) => builder.data_directory(dir.join("wp-preview-webview")),
        Err(_) => builder.additional_browser_args(WEBVIEW_ARGS),
    };
    let w = builder.build().map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true);
    if let Ok(mut born) = PREVIEW_BORN.lock() {
        *born = Some(Instant::now());
    }
    Ok(w)
}

/// The window that holds the desktop icons: Progman, or a WorkerW when a live-wallpaper app runs.
fn desktop_icon_host() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).ok()?;
        if FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
            return Some(progman);
        }
        let mut prev: Option<HWND> = None;
        while let Ok(worker) = FindWindowExW(None, prev, w!("WorkerW"), PCWSTR::null()) {
            if FindWindowExW(Some(worker), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
                return Some(worker);
            }
            prev = Some(worker);
        }
        Some(progman)
    }
}

/// Cover the monitor Bloom lives on and sit directly above the desktop in the z-order.
fn place_preview(app: &AppHandle, win: &tauri::WebviewWindow) -> bool {
    let Some(host) = desktop_icon_host() else {
        return false;
    };
    if !PREVIEW_UP.load(Ordering::SeqCst) {
        // The overlay is full screen on the monitor Bloom is using, so copy its rectangle.
        let mut sized = false;
        if let Some(ov) = app.get_webview_window("overlay") {
            if let (Ok(pos), Ok(size)) = (ov.outer_position(), ov.outer_size()) {
                let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y - PREVIEW_TOP_BLEED));
                let _ = win.set_size(tauri::PhysicalSize::new(
                    size.width,
                    size.height + PREVIEW_TOP_BLEED as u32,
                ));
                sized = true;
            }
        }
        if !sized {
            if let Ok(Some(m)) = app.primary_monitor() {
                let _ = win.set_position(tauri::PhysicalPosition::new(
                    m.position().x,
                    m.position().y - PREVIEW_TOP_BLEED,
                ));
                let _ = win.set_size(tauri::PhysicalSize::new(
                    m.size().width,
                    m.size().height + PREVIEW_TOP_BLEED as u32,
                ));
            }
        }
    }
    // The preview must never catch the mouse (taskbar, desktop icons ...): say so on every show.
    let _ = win.set_ignore_cursor_events(true);
    let Ok(hwnd) = win.hwnd() else {
        return false;
    };
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(host),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }
    PREVIEW_UP.store(true, Ordering::SeqCst);
    true
}

/// Waits out the first moments of a new preview window; true if a newer request took over meanwhile.
async fn preview_warmup(seq: u64) -> bool {
    let age = PREVIEW_BORN.lock().ok().and_then(|b| *b).map(|t| t.elapsed());
    if let Some(age) = age {
        let need = Duration::from_millis(PREVIEW_WARMUP_MS);
        if age < need {
            let wait = need - age;
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait)).await;
        }
    }
    PREVIEW_SEQ.load(Ordering::SeqCst) != seq
}

fn full_is_up(path: &str, style: &str) -> bool {
    PREVIEW_FULL
        .lock()
        .map(|f| *f == format!("{path}|{style}"))
        .unwrap_or(false)
}

fn preview_show(win: &tauri::WebviewWindow, src: &str, style: &str, path: &str, full: bool) {
    if let Ok(mut f) = PREVIEW_FULL.lock() {
        *f = if full { format!("{path}|{style}") } else { String::new() };
    }
    // Same picture as the last call = the sharp version replacing its thumbnail (shorter fade).
    let sharpen = match PREVIEW_LAST.lock() {
        Ok(mut last) => {
            let same = last.as_str() == path;
            *last = path.to_string();
            same
        }
        Err(_) => false,
    };
    // src is a base64 data URL and style one of a few plain words, so no escaping is needed.
    let _ = win.eval(&format!(
        "window.__wpv&&window.__wpv.show('{src}','{style}',{sharpen})"
    ));
}

/// Builds the (hidden) preview window ahead of time, so it is ready when the first picture arrives.
#[tauri::command]
pub async fn wallpaper_preview_prepare(app: AppHandle) -> Result<(), String> {
    preview_window(&app).map(|_| ())
}

/// Shows `path` in the preview window. `thumb` (a small data URL) is drawn straight away; with
/// `full` the screen-sized picture follows once it has been decoded.
#[tauri::command]
pub async fn wallpaper_preview_show(
    app: AppHandle,
    path: String,
    style: String,
    thumb: Option<String>,
    full: bool,
) -> Result<(), String> {
    let seq = PREVIEW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    schedule_palette_preview(&app, &path);
    let win = preview_window(&app)?;
    if preview_warmup(seq).await {
        return Ok(());
    }
    let style: String = style.chars().filter(|c| c.is_ascii_alphanumeric()).collect();

    // Already decoded (start-up warm-up, prefetch)? Then skip the blurry thumbnail and draw the sharp
    // picture straight away.
    if let Some(url) = preview_cached(&path) {
        if PREVIEW_SEQ.load(Ordering::SeqCst) == seq
            && !full_is_up(&path, &style)
            && place_preview(&app, &win)
        {
            preview_show(&win, &url, &style, &path, true);
        }
        return Ok(());
    }

    if let Some(t) = thumb {
        let plain = |c: char| c.is_ascii_alphanumeric() || "+/=:;,.-".contains(c);
        if t.starts_with("data:image/") && t.chars().all(plain) && place_preview(&app, &win) {
            preview_show(&win, &t, &style, &path, false);
        }
    }
    if full {
        let url = preview_url(path.clone()).await?;
        if PREVIEW_SEQ.load(Ordering::SeqCst) != seq {
            return Ok(());
        }
        if !full_is_up(&path, &style) && place_preview(&app, &win) {
            preview_show(&win, &url, &style, &path, true);
        }
    }
    Ok(())
}

/// Fades the preview out, then hides the window. `hold` 0 = at once (the preview was abandoned).
/// `hold` > 0 = a wallpaper was just applied: the preview stays up until Windows has painted it
/// (wait_for_repaint), so the fade-out reveals the new wallpaper and not the old one. The number
/// itself is not used, only that it is not 0.
#[tauri::command]
pub fn wallpaper_preview_end(app: AppHandle, hold: u64) {
    let seq = PREVIEW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    end_palette_preview(&app, hold);
    if hold == 0 {
        probe_cancel();
    }
    let Some(win) = app.get_webview_window(PREVIEW_LABEL) else {
        return;
    };
    if let Ok(mut last) = PREVIEW_LAST.lock() {
        last.clear();
    }
    if let Ok(mut full) = PREVIEW_FULL.lock() {
        full.clear();
    }
    std::thread::spawn(move || {
        if hold > 0 && !wait_for_repaint(seq, PREVIEW_PAINT_FALLBACK_MS) {
            return;
        }
        let _ = win.eval("window.__wpv&&window.__wpv.end(0)");
        std::thread::sleep(Duration::from_millis(PREVIEW_FADE_OUT_MS + 80));
        if PREVIEW_SEQ.load(Ordering::SeqCst) == seq {
            let _ = win.hide();
            PREVIEW_UP.store(false, Ordering::SeqCst);
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Colour preview: while a wallpaper is previewed, the rest of Bloom shows the colours it would get.
// The palette is made the same way update-colors.ps1 makes it (pywal on the picture, then the same
// blends into colors.css), but pywal writes into a temporary cache folder, so the real palette, YASB
// and komorebi are never touched. Every window gets it as "pywal-preview" and paints it without
// saving anything (theme.ts); "pywal-preview-end" puts the saved colours back. Setting
// "bloom-wallpaper-preview-colors" = "false" turns it off.
// ---------------------------------------------------------------------------------------------

static PALETTE_TICKET: AtomicU64 = AtomicU64::new(0);
static PALETTE_PATH: Mutex<String> = Mutex::new(String::new());
static PALETTE_RUN: Mutex<()> = Mutex::new(());
static PALETTES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
const PALETTE_DELAY_MS: u64 = 250; // the picture must stay selected this long before pywal runs
const PALETTE_WAL_TIMEOUT: Duration = Duration::from_secs(20);

fn palettes() -> &'static Mutex<HashMap<String, String>> {
    PALETTES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// PowerShell's [Math]::Round (halves go to the even number), so the blends match the script.
fn round_even(x: f64) -> i64 {
    let f = x.floor();
    let d = x - f;
    let lo = f as i64;
    if d < 0.5 {
        lo
    } else if d > 0.5 {
        lo + 1
    } else if lo % 2 == 0 {
        lo
    } else {
        lo + 1
    }
}

fn hex_rgb(hex: &str) -> Option<[i64; 3]> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some([((v >> 16) & 255) as i64, ((v >> 8) & 255) as i64, (v & 255) as i64])
}

fn blend(fixed: [i64; 3], wall: [i64; 3], amount: f64) -> (String, [i64; 3]) {
    let mut out = [0i64; 3];
    for i in 0..3 {
        out[i] = round_even(fixed[i] as f64 * (1.0 - amount) + wall[i] as f64 * amount);
    }
    (format!("#{:02x}{:02x}{:02x}", out[0], out[1], out[2]), out)
}

/// The same colors.css update-colors.ps1 writes, built from pywal's colors.json.
fn palette_css(j: &serde_json::Value) -> Option<String> {
    let c = |n: u32| -> Option<String> {
        j.get("colors")?.get(format!("color{n}"))?.as_str().map(|s| s.to_string())
    };
    let wall_bg = hex_rgb(j.get("special")?.get("background")?.as_str()?)?;
    let tint = hex_rgb(&c(4)?)?;
    let (base, bg) = blend([30, 30, 46], wall_bg, 0.7);
    let (text, _) = blend([205, 214, 244], tint, 0.4);
    let (sub1, _) = blend([186, 194, 222], tint, 0.35);
    let (sub0, _) = blend([166, 173, 200], tint, 0.35);
    let bg_csv = format!("{}, {}, {}", bg[0], bg[1], bg[2]);
    let border_csv = format!("{}, {}, {}", tint[0], tint[1], tint[2]);
    Some(format!(
        ":root {{\n    --rosewater: {};\n    --flamingo: {};\n    --pink: {};\n    --mauve: {};\n    --red: {};\n    --maroon: {};\n    --peach: {};\n    --yellow: {};\n    --green: {};\n    --teal: {};\n    --sky: {};\n    --sapphire: {};\n    --blue: {};\n    --lavender: {};\n    --text: {text};\n    --subtext1: {sub1};\n    --subtext0: {sub0};\n    --overlay2: #9399b2;\n    --overlay1: #7f849c;\n    --overlay0: #6c7086;\n    --surface2: #585b70;\n    --surface1: #45475a;\n    --surface0: #282936;\n    --base: {base};\n    --mantle: rgba({bg_csv}, 0.75);\n    --crust: rgba({bg_csv}, 0.75);\n    --glass: rgba({bg_csv}, 0.75);\n    --glass-strong: rgba({bg_csv}, 0.9);\n    --glass-border: rgba({border_csv}, 0.35);\n    --glass-highlight: rgba(255, 255, 255, 0.06);\n    --bar-bg: {base};\n}}",
        c(15)?, c(9)?, c(13)?, c(5)?, c(1)?, c(9)?, c(11)?, c(3)?, c(2)?, c(6)?, c(14)?, c(12)?, c(4)?, c(13)?
    ))
}

/// Runs pywal on `path` with its cache folder moved to a temporary one, same flags as the script.
fn palette_lookup(path: &str) -> Option<String> {
    if let Some(css) = palettes().lock().ok()?.get(path) {
        return Some(css.clone());
    }
    let css = std::fs::read_to_string(palette_file(path)?).ok()?;
    if !css.contains("--base:") {
        return None;
    }
    if let Ok(mut m) = palettes().lock() {
        if m.len() >= 64 {
            m.clear();
        }
        m.insert(path.to_string(), css.clone());
    }
    Some(css)
}

fn compute_palette(path: &str) -> Option<String> {
    if let Some(css) = palette_lookup(path) {
        return Some(css);
    }
    let _run = PALETTE_RUN.lock().ok()?;
    let dir = std::env::temp_dir().join(format!("bloom-wal-preview-{:x}", fnv1a(path)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    // Find wal the way update-colors.ps1 does: rebuild PATH from the registry first.
    let script = r#"$p = @([Environment]::GetEnvironmentVariable('Path','User'), [Environment]::GetEnvironmentVariable('Path','Machine')) -join ';'; $env:Path = "$p;$env:Path"; $w = Get-Command wal -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $w) { exit 2 }; $exe = if ($w.CommandType -eq 'Application') { $w.Source } else { 'wal' }; & $exe -s -t -e -q -n -i $env:BLOOM_PREVIEW_IMAGE"#;
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script])
        .env("XDG_CACHE_HOME", &dir)
        .env("BLOOM_PREVIEW_IMAGE", path)
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PALETTE_WAL_TIMEOUT => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = std::fs::remove_dir_all(&dir);
                return None;
            }
        }
    }
    let json = std::fs::read_to_string(dir.join("wal").join("colors.json")).ok();
    let _ = std::fs::remove_dir_all(&dir);
    let css = palette_css(&serde_json::from_str::<serde_json::Value>(&json?).ok()?)?;
    if let Some(file) = palette_file(path) {
        disk_write(&file, css.as_bytes());
    }
    if let Ok(mut m) = palettes().lock() {
        if m.len() >= 64 {
            m.clear();
        }
        m.insert(path.to_string(), css.clone());
    }
    Some(css)
}

/// Called for every preview. Waits for the picture to stay selected (unless its palette is already
/// known), then tells every window which colours it would give.
fn schedule_palette_preview(app: &AppHandle, path: &str) {
    init_cache_dir(app);
    if crate::utils::get_setting_str(app, "bloom-wallpaper-preview-colors").as_deref() == Some("false") {
        return;
    }
    {
        let Ok(mut last) = PALETTE_PATH.lock() else { return };
        if last.as_str() == path {
            return; // the same picture again (thumbnail, then the sharp one)
        }
        *last = path.to_string();
    }
    let ticket = PALETTE_TICKET.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    let path = path.to_string();
    std::thread::spawn(move || {
        lower_thread_priority();
        let known = palette_lookup(&path);
        if known.is_none() {
            std::thread::sleep(Duration::from_millis(PALETTE_DELAY_MS));
            if PALETTE_TICKET.load(Ordering::SeqCst) != ticket {
                return;
            }
        }
        let Some(css) = known.or_else(|| compute_palette(&path)) else { return };
        if PALETTE_TICKET.load(Ordering::SeqCst) == ticket {
            let _ = app.emit("pywal-preview", css);
        }
    });
}

/// The preview is over. Abandoned (`hold` 0): the saved colours come back at once. Applied: the new
/// palette arrives as "pywal-colors-changed" and replaces the preview by itself, so only a late
/// safety net is needed (the colour update may be turned off or fail).
fn end_palette_preview(app: &AppHandle, hold: u64) {
    let ticket = PALETTE_TICKET.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut last) = PALETTE_PATH.lock() {
        last.clear();
    }
    if hold == 0 {
        let _ = app.emit("pywal-preview-end", ());
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(12));
        if PALETTE_TICKET.load(Ordering::SeqCst) == ticket {
            let _ = app.emit("pywal-preview-end", ());
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Deleting a wallpaper from the picker: the picture goes to the Recycle Bin (so it can be restored)
// and every cache file made for it is removed: thumbnail, preview and palette.
// ---------------------------------------------------------------------------------------------

fn cache_forget(cache: &Mutex<ThumbCache>, gone: impl Fn(&str) -> bool) {
    if let Ok(mut c) = cache.lock() {
        c.map.retain(|k, _| !gone(k));
        c.order.retain(|k| !gone(k));
    }
}

/// Removes every cache file of the wallpaper named `stem` (they all start with "<stem>-").
fn remove_cache_files(stem: &str) -> usize {
    let Some(dir) = CACHE_DIR.get() else {
        return 0;
    };
    let prefix = format!("{stem}-");
    let mut removed = 0;
    for kind in ["thumbs", "previews", "palettes"] {
        let Ok(read) = std::fs::read_dir(dir.join(kind)) else {
            continue;
        };
        for entry in read.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) && std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

fn send_to_recycle_bin(path: &str) -> Result<(), String> {
    let script = r#"Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:BLOOM_DELETE_PATH, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"#;
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script])
        .env("BLOOM_DELETE_PATH", path)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() || Path::new(path).exists() {
        return Err("Couldn't move the file to the Recycle Bin".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn wallpaper_delete(app: AppHandle, path: String) -> Result<(), String> {
    init_cache_dir(&app);
    let p = Path::new(&path);
    if !is_image(p) || !p.is_file() {
        return Err("Not an image file".to_string());
    }
    let stem = cache_stem(&path);
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || send_to_recycle_bin(&target))
        .await
        .map_err(|e| e.to_string())??;
    // The picture is gone: forget everything made from it.
    let prefix = format!("{path}|");
    cache_forget(thumbs(), |k| k.starts_with(&prefix));
    cache_forget(previews(), |k| k == path);
    if let Ok(mut m) = palettes().lock() {
        m.remove(&path);
    }
    if let Ok(mut last) = PALETTE_PATH.lock() {
        if *last == path {
            last.clear();
        }
    }
    remove_cache_files(&stem);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Pre-rendering: previews around the selection, and everything at start-up
// ---------------------------------------------------------------------------------------------

static PREFETCH_TICKET: AtomicU64 = AtomicU64::new(0);
static WARM_FOLDER: Mutex<String> = Mutex::new(String::new());

fn lower_thread_priority() {
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

fn same_file(a: &str, b: &str) -> bool {
    a.replace('/', "\\").to_lowercase() == b.replace('/', "\\").to_lowercase()
}

/// Runs `job(i)` for every i in 0..count on `workers` threads and waits for them.
fn run_pool(count: usize, workers: usize, job: impl Fn(usize) + Sync) {
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| {
                lower_thread_priority();
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= count {
                        break;
                    }
                    job(i);
                }
            });
        }
    });
}

/// Decodes the screen-sized pictures of `paths` (most important first) in the background, so that
/// previewing them later is instant. A newer call replaces one that is still running.
#[tauri::command]
pub fn wallpaper_preview_prefetch(paths: Vec<String>) {
    let ticket = PREFETCH_TICKET.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        lower_thread_priority();
        for path in paths.into_iter().take(12) {
            if PREFETCH_TICKET.load(Ordering::SeqCst) != ticket {
                break;
            }
            let p = PathBuf::from(&path);
            if !p.is_file() || !is_image(&p) {
                continue;
            }
            let _ = preview_build(&path, true);
        }
    });
}

fn last_folder_file() -> Option<PathBuf> {
    CACHE_DIR.get().map(|d| d.join("last_folder.txt"))
}

fn save_last_folder(folder: &str) {
    if let Some(f) = last_folder_file() {
        let _ = std::fs::write(f, folder);
    }
}

fn read_last_folder() -> Option<String> {
    let s = std::fs::read_to_string(last_folder_file()?).ok()?;
    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Starts pre-rendering `folder` unless that is already under way (or done) in this run.
fn kick_warmup(folder: String) {
    {
        let Ok(mut cur) = WARM_FOLDER.lock() else {
            return;
        };
        if *cur == folder {
            return;
        }
        *cur = folder.clone();
    }
    save_last_folder(&folder);
    std::thread::spawn(move || warm_folder(folder));
}

fn warm_folder(folder: String) {
    lower_thread_priority();
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return;
    }
    let mut found = Vec::new();
    scan_dir(&root, &mut found, 0);
    found.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    let paths: Vec<String> = found.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let n = paths.len();
    // (An empty or missing folder - e.g. a drive that is not connected - never wipes the cache.)
    if n == 0 {
        return;
    }
    // Housekeeping: cache files of pictures that are gone or edited, then the size cap.
    remove_orphans(&cache_names(&paths));
    enforce_cache_cap(CACHE_MAX_BYTES);
    let current = on_sta(read_state).map(|s| s.current).unwrap_or_default();
    let start = paths.iter().position(|p| same_file(p, &current)).unwrap_or(0);

    // The wallpaper in use first, then outwards in both directions: the order it gets scrolled in.
    let mut seen: HashSet<usize> = HashSet::new();
    let mut order: Vec<usize> = vec![start];
    seen.insert(start);
    for k in 1..=(n / 2 + 1) {
        for i in [(start + k) % n, (start + n - k % n) % n] {
            if seen.insert(i) {
                order.push(i);
            }
        }
        if order.len() >= WARM_THUMB_MAX {
            break;
        }
    }

    let live = || WARM_FOLDER.lock().map(|c| *c == folder).unwrap_or(false);

    // 1. Screen-sized pictures of the nearest neighbours, into memory: what the first key press needs.
    let near: Vec<&String> = order.iter().skip(1).take(6).map(|&i| &paths[i]).collect();
    run_pool(near.len(), 2, |i| {
        if live() {
            let _ = preview_build(near[i], true);
        }
    });
    // 2. Thumbnails, nearest first.
    let all: Vec<&String> = order.iter().map(|&i| &paths[i]).collect();
    run_pool(all.len(), 2, |i| {
        if live() {
            let _ = thumb_data_url(all[i], WARM_THUMB_W, WARM_THUMB_H);
        }
    });
    // 3. A few more screen-sized pictures, on disk only.
    let more: Vec<&String> = order.iter().skip(7).take(18).map(|&i| &paths[i]).collect();
    run_pool(more.len(), 2, |i| {
        if live() {
            let _ = preview_build(more[i], false);
        }
    });
    // Pre-rendering added files: stay within the limit.
    enforce_cache_cap(CACHE_MAX_BYTES);
}

/// Called once when Bloom starts: builds the preview window and pre-renders the folder that was
/// browsed last time, so the first time the panel opens everything is ready.
pub fn start_warmup(app: AppHandle) {
    init_cache_dir(&app);
    std::thread::spawn(move || {
        lower_thread_priority();
        std::thread::sleep(Duration::from_millis(800));
        // The preview window needs a moment to start up; do that now instead of at the first preview.
        if let Err(e) = preview_window(&app) {
            log_line(&format!("preview window failed: {e}"));
        }
        if let Some(folder) = read_last_folder() {
            kick_warmup(folder);
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Setting the wallpaper (IDesktopWallpaper, wallpaper_api.py)
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct MonitorInfo {
    pub index: u32,
    pub id: String,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize)]
pub struct WallpaperState {
    /// Path of the wallpaper in use right now (empty if it can't be read).
    pub current: String,
    pub monitors: Vec<MonitorInfo>,
    /// False when IDesktopWallpaper is unavailable and only the legacy all-monitors call works.
    pub per_monitor: bool,
}

/// Runs `f` on a fresh thread with its own single-threaded COM apartment, like wallpaper_api.py,
/// so Tauri's worker threads never end up with a COM apartment they did not ask for.
fn on_sta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    std::thread::spawn(move || unsafe {
        let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let out = f();
        if inited {
            CoUninitialize();
        }
        out
    })
    .join()
    .map_err(|_| "wallpaper thread panicked".to_string())
}

fn position_for(style: &str) -> DESKTOP_WALLPAPER_POSITION {
    match style {
        "center" => DWPOS_CENTER,
        "tile" => DWPOS_TILE,
        "stretch" => DWPOS_STRETCH,
        "fit" => DWPOS_FIT,
        "span" => DWPOS_SPAN,
        _ => DWPOS_FILL,
    }
}

unsafe fn take_pwstr(p: windows::core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const c_void));
    s
}

unsafe fn desktop_wallpaper() -> windows::core::Result<IDesktopWallpaper> {
    CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)
}

fn read_state() -> WallpaperState {
    unsafe {
        let Ok(dw) = desktop_wallpaper() else {
            return WallpaperState {
                current: String::new(),
                monitors: Vec::new(),
                per_monitor: false,
            };
        };
        let mut monitors = Vec::new();
        if let Ok(count) = dw.GetMonitorDevicePathCount() {
            for i in 0..count {
                let Ok(id_ptr) = dw.GetMonitorDevicePathAt(i) else {
                    continue;
                };
                let id = take_pwstr(id_ptr);
                let wide = HSTRING::from(id.as_str());
                let (w, h) = match dw.GetMonitorRECT(PCWSTR(wide.as_ptr())) {
                    Ok(r) => (r.right - r.left, r.bottom - r.top),
                    Err(_) => (0, 0),
                };
                monitors.push(MonitorInfo {
                    index: i,
                    id,
                    width: w,
                    height: h,
                });
            }
        }
        let mut current = dw
            .GetWallpaper(PCWSTR::null())
            .map(|p| take_pwstr(p))
            .unwrap_or_default();
        if current.is_empty() {
            // Different wallpapers per monitor: Windows answers "none" for "all monitors", so take the
            // first monitor's own.
            for m in &monitors {
                let wide = HSTRING::from(m.id.as_str());
                if let Ok(p) = dw.GetWallpaper(PCWSTR(wide.as_ptr())) {
                    let s = take_pwstr(p);
                    if !s.is_empty() {
                        current = s;
                        break;
                    }
                }
            }
        }
        WallpaperState {
            current,
            monitors,
            per_monitor: true,
        }
    }
}

#[tauri::command]
pub async fn wallpaper_state() -> Result<WallpaperState, String> {
    tauri::async_runtime::spawn_blocking(|| on_sta(read_state))
        .await
        .map_err(|e| e.to_string())?
}

fn apply_com(path: &str, monitor: Option<u32>, style: &str) -> Result<(), String> {
    unsafe {
        let dw = desktop_wallpaper().map_err(|e| e.to_string())?;
        let monitor_id: Option<HSTRING> = match monitor {
            Some(index) => {
                let count = dw.GetMonitorDevicePathCount().map_err(|e| e.to_string())?;
                if index >= count {
                    return Err(format!("no monitor {index}"));
                }
                let id = take_pwstr(dw.GetMonitorDevicePathAt(index).map_err(|e| e.to_string())?);
                Some(HSTRING::from(id.as_str()))
            }
            None => None,
        };
        let monitor_ptr = monitor_id
            .as_ref()
            .map(|h| PCWSTR(h.as_ptr()))
            .unwrap_or(PCWSTR::null());
        let wide_path = HSTRING::from(path);
        dw.SetWallpaper(monitor_ptr, PCWSTR(wide_path.as_ptr()))
            .map_err(|e| e.to_string())?;
        // Position is cosmetic: a failure here must not fail the whole change.
        let _ = dw.SetPosition(position_for(style));
        Ok(())
    }
}

/// Legacy path (no per-monitor support): SystemParametersInfoW on all monitors.
fn apply_legacy(path: &str) -> Result<(), String> {
    let mut wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(wide.as_mut_ptr() as *mut c_void),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
        .map_err(|e| e.to_string())
    }
}

/// Where update-colors.ps1 lives unless the setting says otherwise.
fn default_colors_script() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("yasb")
        .join("update-colors.ps1")
}

/// Fire-and-forget: refresh the pywal palette for the new wallpaper. Bloom watches the palette
/// file (watch_pywal_palette), so its colours follow without any further call from here.
fn run_color_update(image: String, script: Option<String>) {
    std::thread::spawn(move || {
        let script_path = script
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_colors_script);
        let mut cmd = if script_path.is_file() {
            let mut c = std::process::Command::new("powershell.exe");
            c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
                .arg(&script_path)
                .arg(&image);
            c
        } else {
            // No script: ask pywal directly, same flags the script uses.
            let mut c = std::process::Command::new("wal");
            c.args(["-s", "-t", "-e", "-q", "-n", "-i"]).arg(&image);
            c
        };
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(mut child) = cmd.spawn() {
            let _ = child.wait();
        }
    });
}

/// Applies `path` as the wallpaper. `monitor` None = every monitor. `style` is one of
/// fill / fit / stretch / tile / center / span. Unless `update_colors` is false the pywal palette
/// is refreshed afterwards.
#[tauri::command]
pub async fn wallpaper_apply(
    app: AppHandle,
    path: String,
    monitor: Option<u32>,
    style: Option<String>,
    update_colors: Option<bool>,
    colors_script: Option<String>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() || !is_image(&p) {
        return Err(format!("Not an image file: {path}"));
    }
    let style = style.unwrap_or_else(|| "fill".to_string());
    let path_for_set = path.clone();
    if PREVIEW_PROBE {
        // (the old desktop, photographed under the preview, before it changes)
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || probe_begin(&app)).await;
    }
    if let Ok(mut before) = APPLY_BEFORE.lock() {
        *before = Some(newest_wallpaper_cache_mtime());
    }
    let applied = tauri::async_runtime::spawn_blocking(move || {
        on_sta(move || match apply_com(&path_for_set, monitor, &style) {
            Ok(()) => Ok(()),
            // COM unavailable: fall back to the all-monitors call.
            Err(_) if monitor.is_none() => apply_legacy(&path_for_set),
            Err(e) => Err(e),
        })
    })
    .await
    .map_err(|e| e.to_string())?; // join error
    applied??; // thread panic, then the apply error itself
    if update_colors.unwrap_or(true) {
        run_color_update(path, colors_script);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Global hotkey (Alt+A by default)
// ---------------------------------------------------------------------------------------------

const HOTKEY_ID: i32 = 0x57_41; // "WA"
const WM_REBIND: u32 = WM_APP + 1;
const DEFAULT_HOTKEY: &str = "alt+a";

static HOTKEY_THREAD: AtomicU32 = AtomicU32::new(0);
static PENDING_SPEC: Mutex<Option<String>> = Mutex::new(None);
static CURRENT_SPEC: Mutex<String> = Mutex::new(String::new());
static PENDING_REPLY: Mutex<Option<mpsc::Sender<Result<(), String>>>> = Mutex::new(None);

/// "alt+a", "ctrl+shift+w", "win+f9" ... -> (modifiers, virtual-key code).
fn parse_hotkey(spec: &str) -> Result<(HOT_KEY_MODIFIERS, u32), String> {
    let mut mods = HOT_KEY_MODIFIERS(0);
    let mut key: Option<u32> = None;
    for part in spec.split('+').map(|p| p.trim().to_ascii_lowercase()) {
        match part.as_str() {
            "" => {}
            "alt" => mods |= MOD_ALT,
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "shift" => mods |= MOD_SHIFT,
            "win" | "super" | "meta" => mods |= MOD_WIN,
            "space" => key = Some(0x20),
            k if k.len() == 1 && k.as_bytes()[0].is_ascii_alphanumeric() => {
                key = Some(k.as_bytes()[0].to_ascii_uppercase() as u32);
            }
            k if k.starts_with('f') && k[1..].parse::<u32>().map(|n| (1..=12).contains(&n)).unwrap_or(false) => {
                key = Some(0x70 + k[1..].parse::<u32>().unwrap() - 1);
            }
            other => return Err(format!("Unknown key in hotkey: {other}")),
        }
    }
    match key {
        Some(k) if mods.0 != 0 => Ok((mods, k)),
        Some(_) => Err("Add a modifier (alt, ctrl, shift or win)".to_string()),
        None => Err("No key in hotkey".to_string()),
    }
}

fn rebind(spec: &str) -> Result<(), String> {
    let (mods, vk) = parse_hotkey(spec)?;
    unsafe {
        let _ = UnregisterHotKey(None, HOTKEY_ID);
        match RegisterHotKey(None, HOTKEY_ID, mods | MOD_NOREPEAT, vk) {
            Ok(()) => {
                if let Ok(mut cur) = CURRENT_SPEC.lock() {
                    *cur = spec.to_string();
                }
                Ok(())
            }
            Err(_) => {
                // Put the previous key back so a failed change never leaves the panel without one.
                let prev = CURRENT_SPEC.lock().map(|c| c.clone()).unwrap_or_default();
                if let Ok((pm, pk)) = parse_hotkey(&prev) {
                    let _ = RegisterHotKey(None, HOTKEY_ID, pm | MOD_NOREPEAT, pk);
                }
                Err(format!("{spec} is already taken by another app"))
            }
        }
    }
}

/// Starts the hotkey thread (a thread-level hotkey needs its own message loop). Safe to call once
/// from `setup`. Emits `wallpaper-hotkey` every time the key is pressed.
pub fn start_hotkey(app: AppHandle) {
    std::thread::spawn(move || unsafe {
        // Touch the queue so PostThreadMessageW can reach this thread.
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        HOTKEY_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);

        if let Err(e) = rebind(DEFAULT_HOTKEY) {
            let _ = app.emit("wallpaper-hotkey-error", e);
        }
        loop {
            let got = GetMessageW(&mut msg, None, 0, 0);
            if got.0 <= 0 {
                break;
            }
            if msg.message == WM_HOTKEY && msg.wParam.0 as i32 == HOTKEY_ID {
                let _ = app.emit("wallpaper-hotkey", ());
            } else if msg.message == WM_REBIND {
                let spec = PENDING_SPEC.lock().ok().and_then(|mut s| s.take());
                let reply = PENDING_REPLY.lock().ok().and_then(|mut r| r.take());
                if let Some(spec) = spec {
                    let result = rebind(&spec);
                    if let Some(tx) = reply {
                        let _ = tx.send(result);
                    }
                }
            }
        }
        let _ = UnregisterHotKey(None, HOTKEY_ID);
    });
}

/// Changes the hotkey at runtime (e.g. "alt+a" -> "ctrl+alt+w"). Returns an error when the combo
/// is invalid or another app already owns it; the previous key then stays registered.
#[tauri::command]
pub async fn wallpaper_set_hotkey(hotkey: String) -> Result<(), String> {
    parse_hotkey(&hotkey)?; // reject bad input before touching the live hotkey
    let thread = HOTKEY_THREAD.load(Ordering::SeqCst);
    if thread == 0 {
        return Err("Hotkey thread is not running yet".to_string());
    }
    let (tx, rx) = mpsc::channel();
    if let Ok(mut s) = PENDING_SPEC.lock() {
        *s = Some(hotkey);
    }
    if let Ok(mut r) = PENDING_REPLY.lock() {
        *r = Some(tx);
    }
    unsafe {
        PostThreadMessageW(thread, WM_REBIND, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "Timed out registering the hotkey".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hotkeys() {
        let (m, k) = parse_hotkey("alt+a").unwrap();
        assert_eq!(m.0, MOD_ALT.0);
        assert_eq!(k, 'A' as u32);
        let (m, k) = parse_hotkey("ctrl+shift+f9").unwrap();
        assert_eq!(m.0, (MOD_CONTROL | MOD_SHIFT).0);
        assert_eq!(k, 0x78);
        assert!(parse_hotkey("a").is_err());
        assert!(parse_hotkey("alt").is_err());
    }
}
