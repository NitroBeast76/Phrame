//! Sliding transition for workspace switches started from Bloom (the side bar's workspace dots).
//!
//! komorebi swaps workspaces instantly, so the slide is faked: a picture of the screen is taken, a click-through
//! window showing that picture is put over the monitor, komorebi switches underneath it, a picture of the new
//! workspace is taken, and the two pictures are slid across the overlay with an eased bezier curve (most of the distance in the first frames, a slight overshoot that settles back), paced to the screen's refresh. Then the overlay goes away and the real,
//! already switched, workspace is there. `slide` returns as soon as the new workspace is on screen: the animation
//! plays on its own thread, so whatever the caller does next (focusing a window, say) does not wait for it.
//!
//! Only the windows slide, the wallpaper stays put. Which pixels belong to a window is decided by where the windows
//! are (their rectangles, before and after the switch), never by comparing colours with a photo of the wallpaper:
//! that left noisy fragments of a detailed wallpaper sliding along. The wallpaper itself is put together from the
//! two pictures of the screen (each one shows it wherever no window is), and the desktop window drawn by Explorer
//! fills in what both pictures hide. When that is not possible the whole screen slides instead.
//!
//! The overlay never blocks input (it is click-through) and Bloom's own windows (side bar, notch) stay on top of
//! it and out of the pictures, so they do not slide. When something goes wrong at any step (capture fails, a
//! fullscreen app is in front, Windows is too old for capture exclusion) the switch just happens without a slide.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, Once};
use std::time::{Duration, Instant};

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmFlush, DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    AlphaBlend, BitBlt, BLENDFUNCTION, CreateCompatibleBitmap, CreateCompatibleDC, GetDIBits, SetDIBitsToDevice, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetMonitorInfoW, MonitorFromPoint,
    ReleaseDC, SelectObject, StretchBlt, CAPTUREBLT, HBITMAP, HDC, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetDesktopWindow,
    GetForegroundWindow, GetShellWindow, GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, PeekMessageW, RegisterClassW, SetLayeredWindowAttributes,
    SetWindowDisplayAffinity, SetWindowPos, TranslateMessage, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST, LWA_ALPHA, MSG,
    PM_REMOVE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WM_ERASEBKGND, WNDCLASSW, WS_CAPTION,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

/// How long to wait after komorebi says it has switched, so the windows of the new workspace have painted.
const SETTLE_MS: u64 = 35;
/// How long the slide takes (this and CURVE were measured from a Hyprland workspace slide).
const SLIDE_MS: u64 = 460;
/// The easing: a CSS-style cubic-bezier(x1, y1, x2, y2). This is Hyprland's well known "overshot" curve: the
/// windows cover most of the distance in the first few frames, go about 2% past their place and settle back. A last
/// value of 1.0 or below gives no overshoot (and no bounce); (0.05, 0.9, 0.1, 1.0) is the same curve without it.
const CURVE: (f64, f64, f64, f64) = (0.05, 0.9, 0.1, 1.05);
/// True when the curve goes past its target (so the animation must run to the end of its time).
const OVERSHOOT: bool = CURVE.3 > 1.0;
/// The old windows fade out while they slide away and the new ones fade in while they slide in (no blur). When
/// only the windows slide they fade into the still wallpaper; when the whole screen slides they fade into a
/// photograph of the wallpaper (taken in the background after the first such slide, so that one has no fade).
const CROSSFADE: bool = false;
/// Slide only the windows over a still wallpaper (true), or always the whole screen (false).
const WINDOWS_ONLY: bool = true;
/// How far (per colour channel, 0 to 255) two pixels may differ and still count as the same.
const TOL: u32 = 6;
/// Around a window, this many pixels count as its drop shadow: what differs from the wallpaper there slides along.
const MARGIN: i32 = 20;
/// The rounded corners of a window: inside this many pixels of a corner, wallpaper coloured pixels stay behind.
const CORNER: i32 = 14;

/// A photograph of the wallpaper (Explorer's desktop window), kept between slides. It fills in the parts of the
/// wallpaper that windows hide in both pictures (all of it, nearly, with tiled windows) and is the background the
/// pictures fade into when the whole screen slides. It is taken on a background thread so that no slide has to wait
/// for it: the slide that finds it missing slides the whole screen, the next ones keep the wallpaper still.
static BACKDROP: Mutex<Option<((i32, i32, i32, i32), Arc<Vec<u32>>)>> = Mutex::new(None);
static BACKDROP_BUSY: AtomicBool = AtomicBool::new(false);

fn backdrop_get(work: &RECT, len: usize) -> Option<Arc<Vec<u32>>> {
    let cache = BACKDROP.lock().unwrap_or_else(|e| e.into_inner());
    match &*cache {
        Some((key, px)) if *key == (work.left, work.top, work.right, work.bottom) && px.len() == len => Some(px.clone()),
        _ => None,
    }
}

