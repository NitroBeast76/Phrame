//! Vertical side bar ("sidebar" window): own appbar, own mode (fixed / smart / peek).
//! Self-contained so it does not touch the bottom dock's statics.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
// Same glob imports main.rs uses, so re_assert_topmost / unregister_appbar_native /
// reconcile_main_appbar resolve wherever they are defined.
use crate::services::*;
use crate::utils::*;

pub static SIDEBAR_APPBAR_REGISTERED: AtomicBool = AtomicBool::new(false);
static SIDEBAR_WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);
static SIDEBAR_ENABLED: AtomicBool = AtomicBool::new(false);

/// True while the side bar is on. While it is, the notch has no pill and reserves no band at the
/// top, whatever the saved notch mode says (see `get_setting_str`).
pub fn sidebar_is_enabled() -> bool {
    SIDEBAR_ENABLED.load(Ordering::Relaxed)
}
// 0 = fixed, 1 = smart, 2 = peek
static SIDEBAR_MODE: AtomicI32 = AtomicI32::new(1);
static SIDEBAR_OVERLAP: AtomicBool = AtomicBool::new(false);
// Extra logical width (px) the bar window has while a popup is open beside the bar. 0 = closed.
// geometry() adds it, so enforce_bar and every re-place keep the wider window instead of undoing it.
static SIDEBAR_POPUP_W: AtomicI32 = AtomicI32::new(0);
// True while the power menu is open: the bar window then covers the whole monitor, so the page can dim the
// screen and draw the menu on the far edge. geometry() honours it like SIDEBAR_POPUP_W.
static SIDEBAR_FULL: AtomicBool = AtomicBool::new(false);
// Where the Windows tray popup should open: the screen y (physical px) of the bar's tray button, and
// when the button was pressed. Only used for a few seconds after a press (see tray_flyout_pos).
static TRAY_ANCHOR_Y: AtomicI32 = AtomicI32::new(0);
static TRAY_ANCHOR_AT: AtomicI64 = AtomicI64::new(0);
// The window that had focus the last time the watcher looked (see track_focus).
static LAST_FOREGROUND: AtomicI64 = AtomicI64::new(0);
// True while the thin top strip should be on screen (see sync_frame / enforce_frame).
static FRAME_WANTED: AtomicBool = AtomicBool::new(false);
/// True while a fullscreen app is in front and the bar and its strip are hidden for it.
static SIDEBAR_FS_HIDDEN: AtomicBool = AtomicBool::new(false);
// Logical width of the bar window in px (bar + hover margin) and the reserved strip.
const BAR_WINDOW_W: f64 = 72.0;
// Logical width of the bar itself (--sb-bar-w in Sidebar.css).
const BAR_W: f64 = 56.0;
// The bar is BAR_W wide, but the work area it reserves is FRAME_STRIP_H
// narrower. Windows keep a gap from the work-area edge; on the far side the thin strip covers part of that
// gap, so only a few px of desktop show between the strip and a window. Reserving the same amount less here
// makes the gap beside the bar the same size.
const BAR_RESERVE_W: f64 = BAR_W - FRAME_STRIP_H;
// Height (logical px) of the thin strip along the top edge that joins the bar and the notch.
// Keep it equal to --sb-strip in Sidebar.css.
const FRAME_STRIP_H: f64 = 11.0;
// How far (logical px) the frame window reaches above the top of the screen. Keep it equal to
// FRAME_BLEED in SidebarFrame.tsx.
const FRAME_BLEED_PX: f64 = 16.0;
/// How far the frame window stops short of the screen bottom when there is no taskbar above it. 0 = it
/// reaches the bottom edge. Windows no longer counts the frame as a fullscreen window because it is marked
/// non-rude (see set_tool_window_styles), so no gap is needed. If Windows or Windhawk still report a
/// fullscreen app with the bar on, set this back to 1 (a transparent, invisible edge row).
const FRAME_UNCOVER_PX: i32 = 0;
// The strip's window is taller than the strip it reserves: the extra part is transparent and
// click-through, and is where the curved joins to the open notch are drawn.
#[allow(dead_code)]
const FRAME_WINDOW_H: f64 = 96.0;

fn mode_from_str(m: &str) -> i32 {
    match m {
        "fixed" => 0,
        "peek" => 2,
        _ => 1,
    }
}

fn side_is_right(app: &AppHandle) -> bool {
    crate::utils::get_setting_str(app, "bloom-sidebar-side").as_deref() == Some("right")
}

