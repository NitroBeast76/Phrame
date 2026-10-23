//! komorebi workspaces for the side bar.
//!
//! Bloom creates a named pipe, asks komorebi to write its events to it (`komorebic subscribe-pipe`) and reads the
//! state that comes with every event. The workspaces of the monitor the bar is on are sent to the bar as the
//! "komorebi-workspaces" event: { monitor, active, occupied: [bool, ...] }. The next monitor in komorebi's list
//! (the second screen) is sent the same way as "komorebi-workspaces-2", null when there is only one monitor.
//! When komorebi is not running (or stops) the thread keeps retrying quietly and the bar gets null.
//!
//! Workspace switches that start in Bloom (the dots, picking a window of another workspace, and the whkd hotkeys
//! through the "bloom-workspace" pipe) play the slide of wsfx.rs.

use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, HANDLE, HWND, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{ReadFile, PIPE_ACCESS_INBOUND};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::IO::CancelIoEx;

const PIPE_NAME: &str = "bloom-komorebi";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, PartialEq)]
pub struct Workspaces {
    /// Index of the monitor in komorebi's list (what `focus-monitor-workspace` takes).
    pub monitor: usize,
    /// Index of the focused workspace on that monitor.
    pub active: usize,
    /// One entry per workspace: true when it has windows.
    pub occupied: Vec<bool>,
}

/// Where komorebi keeps one window.
#[derive(Clone, Copy)]
struct Place {
    monitor: usize,
    index: usize,
    /// The workspace is the focused one of its monitor, so the window is on screen.
    showing: bool,
}

static LATEST: Mutex<Option<Workspaces>> = Mutex::new(None);
static LATEST2: Mutex<Option<Workspaces>> = Mutex::new(None);
/// Every window komorebi manages and where it is, from the newest state.
static PLACES: Mutex<Vec<(i64, Place)>> = Mutex::new(Vec::new());
/// Each monitor's rectangle (left, top, right, bottom), in komorebi's list order, from the newest state. The slide
/// transition needs to know which part of the screen a workspace switch happens on.
static MON_RECTS: Mutex<Vec<(i64, i64, i64, i64)>> = Mutex::new(Vec::new());
/// The monitor that has focus in komorebi (what `komorebic focus-workspace` acts on), usize::MAX when unknown.
static FOCUSED_MON: AtomicUsize = AtomicUsize::new(usize::MAX);

fn count(v: Option<&Value>) -> usize {
    match v {
        Some(Value::Array(a)) => a.len(),
        Some(o) => o.get("elements").and_then(|e| e.as_array()).map_or(0, |a| a.len()),
        None => 0,
    }
}

/// The entries of a komorebi list: a plain array, or an object that holds them in "elements" (its rings).
fn ring(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(o) => o
            .get("elements")
            .and_then(|e| e.as_array())
            .map(|a| a.iter().collect())
            .unwrap_or_default(),
        None => Vec::new(),
    }
}

/// The handle of every window komorebi has on a workspace: tiled and stacked, monocle, maximised and floating.
fn workspace_hwnds(ws: &Value) -> Vec<i64> {
    let mut out = Vec::new();
    let mut take = |w: &Value| {
        if let Some(h) = w.get("hwnd").and_then(Value::as_i64) {
            out.push(h);
        }
    };
    for c in ring(ws.get("containers")) {
        for w in ring(c.get("windows")) {
            take(w);
        }
    }
    if let Some(c) = ws.get("monocle_container").filter(|c| !c.is_null()) {
        for w in ring(c.get("windows")) {
            take(w);
        }
    }
    if let Some(w) = ws.get("maximized_window").filter(|w| !w.is_null()) {
        take(w);
    }
    for w in ring(ws.get("floating_windows")) {
        take(w);
    }
    out
}

fn has_windows(ws: &Value) -> bool {
    let set = |k: &str| ws.get(k).map_or(false, |v| !v.is_null());
    count(ws.get("containers")) > 0
        || count(ws.get("floating_windows")) > 0
        || set("maximized_window")
        || set("monocle_container")
}

/// komorebi's monitor rectangle as (left, top, right, bottom). Some versions give width and height where
/// right and bottom should be; the same check the old OSD script used tells them apart.
fn rect_of(mon: &Value) -> Option<(i64, i64, i64, i64)> {
    let s = mon.get("size")?;
    let l = s.get("left")?.as_i64()?;
    let t = s.get("top")?.as_i64()?;
    let r = s.get("right")?.as_i64()?;
    let b = s.get("bottom")?.as_i64()?;
    if r < l + 100 {
        Some((l, t, l + r, t + b))
    } else {
        Some((l, t, r, b))
    }
}