fn backdrop_capture_later(work: RECT, w: i32, h: i32) {
    if BACKDROP_BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        unsafe {
            if let Some(px) = capture_desktop(&work, w, h) {
                *BACKDROP.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(((work.left, work.top, work.right, work.bottom), Arc::new(px)));
            }
        }
        BACKDROP_BUSY.store(false, Ordering::SeqCst);
    });
}

fn backdrop_forget() {
    *BACKDROP.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// One slide at a time: true while a slide (its animation included) is running.
static BUSY: Mutex<bool> = Mutex::new(false);
static FREE: Condvar = Condvar::new();
/// Calls waiting for (or about to take) their turn. The running animation stops when this is not zero, and calls
/// that have another call behind them skip their slide, so going quickly through workspaces only slides the last.
static WAITING: AtomicUsize = AtomicUsize::new(0);

/// Holds the "one slide at a time" turn; the next slide can start when it is dropped. It moves to the animation
/// thread, so it is dropped when the animation ends.
struct Busy;

impl Busy {
    fn enter() -> Busy {
        let mut busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        while *busy {
            busy = FREE.wait(busy).unwrap_or_else(|e| e.into_inner());
        }
        *busy = true;
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        *BUSY.lock().unwrap_or_else(|e| e.into_inner()) = false;
        FREE.notify_all();
    }
}

/// Runs `switch` (which must change komorebi's workspace and return once komorebi reports it, true when it
/// worked) with a slide over the monitor that holds screen point (cx, cy). `forward` is true when the new
/// workspace is to the "right" of the old one (the content moves left). `switch` runs exactly once, slide or not,
/// and its result is returned. Returns once the new workspace is on screen; the animation goes on in the
/// background. Call from a worker thread.
pub fn slide(cx: i32, cy: i32, forward: bool, switch: impl FnOnce() -> bool) -> bool {
    WAITING.fetch_add(1, Ordering::SeqCst);
    let busy = Busy::enter();
    let behind = WAITING.fetch_sub(1, Ordering::SeqCst) - 1;
    if behind > 0 {
        drop(busy);
        return switch();
    }
    unsafe { run(cx, cy, forward, switch, busy) }
}

fn interrupted() -> bool {
    WAITING.load(Ordering::SeqCst) > 0
}

unsafe fn run(cx: i32, cy: i32, forward: bool, switch: impl FnOnce() -> bool, busy: Busy) -> bool {
    let Some((work, mon)) = monitor_rects(cx, cy) else { return switch() };
    let (w, h) = (work.right - work.left, work.bottom - work.top);
    if w < 200 || h < 200 || fullscreen_app_on(&mon) {
        return switch();
    }
    if WINDOWS_ONLY && backdrop_get(&work, (w * h) as usize).is_none() {
        backdrop_capture_later(work, w, h); // for the next slide; this one may have to slide the whole screen
    }
    // Bloom's own windows are kept out of the pictures (they stay where they are, on top of the overlay).
    let wins = bloom_windows();
    let excluded = Exclude::new(&wins);
    let _ = DwmFlush(); // let the exclusion reach the screen before taking the picture
    let rects_old = window_rects(&work);
    let Some(old) = Shot::grab(&work) else { return switch() };
    // The overlay sits just under the lowest of Bloom's always-on-top windows.
    let below = wins.iter().rev().copied().find(|&win| is_topmost(win)).map(|win| win.0 as isize);

    // The overlay lives on its own thread (a window has to be created, driven and destroyed by one thread), which
    // also plays the animation, so this call can return as soon as the new workspace is up.
    let (tx_new, rx_new) = mpsc::channel::<Option<(Shot, Vec<RECT>)>>();
    let (tx_ready, rx_ready) = mpsc::channel::<bool>();
    std::thread::spawn(move || {
        let _turn = busy;
        unsafe {
            let below = below.map(|p| HWND(p as *mut c_void));
            let overlay = Overlay::new(&work, &old, below);
            let _ = tx_ready.send(overlay.is_some());
            let Some(overlay) = overlay else { return };
            // While komorebi switches: read the old picture.
            let old_px = if WINDOWS_ONLY { read_pixels(old.dc, old.bmp, overlay.w, overlay.h) } else { None };
            if let Ok(Some((new, rects_new))) = rx_new.recv_timeout(Duration::from_secs(5)) {
                let (w, h) = (overlay.w, overlay.h);
                let layers = old_px.and_then(|px| {
                    Layers::build(
                        px,
                        &new,
                        &rects_old,
                        &rects_new,
                        |_| backdrop_get(&work, (w * h) as usize),
                        w,
                        h,
                    )
                });
                match layers {
                    Some(layers) => overlay.animate_layers(&layers, forward),
                    None => {
                        let backdrop = if CROSSFADE { backdrop_get(&work, (w * h) as usize) } else { None };
                        match backdrop {
                            Some(bg) => overlay.animate_fade(&old, &new, &bg, forward),
                            None => {
                                if CROSSFADE {
                                    backdrop_capture_later(work, w, h);
                                }
                                overlay.animate(&old, &new, forward)
                            }
                        }
                    }
                }
            }
        } // the overlay window and the pictures go away here
    });
    if !rx_ready.recv().unwrap_or(false) {
        return switch();
    }
    let _ = DwmFlush();

    if !switch() {
        let _ = tx_new.send(None); // the overlay goes away, the screen is as it was
        return false;
    }
    std::thread::sleep(Duration::from_millis(SETTLE_MS));
    if interrupted() {
        let _ = tx_new.send(None);
        return true;
    }
    let rects_new = window_rects(&work);
    let new = Shot::grab(&work); // the overlay is hidden from capture, so this is the new workspace
    drop(excluded);
    let _ = tx_new.send(new.map(|n| (n, rects_new)));
    true
}

// ---------------------------------------------------------------- easing

/// The y of a CSS cubic-bezier(x1, y1, x2, y2) at time `t` (0..1).
fn bezier(x1: f64, y1: f64, x2: f64, y2: f64, t: f64) -> f64 {
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;
    let sx = |s: f64| ((ax * s + bx) * s + cx) * s;
    let sy = |s: f64| ((ay * s + by) * s + cy) * s;
    let dx = |s: f64| (3.0 * ax * s + 2.0 * bx) * s + cx;
    // Newton's method finds the curve parameter whose x is `t`; bisection is the fallback.
    let mut s = t;
    for _ in 0..8 {
        let e = sx(s) - t;
        if e.abs() < 1e-5 {
            return sy(s);
        }
        let d = dx(s);
        if d.abs() < 1e-6 {
            break;
        }
        s -= e / d;
    }
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    s = t;
    for _ in 0..30 {
        let e = sx(s);
        if (e - t).abs() < 1e-5 {
            break;
        }
        if t > e {
            lo = s;
        } else {
            hi = s;
        }
        s = (lo + hi) / 2.0;
    }
    sy(s)
}

fn ease(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    bezier(CURVE.0, CURVE.1, CURVE.2, CURVE.3, t)
}

// ---------------------------------------------------------------- monitor and windows

/// (work area, whole monitor) of the monitor holding the point, in physical pixels.
unsafe fn monitor_rects(cx: i32, cy: i32) -> Option<(RECT, RECT)> {
    let hm = MonitorFromPoint(POINT { x: cx, y: cy }, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !GetMonitorInfoW(hm, &mut mi).as_bool() {
        return None;
    }
    Some((mi.rcWork, mi.rcMonitor))
}

/// A fullscreen game or video (a window without a title bar covering the whole monitor) is in front: its picture
/// would come out black or stale, so the switch is left alone.
unsafe fn fullscreen_app_on(mon: &RECT) -> bool {
    let fg = GetForegroundWindow();
    if fg.0.is_null() || fg == GetShellWindow() || fg == GetDesktopWindow() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(fg, Some(&mut pid));
    if pid == GetCurrentProcessId() {
        return false;
    }
    let mut r = RECT::default();
    if GetWindowRect(fg, &mut r).is_err() {
        return false;
    }
    let covers = r.left <= mon.left && r.top <= mon.top && r.right >= mon.right && r.bottom >= mon.bottom;
    let style = GetWindowLongPtrW(fg, GWL_STYLE) as u32;
    covers && style & WS_CAPTION.0 == 0
}

struct Others {
    pid: u32,
    work: RECT,
    list: Vec<RECT>,
}

unsafe extern "system" fn collect_rect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let acc = &mut *(lparam.0 as *mut Others);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == acc.pid {
        return BOOL(1);
    }
    // Windows of other virtual desktops (and hidden UWP frames) are visible but cloaked.
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4).is_ok() && cloaked != 0 {
        return BOOL(1);
    }
    // Click-through overlays (widgets, wallpaper HUDs) are part of the desktop, not of a workspace.
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TRANSPARENT.0 != 0 && ex & WS_EX_LAYERED.0 != 0 {
        return BOOL(1);
    }
    let mut name = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut name).max(0) as usize;
    let name = String::from_utf16_lossy(&name[..n.min(64)]);
    if matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
        return BOOL(1);
    }
    // The visible frame (without the invisible resize border and the shadow).
    let mut r = RECT::default();
    let size = std::mem::size_of::<RECT>() as u32;
    let got = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut c_void, size).is_ok()
        || GetWindowRect(hwnd, &mut r).is_ok();
    if !got {
        return BOOL(1);
    }
    let w = &acc.work;
    let clipped = RECT {
        left: r.left.max(w.left) - w.left,
        top: r.top.max(w.top) - w.top,
        right: r.right.min(w.right) - w.left,
        bottom: r.bottom.min(w.bottom) - w.top,
    };
    if clipped.right - clipped.left >= 16 && clipped.bottom - clipped.top >= 16 {
        acc.list.push(clipped);
    }
    BOOL(1)
}