fn monitor_rect(win: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
    let m = crate::utils::target_monitor(win.app_handle()).ok().flatten()?;
    let p = m.position();
    let s = m.size();
    Some((p.x, p.y, s.width as i32, s.height as i32, m.scale_factor()))
}

/// Geometry in physical px: (x, y, w, h, reserve_w)
fn geometry(win: &tauri::WebviewWindow, right: bool) -> Option<(i32, i32, i32, i32, i32)> {
    let (mx, my, mw, mh, scale) = monitor_rect(win)?;
    let bloom_scale = crate::utils::get_bloom_scale(win.app_handle());
    let popup = SIDEBAR_POPUP_W.load(Ordering::Relaxed) as f64;
    let full = SIDEBAR_FULL.load(Ordering::Relaxed);
    let w = if full { mw } else { (((BAR_WINDOW_W + popup) * bloom_scale) * scale) as i32 };
    let r = ((BAR_RESERVE_W * bloom_scale) * scale) as i32;
    // Full height, flush with the top of the screen: the bar's top end sits where the notch
    // slides out, so the two read as one frame. The notch is centred, so they never overlap.
    let x = if right { mx + mw - w } else { mx };
    // End where the frame ends (above a visible taskbar; a hidden or auto-hidden one is ignored), so
    // the bar's bottom meets the frame's bottom strip.
    let bottom = taskbar_top(mx, my, mw, mh).unwrap_or(my + mh);
    Some((x, my, w, (bottom - my).max(1), r))
}

/// Windows 11 rounds the corners of every top-level window. On the full-screen frame that shows as a
/// few pixels of desktop at the screen corners, so ask DWM not to.
fn no_round_corners(hwnd: HWND) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    let pref = DWMWCP_DONOTROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
    }
}

fn place(win: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) {
    if let Ok(hwnd) = win.hwnd() {
        no_round_corners(hwnd);
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER,
            };
            let _ = SetWindowPos(
                hwnd,
                None,
                x,
                y,
                w,
                h,
                SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
        re_assert_topmost(hwnd);
    }
}

fn set_tool_window_styles(hwnd: HWND) {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetPropW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
            WS_EX_TOOLWINDOW,
        };
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as usize;
        ex |= (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as usize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize);
        // "Non-rude" window: the shell skips it when it decides whether a fullscreen app is in front
        // (the same check that hides the taskbar and makes SHQueryUserNotificationState report busy,
        // which is what Windhawk's pause-on-fullscreen reads). Without this the full-monitor frame
        // window counted as a fullscreen app. The property has to be set on the top-level window.
        let _ = SetPropW(
            hwnd,
            windows::core::w!("NonRudeHWND"),
            Some(windows::Win32::Foundation::HANDLE(1usize as *mut std::ffi::c_void)),
        );
    }
}

pub fn register_sidebar_appbar(win: tauri::WebviewWindow) {
    let right = side_is_right(win.app_handle());
    let Some((x, y, w, h, reserve)) = geometry(&win, right) else {
        return;
    };
    let Ok(hwnd) = win.hwnd() else { return };
    unsafe {
        use windows::Win32::UI::Shell::{
            SHAppBarMessage, ABE_LEFT, ABE_RIGHT, ABM_NEW, ABM_QUERYPOS, ABM_SETPOS, APPBARDATA,
        };
        set_tool_window_styles(hwnd);
        let mut abd = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: hwnd,
            ..Default::default()
        };
        if !SIDEBAR_APPBAR_REGISTERED.load(Ordering::Relaxed) {
            SHAppBarMessage(ABM_NEW, &mut abd);
            SIDEBAR_APPBAR_REGISTERED.store(true, Ordering::Relaxed);
        }
        abd.uEdge = if right { ABE_RIGHT } else { ABE_LEFT };
        abd.rc = if right {
            RECT { left: x + w - reserve, top: y, right: x + w, bottom: y + h }
        } else {
            RECT { left: x, top: y, right: x + reserve, bottom: y + h }
        };
        SHAppBarMessage(ABM_QUERYPOS, &mut abd);
        SHAppBarMessage(ABM_SETPOS, &mut abd);
    }
    // The window is wider than the reserved strip (hover margin / shadow room);
    // position it ourselves rather than trusting the shell-corrected rect.
    place(&win, x, y, w, h);
    let _ = win.show();
}

fn unregister(win: &tauri::WebviewWindow) {
    if let Ok(hwnd) = win.hwnd() {
        unregister_appbar_native(hwnd);
    }
    SIDEBAR_APPBAR_REGISTERED.store(false, Ordering::Relaxed);
}