/// The workspaces of monitor `i` in komorebi's list.
fn workspaces_of(mons: &[Value], i: usize) -> Option<Workspaces> {
    let ws = mons.get(i)?.get("workspaces")?;
    let elements = ws.get("elements")?.as_array()?;
    let active = ws.get("focused")?.as_u64()? as usize;
    Some(Workspaces {
        monitor: i,
        active,
        occupied: elements.iter().map(has_windows).collect(),
    })
}

fn summarize(app: &AppHandle, state: &Value) -> Option<(Workspaces, Option<Workspaces>, Vec<(i64, Place)>)> {
    let mons = state.get("monitors")?.get("elements")?.as_array()?;
    if mons.is_empty() {
        return None;
    }
    // The monitor the bar is on: the one whose rectangle holds the centre of Bloom's target monitor.
    let centre = crate::utils::target_monitor(app).ok().flatten().map(|m| {
        let p = m.position();
        let s = m.size();
        (p.x as i64 + s.width as i64 / 2, p.y as i64 + s.height as i64 / 2)
    });
    let idx = centre
        .and_then(|(cx, cy)| {
            mons.iter().position(|m| {
                rect_of(m).map_or(false, |(l, t, r, b)| cx >= l && cx < r && cy >= t && cy < b)
            })
        })
        .unwrap_or(0);
    let first = workspaces_of(mons, idx)?;
    // Where every window lives, on all monitors.
    let mut places: Vec<(i64, Place)> = Vec::new();
    for (mi, m) in mons.iter().enumerate() {
        let Some(w) = m.get("workspaces") else { continue };
        let focused = w.get("focused").and_then(Value::as_u64).map(|f| f as usize);
        for (wi, wsp) in ring(w.get("elements")).into_iter().enumerate() {
            let showing = Some(wi) == focused;
            for h in workspace_hwnds(wsp) {
                places.push((h, Place { monitor: mi, index: wi, showing }));
            }
        }
    }
    // The next monitor in komorebi's list: its workspaces get a second list in the bar.
    let other = (0..mons.len()).find(|&i| i != idx).and_then(|i| workspaces_of(mons, i));
    Some((first, other, places))
}

/// Keeps `new` in `slot` and tells the bar, unless nothing changed.
fn emit_if_changed(app: &AppHandle, slot: &Mutex<Option<Workspaces>>, event: &str, new: Option<Workspaces>) {
    let Ok(mut cur) = slot.lock() else { return };
    if *cur == new {
        return;
    }
    *cur = new.clone();
    drop(cur);
    let _ = app.emit(event, new);
}

fn publish(app: &AppHandle, state: &Value) {
    let Some((p, other, places)) = summarize(app, state) else { return };
    // The places are kept even when the summary did not change: a window can move without the dots moving.
    if let Ok(mut pl) = PLACES.lock() {
        *pl = places;
    }
    if let Some(mons) = state.get("monitors").and_then(|m| m.get("elements")).and_then(Value::as_array) {
        if let Ok(mut r) = MON_RECTS.lock() {
            *r = mons.iter().map(|m| rect_of(m).unwrap_or((0, 0, 0, 0))).collect();
        }
    }
    let focused = state
        .get("monitors")
        .and_then(|m| m.get("focused"))
        .and_then(Value::as_u64)
        .map_or(usize::MAX, |f| f as usize);
    FOCUSED_MON.store(focused, Ordering::SeqCst);
    emit_if_changed(app, &LATEST, "komorebi-workspaces", Some(p));
    emit_if_changed(app, &LATEST2, "komorebi-workspaces-2", other);
}

fn clear(app: &AppHandle) {
    FOCUSED_MON.store(usize::MAX, Ordering::SeqCst);
    if let Ok(mut pl) = PLACES.lock() {
        pl.clear();
    }
    let had = LATEST.lock().map(|mut l| l.take().is_some()).unwrap_or(false);
    if had {
        let _ = app.emit("komorebi-workspaces", Option::<Workspaces>::None);
    }
    let had2 = LATEST2.lock().map(|mut l| l.take().is_some()).unwrap_or(false);
    if had2 {
        let _ = app.emit("komorebi-workspaces-2", Option::<Workspaces>::None);
    }
}