/// The rectangles of the windows that are on screen in the work area right now (not Bloom's own, not the desktop
/// or the taskbar), clipped to it and counted from its top left corner.
unsafe fn window_rects(work: &RECT) -> Vec<RECT> {
    let mut acc = Others { pid: GetCurrentProcessId(), work: *work, list: Vec::new() };
    let _ = EnumWindows(Some(collect_rect), LPARAM(&mut acc as *mut Others as isize));
    acc.list
}

struct Wins {
    pid: u32,
    list: Vec<HWND>,
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let wins = &mut *(lparam.0 as *mut Wins);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == wins.pid && IsWindowVisible(hwnd).as_bool() {
        wins.list.push(hwnd);
    }
    BOOL(1)
}

/// Bloom's visible top-level windows, top of the z-order first.
unsafe fn bloom_windows() -> Vec<HWND> {
    let mut wins = Wins { pid: GetCurrentProcessId(), list: Vec::new() };
    let _ = EnumWindows(Some(collect), LPARAM(&mut wins as *mut Wins as isize));
    wins.list
}

unsafe fn is_topmost(hwnd: HWND) -> bool {
    (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOPMOST.0 != 0
}

/// Hides Bloom's windows from screen capture while it lives (they stay on screen); puts them back on drop.
struct Exclude {
    changed: Vec<HWND>,
}

impl Exclude {
    unsafe fn new(wins: &[HWND]) -> Exclude {
        let mut changed = Vec::new();
        for &win in wins {
            let mut cur = 0u32;
            if GetWindowDisplayAffinity(win, &mut cur).is_ok()
                && cur == WDA_NONE.0
                && SetWindowDisplayAffinity(win, WDA_EXCLUDEFROMCAPTURE).is_ok()
            {
                changed.push(win);
            }
        }
        Exclude { changed }
    }
}

impl Drop for Exclude {
    fn drop(&mut self) {
        for &win in &self.changed {
            unsafe {
                let _ = SetWindowDisplayAffinity(win, WDA_NONE);
            }
        }
    }
}

// ---------------------------------------------------------------- pictures

/// A picture of a screen rectangle, kept in a memory DC.
struct Shot {
    dc: HDC,
    bmp: HBITMAP,
    prev: HGDIOBJ,
}

// The handles are only used by one thread at a time (the picture is handed over, never shared).
unsafe impl Send for Shot {}

impl Shot {
    /// An empty picture of the given size (the back buffer a frame is put together in).
    unsafe fn blank(w: i32, h: i32) -> Option<Shot> {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        ReleaseDC(None, screen);
        if dc.is_invalid() || bmp.is_invalid() {
            if !bmp.is_invalid() {
                let _ = DeleteObject(bmp.into());
            }
            if !dc.is_invalid() {
                let _ = DeleteDC(dc);
            }
            return None;
        }
        let prev = SelectObject(dc, bmp.into());
        Some(Shot { dc, bmp, prev })
    }

    unsafe fn grab(r: &RECT) -> Option<Shot> {
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        if dc.is_invalid() || bmp.is_invalid() {
            if !bmp.is_invalid() {
                let _ = DeleteObject(bmp.into());
            }
            if !dc.is_invalid() {
                let _ = DeleteDC(dc);
            }
            ReleaseDC(None, screen);
            return None;
        }
        let prev = SelectObject(dc, bmp.into());
        let ok = StretchBlt(dc, 0, 0, w, h, Some(screen), r.left, r.top, w, h, SRCCOPY | CAPTUREBLT).as_bool();
        ReleaseDC(None, screen);
        let shot = Shot { dc, bmp, prev };
        if ok {
            Some(shot)
        } else {
            None // dropped: cleans up
        }
    }
}

impl Drop for Shot {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.prev);
            let _ = DeleteObject(self.bmp.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

// ---------------------------------------------------------------- overlay window

fn class() -> PCWSTR {
    w!("BloomWorkspaceSlide")
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_ERASEBKGND {
        return LRESULT(1);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

unsafe fn pump() {
    let mut msg = MSG::default();
    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

/// The click-through window that covers the work area while the slide plays. Hidden from capture, so the picture
/// of the new workspace is taken through it.
struct Overlay {
    hwnd: HWND,
    dc: HDC,
    /// Frames are put together here and copied to the window in one go, so a frame never shows half drawn.
    back: Shot,
    w: i32,
    h: i32,
}

impl Overlay {
    unsafe fn new(work: &RECT, first: &Shot, below: Option<HWND>) -> Option<Overlay> {
        static REGISTER: Once = Once::new();
        let hmod = GetModuleHandleW(None).ok()?;
        let hinst = HINSTANCE(hmod.0);
        REGISTER.call_once(|| {
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinst, lpszClassName: class(), ..Default::default() };
            RegisterClassW(&wc);
        });
        let (w, h) = (work.right - work.left, work.bottom - work.top);
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
            class(),
            w!(""),
            WS_POPUP,
            work.left,
            work.top,
            w,
            h,
            None,
            None,
            Some(hinst),
            None,
        )
        .ok()?;
        // Without capture exclusion the second picture would show this window, so give up on the slide.
        if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_err()
            || SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA).is_err()
        {
            let _ = DestroyWindow(hwnd);
            return None;
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), work.left, work.top, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        if let Some(b) = below {
            // Straight under Bloom's lowest always-on-top window: the side bar and notch stay above the slide.
            let _ = SetWindowPos(hwnd, Some(b), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        }
        let dc = GetDC(Some(hwnd));
        let back = Shot::blank(w, h);
        let Some(back) = back.filter(|_| !dc.is_invalid()) else {
            if !dc.is_invalid() {
                ReleaseDC(Some(hwnd), dc);
            }
            let _ = DestroyWindow(hwnd);
            return None;
        };
        let _ = StretchBlt(dc, 0, 0, w, h, Some(first.dc), 0, 0, w, h, SRCCOPY);
        Some(Overlay { hwnd, dc, back, w, h })
    }

    /// One frame: the old picture has moved `off` pixels out, the new one has come that far in. `off` goes past the
    /// width only if the curve overshoots (a last CURVE value above 1): the new picture then sits a little beyond its place and the strip that opens up
    /// at the edge is filled with the picture's own edge pixels.
    unsafe fn draw(&self, old: &Shot, new: &Shot, off: i32, forward: bool) {
        let (w, h) = (self.w, self.h);
        let off = off.clamp(0, w + w / 4);
        let back = self.back.dc;
        let blit = |dx: i32, dw: i32, src: &Shot, sx: i32| {
            if dw > 0 {
                let _ = StretchBlt(back, dx, 0, dw, h, Some(src.dc), sx, 0, dw, h, SRCCOPY);
            }
        };
        // A strip made of one column of the picture, stretched.
        let fill = |dx: i32, dw: i32, src: &Shot, sx: i32| {
            if dw > 0 {
                let _ = StretchBlt(back, dx, 0, dw, h, Some(src.dc), sx, 0, 1, h, SRCCOPY);
            }
        };
        if forward {
            // The old picture leaves to the left, the new one arrives from the right.
            if off <= w {
                blit(0, w - off, old, off);
                blit(w - off, off, new, 0);
            } else {
                let over = off - w;
                blit(0, w - over, new, over);
                fill(w - over, over, new, w - 1);
            }
        } else if off <= w {
            blit(off, w - off, old, 0);
            blit(0, off, new, w - off);
        } else {
            let over = off - w;
            blit(over, w - over, new, 0);
            fill(0, over, new, 0);
        }
        let _ = BitBlt(self.dc, 0, 0, w, h, Some(back), 0, 0, SRCCOPY);
    }

    /// Plays the slide: calls `frame(off)` for every screen refresh, `off` being how many pixels the old picture
    /// has moved out. Time based: when frames are late the motion keeps its duration instead of slowing down.
    unsafe fn play(&self, mut frame: impl FnMut(i32)) {
        let start = Instant::now();
        let total = Duration::from_millis(SLIDE_MS).as_secs_f64();
        loop {
            pump();
            if interrupted() {
                break;
            }
            let t = (start.elapsed().as_secs_f64() / total).min(1.0);
            let off = (ease(t) * self.w as f64).round() as i32;
            frame(off);
            // Done at the end of the time, or as soon as the picture is in place (the rest of the curve would
            // only crawl a fraction of a pixel per frame).
            if t >= 1.0 || (!OVERSHOOT && off >= self.w as i32) {
                break;
            }
            // Wait for the next screen refresh so frames are evenly spaced; sleep a little if that is not possible.
            if DwmFlush().is_err() {
                std::thread::sleep(Duration::from_millis(8));
            }
        }
    }

    /// The whole screen slides (the two pictures as they are).
    unsafe fn animate(&self, old: &Shot, new: &Shot, forward: bool) {
        self.play(|off| self.draw(old, new, off, forward));
    }

    /// The whole screen slides and both pictures fade through `backdrop` (a picture of the wallpaper): the old one
    /// goes from solid to gone while it leaves, the new one from gone to solid while it arrives. The blending is
    /// done by GDI on the two pictures as they are, so there is nothing to prepare.
    unsafe fn animate_fade(&self, old: &Shot, new: &Shot, backdrop: &[u32], forward: bool) {
        let (w, h) = (self.w, self.h);
        let bg = Shot::blank(w, h);
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let filled = match &bg {
            Some(bg) if backdrop.len() == (w * h) as usize => {
                SetDIBitsToDevice(bg.dc, 0, 0, w as u32, h as u32, 0, 0, 0, h as u32, backdrop.as_ptr() as *const c_void, &info, DIB_RGB_COLORS)
                    == h
            }
            _ => false,
        };
        let Some(bg) = bg.filter(|_| filled) else { return self.animate(old, new, forward) };
        self.play(|off| self.draw_fade(old, new, &bg, off, forward));
    }

    /// One frame of the fading slide (see `animate_fade`).
    unsafe fn draw_fade(&self, old: &Shot, new: &Shot, bg: &Shot, off: i32, forward: bool) {
        let (w, h) = (self.w, self.h);
        let off = off.clamp(0, w);
        let p = off as f64 / w as f64;
        let (a_old, a_new) = (((1.0 - p) * 255.0).round() as u8, (p * 255.0).round() as u8);
        let back = self.back.dc;
        let _ = BitBlt(back, 0, 0, w, h, Some(bg.dc), 0, 0, SRCCOPY);
        let blend = |dx: i32, dw: i32, src: &Shot, sx: i32, alpha: u8| {
            if dw > 0 && alpha > 0 {
                let f = BLENDFUNCTION { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: alpha, AlphaFormat: 0 };
                let _ = AlphaBlend(back, dx, 0, dw, h, src.dc, sx, 0, dw, h, f);
            }
        };
        if forward {
            blend(0, w - off, old, off, a_old);
            blend(w - off, off, new, 0, a_new);
        } else {
            blend(off, w - off, old, 0, a_old);
            blend(0, off, new, w - off, a_new);
        }
        let _ = BitBlt(self.dc, 0, 0, w, h, Some(back), 0, 0, SRCCOPY);
    }

    /// Only the windows slide, over the wallpaper that stays.
    unsafe fn animate_layers(&self, layers: &Layers, forward: bool) {
        let mut out = vec![0u32; layers.w * layers.h];
        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: layers.w as i32,
            biHeight: -(layers.h as i32), // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        self.play(|off| {
            layers.compose(&mut out, off, forward);
            let _ = SetDIBitsToDevice(
                self.dc,
                0,
                0,
                layers.w as u32,
                layers.h as u32,
                0,
                0,
                0,
                layers.h as u32,
                out.as_ptr() as *const c_void,
                &info,
                DIB_RGB_COLORS,
            );
        });
    }
}

// ---------------------------------------------------------------- windows only

/// The pixels (0x00RRGGBB, as GDI gives them) of a bitmap, row by row from the top.
unsafe fn read_pixels(dc: HDC, bmp: HBITMAP, w: i32, h: i32) -> Option<Vec<u32>> {
    let mut px = vec![0u32; w as usize * h as usize];
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let lines = GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
    if lines == h {
        Some(px)
    } else {
        None
    }
}

fn near(a: u32, b: u32) -> bool {
    let d = |s: u32| ((a >> s) & 0xFF).abs_diff((b >> s) & 0xFF);
    d(0) <= TOL && d(8) <= TOL && d(16) <= TOL
}

/// What a window of the desktop (Explorer's wallpaper) draws, cut down to the work area `work`.
unsafe fn print_crop(hwnd: HWND, work: &RECT) -> Option<Vec<u32>> {
    let mut r = RECT::default();
    GetWindowRect(hwnd, &mut r).ok()?;
    let (rw, rh) = (r.right - r.left, r.bottom - r.top);
    let (w, h) = (work.right - work.left, work.bottom - work.top);
    let (sx, sy) = (work.left - r.left, work.top - r.top);
    if sx < 0 || sy < 0 || sx + w > rw || sy + h > rh {
        return None;
    }
    let screen = GetDC(None);
    if screen.is_invalid() {
        return None;
    }
    let dc = CreateCompatibleDC(Some(screen));
    let bmp = CreateCompatibleBitmap(screen, rw, rh);
    ReleaseDC(None, screen);
    if dc.is_invalid() || bmp.is_invalid() {
        if !bmp.is_invalid() {
            let _ = DeleteObject(bmp.into());
        }
        if !dc.is_invalid() {
            let _ = DeleteDC(dc);
        }
        return None;
    }
    let prev = SelectObject(dc, bmp.into());
    let full = if PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(2)).as_bool() { read_pixels(dc, bmp, rw, rh) } else { None };
    SelectObject(dc, prev);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(dc);
    let full = full?;
    let mut out = Vec::with_capacity(w as usize * h as usize);
    for y in 0..h {
        let start = ((sy + y) * rw + sx) as usize;
        out.extend_from_slice(&full[start..start + w as usize]);
    }
    Some(out)
}