/// Floating (smart / peek): no reservation, just sit on the edge.
fn place_floating(win: &tauri::WebviewWindow) {
    let right = side_is_right(win.app_handle());
    if let Some((x, y, w, h, _)) = geometry(win, right) {
        place(win, x, y, w, h);
        let _ = win.show();
    }
}

// ------------------------------------------------------------- thin top strip
// A second, click-through window ("sidebar-frame") draws a thin strip along the top edge in the
// notch's colour. In fixed mode it also reserves that strip, so maximised windows stop just below
// it (like the frame in the reference). Smart: shown unless a window overlaps. Peek: not shown.

/// (x, y, w, window_h) in physical px.
fn frame_geometry(win: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    // The whole monitor: the frame draws the top strip, the strip on the side away from the bar and
    // the bottom strip, so it has to cover the full screen (it never takes a click).
    let (mx, my, mw, mh, scale) = monitor_rect(win)?;
    // The window reaches FRAME_BLEED_PX above the screen. Windows rounds the corners of a window, which
    // cut the top two screen corners; with the window's top edge off-screen the cut is out of sight.
    // SidebarFrame.tsx shifts its drawing down by the same amount (FRAME_BLEED in logical px).
    let bleed = (FRAME_BLEED_PX * scale).round() as i32;
    // A taskbar along the bottom is always on top of this window, so end the frame just above it:
    // the bottom strip is then visible instead of sitting underneath the taskbar.
    // With no taskbar to stop above, end FRAME_UNCOVER_PX short of the screen bottom (0 by default). A
    // window that covers the whole monitor (this one reaches above it too) is normally treated as a
    // fullscreen app, which makes Windows report busy and Windhawk pause its mods. The frame is marked
    // non-rude in set_tool_window_styles so that does not happen; the uncover is the fallback if it does.
    let bottom = taskbar_top(mx, my, mw, mh).unwrap_or(my + mh - FRAME_UNCOVER_PX);
    Some((mx, my - bleed, mw, (bottom - my).max(1) + bleed))
}

fn taskbar_autohide() -> bool {
    use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, APPBARDATA};
    unsafe {
        let mut abd = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            ..Default::default()
        };
        (SHAppBarMessage(ABM_GETSTATE, &mut abd) & 1) != 0
    }
}

/// Top edge of the Windows taskbar when it runs along the bottom of this monitor (physical px).
fn taskbar_top(mx: i32, my: i32, mw: i32, mh: i32) -> Option<i32> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};
    unsafe {
        // An auto-hidden taskbar (which is also how Bloom hides it) leaves a 1-2px sliver at the screen
        // edge. Reserving room for that sliver left the bottom strip a couple of pixels short.
        if taskbar_autohide() {
            return None;
        }
        let hwnd = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok()?;
        if !windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).ok()?;
        if my + mh - r.top <= 8 {
            return None;
        }
        let on_monitor = r.left < mx + mw && r.right > mx;
        let along_bottom = r.top > my + mh / 2 && (r.right - r.left) > mw / 2;
        if on_monitor && along_bottom {
            Some(r.top.min(my + mh))
        } else {
            None
        }
    }
}

// The strip is NOT an appbar. Registering it as one let the shell push it below the notch's own
// reserved band (it showed up ~40px down), and that broke when the notch mode changed. It is just a
// click-through window pinned to the top edge; enforce_frame puts it back if anything moves it.
fn sync_frame(app: &AppHandle) {
    let Some(win) = app.get_webview_window("sidebar-frame") else { return };
    let mode = SIDEBAR_MODE.load(Ordering::Relaxed);
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) || mode == 2 {
        FRAME_WANTED.store(false, Ordering::Relaxed);
        let _ = win.hide();
        return;
    }
    let Some((x, y, w, h)) = frame_geometry(&win) else { return };
    if let Ok(hwnd) = win.hwnd() {
        set_tool_window_styles(hwnd);
    }
    // Never takes a click: the strip is only decoration.
    let _ = win.set_ignore_cursor_events(true);
    FRAME_WANTED.store(true, Ordering::Relaxed);
    place(&win, x, y, w, h);
    let _ = win.show();
}