fn komorebic(args: &[&str]) -> Command {
    let mut c = Command::new("komorebic");
    c.args(args).creation_flags(CREATE_NO_WINDOW).stderr(Stdio::null());
    c
}

/// The state right now. The pipe only speaks when something changes, so the bar would stay empty until the
/// first workspace switch without this.
fn publish_current_state(app: &AppHandle) {
    let Ok(out) = komorebic(&["state"]).stdin(Stdio::null()).output() else { return };
    if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
        publish(app, &v);
    }
}

unsafe fn read_loop(app: &AppHandle, pipe: HANDLE) {
    publish_current_state(app);
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 65536];
    loop {
        let mut n = 0u32;
        if ReadFile(pipe, Some(&mut chunk), Some(&mut n), None).is_err() || n == 0 {
            break; // komorebi stopped or the pipe broke
        }
        buf.extend_from_slice(&chunk[..n as usize]);
        // Messages are concatenated JSON values; an incomplete one at the end waits for the next read.
        let mut consumed = 0;
        let mut last: Option<Value> = None;
        let mut garbled = false;
        {
            let mut it = serde_json::Deserializer::from_slice(&buf).into_iter::<Value>();
            while let Some(r) = it.next() {
                match r {
                    Ok(v) => {
                        consumed = it.byte_offset();
                        last = Some(v);
                    }
                    // Running out of data is a message that is still arriving; anything else is not JSON.
                    Err(e) => {
                        garbled = !e.is_eof();
                        break;
                    }
                }
            }
        }
        if garbled {
            buf.clear();
        } else {
            buf.drain(..consumed);
        }
        if buf.len() > 8_000_000 {
            buf.clear();
        }
        // Only the newest state matters.
        if let Some(st) = last.as_ref().and_then(|v| v.get("state")) {
            publish(app, st);
        }
    }
}

fn run_session(app: &AppHandle) {
    unsafe {
        let pipe = CreateNamedPipeW(
            w!("\\\\.\\pipe\\bloom-komorebi"),
            PIPE_ACCESS_INBOUND,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            65536,
            65536,
            0,
            None,
        );
        if pipe == INVALID_HANDLE_VALUE {
            return;
        }
        // Ask komorebi to connect to the pipe. This fails when komorebi is not running.
        let subscribed = komorebic(&["subscribe-pipe", PIPE_NAME])
            .stdout(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !subscribed {
            let _ = CloseHandle(pipe);
            return;
        }
        // If komorebi never connects, give up after a few seconds instead of waiting for ever.
        let connected = Arc::new(AtomicBool::new(false));
        {
            let connected = connected.clone();
            let raw = pipe.0 as isize;
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                if !connected.load(Ordering::SeqCst) {
                    let _ = CancelIoEx(HANDLE(raw as *mut core::ffi::c_void), None);
                }
            });
        }
        let ok = match ConnectNamedPipe(pipe, None) {
            Ok(()) => true,
            // komorebi connected before this call: fine.
            Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
        };
        connected.store(true, Ordering::SeqCst);
        if ok {
            read_loop(app, pipe);
        }
        let _ = CloseHandle(pipe);
    }
    clear(app);
}

/// Starts the background thread (call once, at startup).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        run_session(&app);
        std::thread::sleep(Duration::from_secs(3));
    });
    start_hotkey_pipe();
}

// ---------------------------------------------------------------- whkd hotkeys

/// Listens on the "bloom-workspace" pipe. whkd's workspace keys write the workspace index to it (whkdrc), so the
/// hotkeys get the same slide as the bar. When Bloom is not running the key falls back to plain `komorebic`
/// (see whkdrc), so the keys never stop working.
fn start_hotkey_pipe() {
    let (tx, rx) = mpsc::channel::<usize>();
    // One worker applies the switches. Keys pressed while a switch is going on are collected: only the newest one
    // is applied next, so mashing the keys does not queue up a row of slides.
    std::thread::spawn(move || {
        while let Ok(mut index) = rx.recv() {
            while let Ok(newer) = rx.try_recv() {
                index = newer;
            }
            apply_hotkey(index);
        }
    });
    std::thread::spawn(move || unsafe {
        loop {
            // A new instance for every client, so a key pressed right after another never finds the pipe busy.
            let pipe = CreateNamedPipeW(
                w!("\\\\.\\pipe\\bloom-workspace"),
                PIPE_ACCESS_INBOUND,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                256,
                256,
                0,
                None,
            );
            if pipe == INVALID_HANDLE_VALUE {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            let connected = match ConnectNamedPipe(pipe, None) {
                Ok(()) => true,
                Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
            };
            if !connected {
                let _ = CloseHandle(pipe);
                continue;
            }
            // Reading waits for the client to finish, so it happens off this thread.
            let raw = pipe.0 as isize;
            let tx = tx.clone();
            std::thread::spawn(move || {
                let pipe = HANDLE(raw as *mut core::ffi::c_void);
                let mut text: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 64];
                loop {
                    let mut n = 0u32;
                    if ReadFile(pipe, Some(&mut chunk), Some(&mut n), None).is_err() || n == 0 {
                        break; // the client disconnected: that is the end of the message
                    }
                    text.extend_from_slice(&chunk[..n as usize]);
                    if text.len() > 32 {
                        break;
                    }
                }
                let _ = CloseHandle(pipe);
                if let Ok(index) = String::from_utf8_lossy(&text).trim().parse::<usize>() {
                    let _ = tx.send(index);
                }
            });
        }
    });
}