/// Two masks of a picture, one value per pixel, from the window rectangles. The first one is 1 inside a window and 2
/// in the corner zones of a window (where the window may be rounded), 0 elsewhere. The second one is 1 inside a
/// window and its shadow margin, 0 elsewhere.
fn masks(rects: &[RECT], w: usize, h: usize) -> (Vec<u8>, Vec<u8>) {
    let mut core = vec![0u8; w * h];
    let mut wide = vec![0u8; w * h];
    let (wi, hi) = (w as i32, h as i32);
    for r in rects {
        for y in (r.top - MARGIN).max(0)..(r.bottom + MARGIN).min(hi) {
            let row = y as usize * w;
            wide[row + (r.left - MARGIN).max(0) as usize..row + (r.right + MARGIN).min(wi) as usize].fill(1);
        }
        let (x0, x1) = (r.left.max(0), r.right.min(wi));
        for y in r.top.max(0)..r.bottom.min(hi) {
            let row = y as usize * w;
            let dy = (y - r.top).min(r.bottom - 1 - y);
            if dy >= CORNER {
                core[row + x0 as usize..row + x1 as usize].fill(1);
            } else {
                for x in x0..x1 {
                    let dx = (x - r.left).min(r.right - 1 - x);
                    let v = &mut core[row + x as usize];
                    if *v != 1 {
                        *v = if dx < CORNER { 2 } else { 1 };
                    }
                }
            }
        }
    }
    (core, wide)
}