/// Called from the watcher thread (4 times a second): if the strip was moved, resized or hidden by
/// something else (an appbar re-layout after a notch mode change, a display change), put it back.
fn enforce_frame(app: &AppHandle) {
    if !FRAME_WANTED.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = app.get_webview_window("sidebar-frame") else { return };
    let Some((x, y, w, h)) = frame_geometry(&win) else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let mut r = RECT::default();
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
        if !IsWindowVisible(hwnd).as_bool() {
            let _ = win.show();
        }
        if GetWindowRect(hwnd, &mut r).is_err() {
            return;
        }
    }
    let off = (r.left - x).abs() > 1
        || (r.top - y).abs() > 1
        || ((r.right - r.left) - w).abs() > 2
        || ((r.bottom - r.top) - h).abs() > 2;
    if off {
        place(&win, x, y, w, h);
    }
}

/// Keeps the bar window as tall as the frame: a taskbar that appears or goes away changes both.
fn enforce_bar(app: &AppHandle) {
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = app.get_webview_window("sidebar") else { return };
    let right = side_is_right(app);
    let Some((_, y, _, h, _)) = geometry(&win, right) else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let mut r = RECT::default();
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
        if !IsWindowVisible(hwnd).as_bool() || GetWindowRect(hwnd, &mut r).is_err() {
            return;
        }
    }
    if (r.top - y).abs() > 1 || ((r.bottom - r.top) - h).abs() > 2 {
        place(&win, r.left, y, r.right - r.left, h);
    }
}

fn apply_mode(app: &AppHandle, mode: &str) {
    let Some(win) = app.get_webview_window("sidebar") else { return };
    SIDEBAR_MODE.store(mode_from_str(mode), Ordering::Relaxed);
    SIDEBAR_OVERLAP.store(false, Ordering::Relaxed);
    if mode == "fixed" {
        register_sidebar_appbar(win.clone());
    } else {
        unregister(&win);
        place_floating(&win);
    }
    let _ = app.emit("sidebar-overlap", false);
    let _ = app.emit("sidebar-mode", mode);
    sync_frame(app);
    start_watcher(app.clone());
    // Re-sync every other reservation so the work area adds up.
    reconcile_main_appbar(app);
}