/// Switches the focused monitor to workspace `index`, with the slide.
fn apply_hotkey(index: usize) {
    let monitor = FOCUSED_MON.load(Ordering::SeqCst);
    if monitor == usize::MAX {
        // komorebi's state is not known (yet): do what the hotkey did before Bloom took it over.
        let _ = komorebic(&["focus-workspace", &index.to_string()])
            .stdout(Stdio::null())
            .status();
        return;
    }
    switch_workspace_animated(monitor, index);
}

/// The workspaces as last seen (null while komorebi is not running). The bar asks once when it starts.
#[tauri::command]
pub fn komorebi_workspaces() -> Option<Workspaces> {
    LATEST.lock().ok().and_then(|l| l.clone())
}

/// The workspaces of the second monitor as last seen (null with one monitor or without komorebi).
#[tauri::command]
pub fn komorebi_workspaces_2() -> Option<Workspaces> {
    LATEST2.lock().ok().and_then(|l| l.clone())
}

fn switch_workspace(monitor: usize, index: usize) -> bool {
    let ok = |args: &[&str]| {
        komorebic(args)
            .stdout(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    let (m, i) = (monitor.to_string(), index.to_string());
    ok(&["focus-monitor-workspace", &m, &i]) || ok(&["focus-workspace", &i])
}

/// komorebi's index of the monitor the bar is on (the first list of the bar), as last seen.
fn bar_monitor() -> Option<usize> {
    LATEST.lock().ok().and_then(|l| l.as_ref().map(|w| w.monitor))
}

/// `switch_workspace` with the sliding transition (see wsfx.rs). Falls back to a plain switch whenever the slide
/// cannot be done (komorebi's state or the monitor is not known yet, same workspace, capture failed, ...).
fn switch_workspace_animated(monitor: usize, index: usize) -> bool {
    // The slide only plays on the monitor the bar is on. The other monitor has no bar, so a switch there (its dots,
    // its windows, a hotkey while it has focus) just happens.
    if bar_monitor() != Some(monitor) {
        return switch_workspace(monitor, index);
    }
    let from = focused_workspace(monitor);
    let rect = MON_RECTS.lock().ok().and_then(|r| r.get(monitor).copied());
    let (Some(from), Some((l, t, r, b))) = (from, rect) else {
        return switch_workspace(monitor, index);
    };
    if from == index || r <= l || b <= t {
        return switch_workspace(monitor, index);
    }
    crate::wsfx::slide(((l + r) / 2) as i32, ((t + b) / 2) as i32, index > from, || {
        if !switch_workspace(monitor, index) {
            return false;
        }
        // komorebic returns as soon as the command is sent; wait (at most 0.4 s) until komorebi reports the new
        // workspace as the focused one.
        for _ in 0..40 {
            if focused_workspace(monitor) == Some(index) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    })
}

/// Switches to workspace `index` on monitor `monitor`, with a slide. Runs on a worker thread because the slide
/// takes a few hundred milliseconds and must not hold up the window.
#[tauri::command]
pub async fn komorebi_focus_workspace(monitor: usize, index: usize) -> Result<(), String> {
    let ok = tauri::async_runtime::spawn_blocking(move || switch_workspace_animated(monitor, index))
        .await
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err("komorebic could not switch workspace".into())
    }
}

/// On screen and able to take focus. komorebi hides the windows of the workspaces that are not showing.
fn window_shown(hwnd: i64) -> bool {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsWindowVisible};
    unsafe {
        let h = HWND(hwnd as isize as *mut core::ffi::c_void);
        if !IsWindow(Some(h)).as_bool() {
            return false;
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        IsWindowVisible(h).as_bool() && cloaked == 0
    }
}

/// When komorebi has the window on a workspace that is not showing, switches to that workspace and waits (at
/// most about 0.6 s) until the window is back on screen. Focusing a hidden window does nothing, which is why
/// picking a window of another workspace from the bar used to fail. True when the window is ready to be focused.
/// The focused workspace of komorebi monitor `monitor`, as last seen.
fn focused_workspace(monitor: usize) -> Option<usize> {
    [&LATEST, &LATEST2].iter().find_map(|slot| {
        slot.lock()
            .ok()
            .and_then(|l| l.as_ref().filter(|w| w.monitor == monitor).map(|w| w.active))
    })
}

fn reveal_window(hwnd: i64, hint: Option<(usize, usize)>) -> bool {
    let place = PLACES
        .lock()
        .ok()
        .and_then(|p| p.iter().find(|(h, _)| *h == hwnd).map(|(_, pl)| *pl));
    match place {
        Some(p) if !p.showing => {
            if !switch_workspace_animated(p.monitor, p.index) {
                return false;
            }
            for _ in 0..40 {
                if window_shown(hwnd) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            window_shown(hwnd)
        }
        // On the workspace that is showing: nothing to do.
        Some(_) => true,
        // komorebi does not list it: a minimized window. The bar knows which workspace it belongs to (`hint`, the
        // monitor and workspace of the group it sits in); go there first, so restoring it puts it back there.
        None => {
            if let Some((m, i)) = hint {
                if focused_workspace(m) != Some(i) {
                    if !switch_workspace_animated(m, i) {
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
            true
        }
    }
}

/// Call before focusing a window from the bar (see `reveal_window`). `monitor` and `index` name the workspace the
/// window's group is for; they only matter for a window komorebi does not list (a minimized one).
#[tauri::command]
pub async fn komorebi_reveal_window(hwnd: i64, monitor: Option<usize>, index: Option<usize>) -> bool {
    let hint = monitor.zip(index);
    tauri::async_runtime::spawn_blocking(move || reveal_window(hwnd, hint))
        .await
        .unwrap_or(false)
}

/// The window that has focus right now is `hwnd`.
fn foreground_is(hwnd: i64) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize as i64 == hwnd }
}

/// Sends windows to workspace `to_index` of komorebi monitor `to_monitor`. komorebic only moves the window that has
/// focus, so each window is focused first (switching to its workspace when komorebi has it hidden) and the workspaces
/// that were switched away from are shown again at the end. Windows komorebi does not list (minimized ones) are
/// skipped. Returns how many were moved.
fn move_windows(hwnds: Vec<i64>, to_monitor: usize, to_index: usize) -> usize {
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let (m, i) = (to_monitor.to_string(), to_index.to_string());
    let mut restore: Vec<(usize, usize)> = Vec::new();
    let mut moved = 0;
    for h in hwnds {
        let place = PLACES
            .lock()
            .ok()
            .and_then(|p| p.iter().find(|(w, _)| *w == h).map(|(_, pl)| *pl));
        let Some(p) = place else { continue };
        if p.monitor == to_monitor && p.index == to_index {
            continue;
        }
        if !p.showing && !restore.iter().any(|(mon, _)| *mon == p.monitor) {
            if let Some(active) = focused_workspace(p.monitor) {
                restore.push((p.monitor, active));
            }
        }
        if !reveal_window(h, Some((p.monitor, p.index))) {
            continue;
        }
        unsafe {
            let _ = SetForegroundWindow(HWND(h as isize as *mut core::ffi::c_void));
        }
        for _ in 0..30 {
            if foreground_is(h) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Give komorebi a moment to see the focus change before telling it what to move.
        std::thread::sleep(Duration::from_millis(120));
        let sent = komorebic(&["send-to-monitor-workspace", &m, &i])
            .stdout(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if sent {
            moved += 1;
        }
    }
    for (mon, idx) in restore {
        switch_workspace(mon, idx);
    }
    moved
}

/// Drag and drop on the bar: sends the windows to a workspace (see `move_windows`).
#[tauri::command]
pub async fn komorebi_move_windows(hwnds: Vec<i64>, monitor: usize, index: usize) -> usize {
    tauri::async_runtime::spawn_blocking(move || move_windows(hwnds, monitor, index))
        .await
        .unwrap_or(0)
}