/// Counts the sampled pixels outside the windows (`core` is 0) where `wall` and `px` agree: (agreeing, sampled).
fn agreement(wall: &[u32], px: &[u32], core: &[u8], tally: &mut (usize, usize)) {
    for i in (0..wall.len().min(px.len())).step_by(5) {
        if core[i] == 0 {
            tally.1 += 1;
            if near(wall[i], px[i]) {
                tally.0 += 1;
            }
        }
    }
}

/// Explorer's desktop windows (the wallpaper lives in one of them).
unsafe fn desktop_windows() -> Vec<HWND> {
    let mut hwnds: Vec<HWND> = Vec::new();
    if let Ok(p) = FindWindowW(w!("Progman"), PCWSTR::null()) {
        hwnds.push(p);
    }
    let mut prev: Option<HWND> = None;
    while let Ok(wk) = FindWindowExW(None, prev, w!("WorkerW"), PCWSTR::null()) {
        hwnds.push(wk);
        prev = Some(wk);
        if hwnds.len() >= 6 {
            break;
        }
    }
    hwnds
}

/// The first picture of the desktop that is not (nearly) black, cut to the work area. Not checked against anything.
unsafe fn capture_desktop(work: &RECT, w: i32, h: i32) -> Option<Vec<u32>> {
    for hwnd in desktop_windows() {
        if let Some(px) = print_crop(hwnd, work) {
            if px.len() != (w * h) as usize {
                continue;
            }
            let lit = px.iter().step_by(11).filter(|&&p| !near(p & 0x00FF_FFFF, 0)).count();
            if lit * 20 > px.len() / 11 {
                return Some(px);
            }
        }
    }
    None
}