#[tauri::command]
pub async fn init_sidebar(app: AppHandle, mode: String) {
    SIDEBAR_ENABLED.store(true, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("sidebar") {
        let _ = win.show();
        apply_mode(&app, &mode);
    }
}

#[tauri::command]
pub async fn change_sidebar_mode(app: AppHandle, mode: String) {
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    apply_mode(&app, &mode);
}

#[tauri::command]
pub async fn toggle_sidebar(app: AppHandle, enable: bool) {
    if enable {
        let mode = crate::utils::get_setting_str(&app, "bloom-sidebar-mode")
            .unwrap_or_else(|| "smart".to_string());
        init_sidebar(app, mode).await;
    } else {
        SIDEBAR_ENABLED.store(false, Ordering::Relaxed);
        SIDEBAR_POPUP_W.store(0, Ordering::Relaxed);
        SIDEBAR_FULL.store(false, Ordering::Relaxed);
        if let Some(win) = app.get_webview_window("sidebar") {
            let _ = win.hide();
            unregister(&win);
        }
        sync_frame(&app);
        reconcile_main_appbar(&app);
    }
}

#[tauri::command]
pub async fn sidebar_set_side(app: AppHandle) {
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let mode = crate::utils::get_setting_str(&app, "bloom-sidebar-mode")
        .unwrap_or_else(|| "smart".to_string());
    // Remove the old reservation first, then re-register on the new edge.
    if let Some(win) = app.get_webview_window("sidebar") {
        unregister(&win);
    }
    apply_mode(&app, &mode);
    let _ = app.emit("sidebar-side", if side_is_right(&app) { "right" } else { "left" });
}

/// While the bar is slid away, shrink the window to a thin hover strip so the
/// transparent window does not swallow clicks meant for the app underneath.
#[tauri::command]
pub fn sidebar_set_collapsed(app: AppHandle, collapsed: bool) {
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = app.get_webview_window("sidebar") else { return };
    let right = side_is_right(&app);
    let Some((x, y, w, h, _)) = geometry(&win, right) else { return };
    let w2 = if collapsed { (w * 6 / 72).max(4) } else { w };
    let x2 = if right { x + w - w2 } else { x };
    place(&win, x2, y, w2, h);
}

/// A popup opens beside a bar icon: make the bar window `width` logical px wider (0 puts it back).
/// The popup is drawn by the page inside that extra room, growing out of the bar's inner edge.
#[tauri::command]
pub fn sidebar_set_popup(app: AppHandle, width: f64) {
    SIDEBAR_POPUP_W.store(width.clamp(0.0, 1200.0).round() as i32, Ordering::Relaxed);
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = app.get_webview_window("sidebar") else { return };
    let right = side_is_right(&app);
    let Some((x, y, w, h, _)) = geometry(&win, right) else { return };
    place(&win, x, y, w, h);
}

/// The windows of every workspace of komorebi monitor `monitor` (its index in komorebi's list, as in the
/// "komorebi-workspaces" event): one list of hwnds per workspace, read from `komorebic state`. The bar groups its
/// app icons by workspace with it. None when komorebi is not running or its answer cannot be read.
// async: it waits for `komorebic state`, which must not block the main thread (like sidebar_toggle_tray).
#[tauri::command(async)]
pub fn sidebar_workspace_windows(monitor: usize) -> Option<Vec<Vec<i64>>> {
    use std::os::windows::process::CommandExt;
    fn walk(v: &serde_json::Value, out: &mut Vec<i64>) {
        match v {
            serde_json::Value::Object(m) => {
                if let Some(h) = m.get("hwnd").and_then(|h| h.as_i64()) {
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
                for (k, c) in m {
                    if k != "hwnd" {
                        walk(c, out);
                    }
                }
            }
            serde_json::Value::Array(a) => {
                for c in a {
                    walk(c, out);
                }
            }
            _ => {}
        }
    }
    let out = std::process::Command::new("komorebic")
        .arg("state")
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let state: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let spaces = state
        .get("monitors")?
        .get("elements")?
        .as_array()?
        .get(monitor)?
        .get("workspaces")?
        .get("elements")?
        .as_array()?;
    Some(
        spaces
            .iter()
            .map(|w| {
                let mut v = Vec::new();
                walk(w, &mut v);
                v
            })
            .collect(),
    )
}

/// The power menu opens (`on`) or closes: make the bar window cover the whole monitor (or put it back).
#[tauri::command]
pub fn sidebar_set_overlay(app: AppHandle, on: bool) {
    SIDEBAR_FULL.store(on, Ordering::Relaxed);
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(win) = app.get_webview_window("sidebar") else { return };
    let right = side_is_right(&app);
    let Some((x, y, w, h, _)) = geometry(&win, right) else { return };
    place(&win, x, y, w, h);
}

// ------------------------------------------------------------------ tray button + focus

/// Where `place_tray_flyout` (commands.rs) should put the Windows tray popup: beside the bar, centred on
/// the tray button that was just pressed. `None` for any other opener (the notch), which keeps its own spot.
pub fn tray_flyout_pos(app: &AppHandle, w: i32, h: i32) -> Option<(i32, i32)> {
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return None;
    }
    let at = TRAY_ANCHOR_AT.load(Ordering::Relaxed);
    if at == 0 || crate::utils::get_now_ms() - at > 15_000 {
        return None;
    }
    let win = app.get_webview_window("sidebar")?;
    let (mx, my, mw, mh, scale) = monitor_rect(&win)?;
    let right = side_is_right(app);
    let bloom_scale = crate::utils::get_bloom_scale(app);
    let reserve = ((BAR_W * bloom_scale) * scale) as i32;
    let margin = (8.0 * scale) as i32;
    let x = if right {
        mx + mw - reserve - margin - w
    } else {
        mx + reserve + margin
    };
    let x = x.clamp(mx, (mx + mw - w).max(mx));
    let y = (TRAY_ANCHOR_Y.load(Ordering::Relaxed) - h / 2).clamp(my, (my + mh - h).max(my));
    Some((x, y))
}

/// True while the Windows tray popup is being opened from the bar's tray button (the press is recent).
pub fn tray_from_bar() -> bool {
    if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
        return false;
    }
    let at = TRAY_ANCHOR_AT.load(Ordering::Relaxed);
    at != 0 && crate::utils::get_now_ms() - at <= 15_000
}

/// Hides the whole popup behind an empty clip region, so nothing of Windows' own slide-up is seen.
pub fn tray_clip_all(hwnd: HWND) {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    unsafe {
        let rgn = CreateRectRgn(0, 0, 0, 0);
        let _ = SetWindowRgn(hwnd, Some(rgn), true);
    }
}