/// The wallpaper and the two pictures of the screen as layers: a layer pixel is opaque where a window is and
/// transparent everywhere else.
struct Layers {
    w: usize,
    h: usize,
    wall: Vec<u32>,
    old: Vec<u32>,
    new: Vec<u32>,
}

/// Puts `src` over `dst`, moved `dx` pixels to the right (negative: to the left); transparent pixels let `dst` show.
/// `alpha` (0 to 256, 256 being solid) is how much of `src` shows over what is in `dst`.
fn paste(dst: &mut [u32], src: &[u32], dx: i32, alpha: u32) {
    let w = dst.len() as i32;
    let (from, to) = ((-dx).max(0), (w - dx).min(w));
    if alpha == 0 || from >= to {
        return;
    }
    for sx in from..to {
        let p = src[sx as usize];
        if p >> 24 != 0 {
            let d = &mut dst[(sx + dx) as usize];
            if alpha >= 256 {
                *d = p;
            } else {
                // Red and blue are blended together in one multiplication, green in another.
                let rb = ((p & 0x00FF_00FF) * alpha + (*d & 0x00FF_00FF) * (256 - alpha)) >> 8;
                let g = ((p & 0x0000_FF00) * alpha + (*d & 0x0000_FF00) * (256 - alpha)) >> 8;
                *d = (rb & 0x00FF_00FF) | (g & 0x0000_FF00);
            }
        }
    }
}

impl Layers {
    /// `rects_old` and `rects_new` are where the windows were before and are after the switch. The wallpaper is
    /// whatever a picture shows away from its windows (and their shadows), taken from the other picture where one
    /// has a window; `desktop` (Explorer's picture, if there is one) fills in what both hide. None when some of the
    /// wallpaper cannot be known: the whole screen slides then.
    unsafe fn build(
        old_px: Vec<u32>,
        new: &Shot,
        rects_old: &[RECT],
        rects_new: &[RECT],
        desktop: impl FnOnce(&[u32]) -> Option<Arc<Vec<u32>>>, // the photograph of the wallpaper, if there is one
        w: i32,
        h: i32,
    ) -> Option<Layers> {
        let (wu, hu) = (w as usize, h as usize);
        let n = wu * hu;
        let (core_old, wide_old) = masks(rects_old, wu, hu);
        let (core_new, wide_new) = masks(rects_new, wu, hu);
        let new_px = read_pixels(new.dc, new.bmp, w, h)?;
        if old_px.len() != n || new_px.len() != n {
            return None;
        }

        let mut wall = vec![0u32; n];
        let mut known = vec![true; n];
        let mut holes = 0usize;
        for i in 0..n {
            if wide_old[i] == 0 {
                wall[i] = old_px[i];
            } else if wide_new[i] == 0 {
                wall[i] = new_px[i];
            } else {
                known[i] = false;
                holes += 1;
            }
        }
        if holes > 0 {
            let desk = desktop(&old_px).filter(|d| d.len() == n)?;
            let mut tally = (0usize, 0usize);
            agreement(&desk, &old_px, &core_old, &mut tally);
            agreement(&desk, &new_px, &core_new, &mut tally);
            // With few uncovered pixels (tiling) there is nothing to check it against: it is trusted. When there
            // are enough and it does not fit (a new wallpaper, say) it is thrown away and photographed again.
            if tally.1 >= 300 && tally.0 * 100 < tally.1 * 90 {
                backdrop_forget();
                return None;
            }
            for i in 0..n {
                if !known[i] {
                    wall[i] = desk[i];
                }
            }
        }

        let layer = |px: &[u32], core: &[u8], wide: &[u8]| -> Vec<u32> {
            (0..n)
                .map(|i| {
                    let p = px[i];
                    let solid = match core[i] {
                        1 => true,                                        // inside a window: always the window's
                        2 => !near(p, wall[i]),                           // a corner: the wallpaper may show through
                        _ => wide[i] != 0 && !near(p, wall[i]),           // the shadow around a window
                    };
                    if solid {
                        p | 0xFF00_0000
                    } else {
                        0
                    }
                })
                .collect()
        };
        let (old, new) = (layer(&old_px, &core_old, &wide_old), layer(&new_px, &core_new, &wide_new));
        Some(Layers { w: wu, h: hu, wall, old, new })
    }