/// Slides the popup out of the bar's edge, sideways (away from the bar on either side). The window itself
/// moves from behind the bar to its place while a clip region keeps the part that is still "inside" the
/// bar hidden, so it looks like it comes out of the bar. Windows' own slide-up has finished behind the
/// clip by now. Ends with no region.
#[allow(dead_code)] // the sideways slide, no longer used: tray_show below replaces it
pub fn tray_reveal(app: &AppHandle, hwnd: HWND) {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    };
    unsafe {
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return;
        }
        let (fx, fy) = (r.left, r.top); // where the popup ends up
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        if w <= 0 || h <= 0 {
            let _ = SetWindowRgn(hwnd, None, true);
            return;
        }
        let right = side_is_right(app);
        // 12 steps of 8ms (about 100ms) instead of 22 of 12ms (over 260ms): the popup is on screen sooner.
        const STEPS: i32 = 12;
        for i in 1..=STEPS {
            let t = i as f64 / STEPS as f64;
            let e = 1.0 - (1.0 - t).powi(3); // ease out
            let hidden = ((w as f64) * (1.0 - e)).round() as i32; // how much is still inside the bar
            let (x, rgn) = if right {
                (fx + hidden, CreateRectRgn(0, 0, w - hidden, h))
            } else {
                (fx - hidden, CreateRectRgn(hidden, 0, w, h))
            };
            let _ = SetWindowPos(hwnd, None, x, fy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = SetWindowRgn(hwnd, Some(rgn), true);
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        let _ = SetWindowRgn(hwnd, None, true);
    }
    TRAY_ANCHOR_AT.store(0, Ordering::Relaxed);
}

/// Shows the popup in its place at once, with no slide: lifts the clip that kept it hidden while Windows' own slide-up ran.
/// To get the sideways slide back, call tray_reveal instead (commands.rs, open_tray_flyout).
pub fn tray_show(hwnd: HWND) {
    use windows::Win32::Graphics::Gdi::SetWindowRgn;
    unsafe {
        let _ = SetWindowRgn(hwnd, None, true);
    }
    TRAY_ANCHOR_AT.store(0, Ordering::Relaxed);
}

/// The bar's tray button: opens the Windows tray popup beside the bar, or closes it if it is already
/// open. `anchor_y` is the button's centre in the page's CSS px, measured from the top of the bar window.
#[tauri::command]
pub async fn sidebar_toggle_tray(app: AppHandle, anchor_y: f64) {
    // Async, and the work on a blocking thread: a plain command runs on the main thread, and that thread
    // also runs the global mouse hook that makes the notch and the edge overlays react to hover. Windows
    // silently drops such a hook if its thread stalls for a few hundred ms, so nothing here may run there.
    let _ = tauri::async_runtime::spawn_blocking(move || toggle_tray_blocking(app, anchor_y)).await;
}

fn toggle_tray_blocking(app: AppHandle, anchor_y: f64) {
    if unsafe { crate::commands::find_tray_flyout() }.is_some() {
        crate::commands::close_tray_flyout();
        return;
    }
    if let Some(win) = app.get_webview_window("sidebar") {
        let right = side_is_right(&app);
        if let (Some((_, y, _, _, _)), Some((_, _, _, _, scale))) =
            (geometry(&win, right), monitor_rect(&win))
        {
            let bloom_scale = crate::utils::get_bloom_scale(&app);
            let abs_y = y + (anchor_y * bloom_scale * scale) as i32;
            TRAY_ANCHOR_Y.store(abs_y, Ordering::Relaxed);
            TRAY_ANCHOR_AT.store(crate::utils::get_now_ms(), Ordering::Relaxed);
        }
    }
    crate::commands::open_tray_flyout(app);
}

/// Whether the Windows tray popup is on screen (the tray button shows its open state from this).
#[tauri::command]
pub async fn sidebar_tray_is_open() -> bool {
    // Async for the same reason as sidebar_toggle_tray (it is polled while the tray popup is open).
    tauri::async_runtime::spawn_blocking(|| unsafe { crate::commands::find_tray_flyout() }.is_some())
        .await
        .unwrap_or(false)
}

/// The window that has focus right now (0 when there is none), as a number the page can compare with
/// the `hwnd`s that `get_active_windows` returns.
#[tauri::command]
pub async fn sidebar_foreground_hwnd() -> i64 {
    foreground_hwnd()
}

/// Asks a window to close, the way its own X button does (WM_CLOSE), so an app with unsaved work still gets to ask
/// first. False when the window is already gone.
#[tauri::command]
pub async fn sidebar_close_window(hwnd: i64) -> bool {
    use std::ffi::c_void;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, PostMessageW, WM_CLOSE};
    unsafe {
        let h = HWND(hwnd as isize as *mut c_void);
        IsWindow(Some(h)).as_bool() && PostMessageW(Some(h), WM_CLOSE, Default::default(), Default::default()).is_ok()
    }
}