    /// One frame into `out`: the wallpaper, the old windows `off` pixels out, the new windows that far in. `off`
    /// goes past the width only if the curve overshoots: the new windows then sit a little beyond their place and the
    /// wallpaper shows in the gap.
    fn compose(&self, out: &mut [u32], off: i32, forward: bool) {
        let w = self.w as i32;
        let off = off.clamp(0, w + w / 4);
        let (dx_old, dx_new) = if forward { (-off, w - off) } else { (off, off - w) };
        // How far the slide has come (0 to 1) says how much of the old windows is left and how much of the new ones
        // is there: the new windows are solid exactly when they have arrived.
        let (a_old, a_new) = if CROSSFADE {
            let p = (off as f64 / w as f64).clamp(0.0, 1.0);
            ((((1.0 - p) * 256.0).round()) as u32, ((p * 256.0).round()) as u32)
        } else {
            (256, 256)
        };
        for y in 0..self.h {
            let row = y * self.w..(y + 1) * self.w;
            let line = &mut out[row.clone()];
            line.copy_from_slice(&self.wall[row.clone()]);
            paste(line, &self.old[row.clone()], dx_old, a_old);
            paste(line, &self.new[row], dx_new, a_new);
        }
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(Some(self.hwnd), self.dc);
            let _ = DestroyWindow(self.hwnd);
        }
    }
}