fn foreground_hwnd() -> i64 {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as i64 }
}

/// Tells the bar when the focused window changes, so it can move its highlight. Called from the watcher
/// thread, which is already running while the bar is on.
fn track_focus(app: &AppHandle) {
    let fg = foreground_hwnd();
    if LAST_FOREGROUND.swap(fg, Ordering::Relaxed) != fg {
        let _ = app.emit("sidebar-focus", fg);
    }
}

// ---------------------------------------------------------------- smart watcher

struct EnumCtx {
    rect: RECT,
    own_pid: u32,
    hit: bool,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    };
    let ctx = &mut *(lparam.0 as *mut EnumCtx);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut _,
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return BOOL(1);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == ctx.own_pid {
        return BOOL(1);
    }
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() {
        return BOOL(1);
    }
    // Skip desktop/shell windows that span the whole screen but are not apps
    // by requiring a non-empty title.
    let mut title = [0u16; 4];
    if windows::Win32::UI::WindowsAndMessaging::GetWindowTextW(hwnd, &mut title) == 0 {
        return BOOL(1);
    }
    let overlaps = r.left < ctx.rect.right
        && r.right > ctx.rect.left
        && r.top < ctx.rect.bottom
        && r.bottom > ctx.rect.top;
    if overlaps {
        ctx.hit = true;
        return BOOL(0);
    }
    BOOL(1)
}

fn start_watcher(app: AppHandle) {
    if SIDEBAR_WATCHER_RUNNING.swap(true, Ordering::Relaxed) {
        return;
    }
    // The focus dot has to follow a window switch at once, so the focused window is checked on its own short tick
    // (it is only GetForegroundWindow and a compare), not on the 250 ms one of the watcher below.
    let focus_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(30));
        if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
            return;
        }
        track_focus(&focus_app);
    });
    std::thread::spawn(move || {
        let own_pid = std::process::id();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if !SIDEBAR_ENABLED.load(Ordering::Relaxed) {
                SIDEBAR_WATCHER_RUNNING.store(false, Ordering::Relaxed);
                return;
            }
            // A fullscreen app (game, video, F11 browser) gets the whole screen: hide the bar and its
            // strip while it is in front, and bring them back when it is not.
            let fs = crate::state::CURRENT_FOREGROUND_FULLSCREEN.load(Ordering::Relaxed);
            if SIDEBAR_FS_HIDDEN.swap(fs, Ordering::Relaxed) != fs {
                for label in ["sidebar", "sidebar-frame"] {
                    if let Some(w) = app.get_webview_window(label) {
                        if fs {
                            let _ = w.hide();
                        } else if label == "sidebar" || FRAME_WANTED.load(Ordering::Relaxed) {
                            let _ = w.show();
                        }
                    }
                }
            }
            if fs {
                continue;
            }
            enforce_frame(&app);
            enforce_bar(&app);
            // Only smart mode hides on overlap; fixed reserves space, peek is hover-driven.
            if SIDEBAR_MODE.load(Ordering::Relaxed) != 1 {
                continue;
            }
            let Some(win) = app.get_webview_window("sidebar") else { continue };
            let right = side_is_right(&app);
            let Some((x, y, w, h, reserve)) = geometry(&win, right) else { continue };
            // Test against the visible bar strip, not the wider hover margin (the bar is wider than the
            // work area it reserves).
            let reserve = reserve + ((FRAME_STRIP_H * crate::utils::get_bloom_scale(&app)) * monitor_rect(&win).map_or(1.0, |m| m.4)) as i32;
            let strip = if right {
                RECT { left: x + w - reserve, top: y, right: x + w, bottom: y + h }
            } else {
                RECT { left: x, top: y, right: x + reserve, bottom: y + h }
            };
            let mut ctx = EnumCtx { rect: strip, own_pid, hit: false };
            unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(
                    Some(enum_proc),
                    LPARAM(&mut ctx as *mut EnumCtx as isize),
                );
            }
            if SIDEBAR_OVERLAP.swap(ctx.hit, Ordering::Relaxed) != ctx.hit {
                let _ = app.emit("sidebar-overlap", ctx.hit);
            }
        }
    });
}
// ---------------------------------------------------------------- window picker thumbnails

/// A picture of one window, shrunk to fit max_w x max_h (aspect kept), as a `data:image/bmp` URL.
/// None when the window is gone, minimised, or Windows hands back an empty picture; the picker then shows the
/// app's icon instead.
#[tauri::command]
pub async fn sidebar_window_preview(hwnd: i64, max_w: u32, max_h: u32) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || window_preview(hwnd, max_w.clamp(16, 640), max_h.clamp(16, 640)))
        .await
        .ok()
        .flatten()
}

fn window_preview(hwnd: i64, max_w: u32, max_h: u32) -> Option<String> {
    use base64::Engine;
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindow};

    // PW_RENDERFULLCONTENT (0x2): also captures DirectComposition / GPU-drawn windows (browsers, Electron, UWP).
    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

    let hwnd = HWND(hwnd as isize as *mut c_void);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).ok()?;
        let (sw, sh) = ((r.right - r.left), (r.bottom - r.top));
        if sw <= 0 || sh <= 0 {
            return None;
        }
        // Fit inside max_w x max_h, never enlarge.
        let k = (max_w as f64 / sw as f64).min(max_h as f64 / sh as f64).min(1.0);
        let (tw, th) = (((sw as f64 * k).round() as i32).max(1), ((sh as f64 * k).round() as i32).max(1));

        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let full_dc = CreateCompatibleDC(Some(screen));
        let small_dc = CreateCompatibleDC(Some(screen));
        let full_bmp = CreateCompatibleBitmap(screen, sw, sh);
        let small_bmp = CreateCompatibleBitmap(screen, tw, th);
        let mut out: Option<String> = None;

        if !full_dc.is_invalid() && !small_dc.is_invalid() && !full_bmp.is_invalid() && !small_bmp.is_invalid() {
            let old_full = SelectObject(full_dc, full_bmp.into());
            let old_small = SelectObject(small_dc, small_bmp.into());
            if PrintWindow(hwnd, full_dc, PW_RENDERFULLCONTENT).as_bool() {
                let _ = SetStretchBltMode(small_dc, HALFTONE);
                if StretchBlt(small_dc, 0, 0, tw, th, Some(full_dc), 0, 0, sw, sh, SRCCOPY).as_bool() {
                    let mut info = BITMAPINFO::default();
                    info.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: tw,
                        biHeight: -th, // top-down
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    };
                    let mut px = vec![0u8; (tw * th * 4) as usize];
                    // The bitmap must not be selected into a DC while GetDIBits reads it.
                    SelectObject(small_dc, old_small);
                    let lines = GetDIBits(
                        small_dc,
                        small_bmp,
                        0,
                        th as u32,
                        Some(px.as_mut_ptr() as *mut c_void),
                        &mut info,
                        DIB_RGB_COLORS,
                    );
                    if lines == th {
                        // GDI leaves alpha at 0; make it opaque. An all-black picture means the window drew nothing.
                        let mut any = false;
                        for p in px.chunks_exact_mut(4) {
                            any |= p[0] | p[1] | p[2] != 0;
                            p[3] = 255;
                        }
                        if any {
                            out = Some(format!(
                                "data:image/bmp;base64,{}",
                                base64::engine::general_purpose::STANDARD.encode(bmp_file(tw, th, &px))
                            ));
                        }
                    }
                }
            }
            SelectObject(full_dc, old_full);
            SelectObject(small_dc, old_small);
        }
        for b in [full_bmp, small_bmp] {
            if !b.is_invalid() {
                let _ = DeleteObject(b.into());
            }
        }
        for d in [full_dc, small_dc] {
            if !d.is_invalid() {
                let _ = DeleteDC(d);
            }
        }
        ReleaseDC(None, screen);
        out
    }
}

/// A .bmp file: 14-byte file header, 40-byte info header, then top-down BGRA pixels.
fn bmp_file(w: i32, h: i32, px: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(54 + px.len());
    v.extend_from_slice(b"BM");
    v.extend_from_slice(&((54 + px.len()) as u32).to_le_bytes());
    v.extend_from_slice(&[0; 4]);
    v.extend_from_slice(&54u32.to_le_bytes());
    v.extend_from_slice(&40u32.to_le_bytes());
    v.extend_from_slice(&w.to_le_bytes());
    v.extend_from_slice(&(-h).to_le_bytes()); // negative height = top-down
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&32u16.to_le_bytes());
    v.extend_from_slice(&[0; 24]); // BI_RGB, size, resolution, palette: all default
    v.extend_from_slice(px);
    v
}
