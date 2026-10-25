//! Switching the Windows default playback device, so live filtering needs no trip to Sound settings and
//! audio comes back when NoMusic stops.
//!
//! Windows has no public API for setting the default device. Like EarTrumpet and SoundSwitch, this uses
//! the undocumented `IPolicyConfig` interface that the Sound control panel itself uses.
//!
//! While NoMusic has the cable set as default, the device to restore is also written to
//! `%LOCALAPPDATA%\NoMusic\restore-device.txt`, so a crash or kill doesn't leave the laptop silent: the
//! next start restores it.

#![allow(non_snake_case)] // IPolicyConfig's methods keep their COM names

use std::path::PathBuf;
use std::sync::Mutex;

use windows::core::{Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCommunications, eConsole, eMultimedia, eRender, ERole, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Console::{
    SetConsoleCtrlHandler, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
};
use windows::core::BOOL;

const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

// Only SetDefaultEndpoint is called; the other slots are declared to keep the vtable layout.
#[windows_core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: windows_core::IUnknown {
    fn GetMixFormat(&self, id: PCWSTR, format: *mut *mut core::ffi::c_void) -> HRESULT;
    fn GetDeviceFormat(&self, id: PCWSTR, default: i32, format: *mut *mut core::ffi::c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, id: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, id: PCWSTR, endpoint: *mut core::ffi::c_void, mix: *mut core::ffi::c_void) -> HRESULT;
    fn GetProcessingPeriod(&self, id: PCWSTR, default: i32, def: *mut i64, min: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, id: PCWSTR, period: *mut i64) -> HRESULT;
    fn GetShareMode(&self, id: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
    fn SetShareMode(&self, id: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
    fn GetPropertyValue(&self, id: PCWSTR, key: *const core::ffi::c_void, value: *mut core::ffi::c_void) -> HRESULT;
    fn SetPropertyValue(&self, id: PCWSTR, key: *const core::ffi::c_void, value: *mut core::ffi::c_void) -> HRESULT;
    fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
    fn SetEndpointVisibility(&self, id: PCWSTR, visible: i32) -> HRESULT;
}

/// A render endpoint: its Windows ID and friendly name (the name cpal shows too).
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
}

fn com() {
    // Ok if COM is already initialized on this thread (in either mode).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    com();
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn endpoint(device: &IMMDevice) -> windows::core::Result<Endpoint> {
    unsafe {
        let raw = device.GetId()?;
        let id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as _));
        let store = device.OpenPropertyStore(STGM_READ)?;
        let value = store.GetValue(&PKEY_Device_FriendlyName)?;
        let raw = PropVariantToStringAlloc(&value)?;
        let name = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as _));
        Ok(Endpoint { id, name })
    }
}

pub fn default_playback() -> Option<Endpoint> {
    let e = enumerator().ok()?;
    unsafe { e.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| endpoint(&d).ok()) }
}

pub fn playback_endpoints() -> Vec<Endpoint> {
    let Ok(e) = enumerator() else { return Vec::new() };
    unsafe {
        let Ok(list) = e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return Vec::new() };
        let n = list.GetCount().unwrap_or(0);
        (0..n).filter_map(|i| list.Item(i).ok().and_then(|d| endpoint(&d).ok())).collect()
    }
}

/// Makes `id` the default playback device for every role (games, media and calls).
pub fn set_default_playback(id: &str) -> Result<(), String> {
    com();
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let policy: windows_core::IUnknown =
            CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let policy: IPolicyConfig = policy.cast().map_err(|e| e.to_string())?;
        for role in [eConsole, eMultimedia, eCommunications] {
            policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role).ok().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn restore_file() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("NoMusic").join("restore-device.txt"))
}

/// (cable id, restore id) while the cable is our default, for the console close handler.
static ACTIVE: Mutex<Option<(String, String)>> = Mutex::new(None);

fn undo(cable_id: &str, restore_id: &str) {
    // Only undo our own change: leave it if the user picked another device meanwhile.
    if default_playback().is_some_and(|d| d.id == cable_id) {
        let _ = set_default_playback(restore_id);
    }
    if let Some(path) = restore_file() {
        let _ = std::fs::remove_file(path);
    }
}

// Closing the console window (or logging off) ends the process without running destructors, so restore
// the speakers here. Returning FALSE lets the default handling (and Ctrl+C handlers) continue.
unsafe extern "system" fn on_console_event(event: u32) -> BOOL {
    if matches!(event, CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT) {
        if let Some((cable, restore)) = ACTIVE.lock().ok().and_then(|mut a| a.take()) {
            undo(&cable, &restore);
        }
    }
    BOOL(0)
}

/// Routes all apps into the virtual cable for as long as this value lives, then puts `restore` back.
pub struct CableAsDefault {
    restore: Endpoint,
    cable_id: String,
}

impl CableAsDefault {
    /// `cable_name`: substring of the cable's playback side ("CABLE Input"); `restore`: the real speakers.
    pub fn activate(cable_name: &str, restore: Endpoint) -> Result<Self, String> {
        let cable = playback_endpoints()
            .into_iter()
            .find(|e| e.name.contains(cable_name))
            .ok_or(format!("\"{cable_name}\" not found"))?;
        if let Some(path) = restore_file() {
            let _ = std::fs::create_dir_all(path.parent().unwrap());
            let _ = std::fs::write(&path, &restore.id);
        }
        static HANDLER: std::sync::Once = std::sync::Once::new();
        HANDLER.call_once(|| unsafe {
            let _ = SetConsoleCtrlHandler(Some(on_console_event), true);
        });
        set_default_playback(&cable.id)?;
        if let Ok(mut a) = ACTIVE.lock() {
            *a = Some((cable.id.clone(), restore.id.clone()));
        }
        Ok(CableAsDefault { restore, cable_id: cable.id })
    }

    pub fn restore_name(&self) -> &str {
        &self.restore.name
    }
}

impl Drop for CableAsDefault {
    fn drop(&mut self) {
        if let Ok(mut a) = ACTIVE.lock() {
            *a = None;
        }
        undo(&self.cable_id, &self.restore.id);
    }
}

/// After a crash or kill: if the cable is still the default and we left a note, put the speakers back.
/// Returns the restored device's name.
pub fn recover(cable_name: &str) -> Option<String> {
    let path = restore_file()?;
    let id = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    if !default_playback()?.name.contains(cable_name) {
        return None;
    }
    let target = playback_endpoints().into_iter().find(|e| e.id == id.trim())?;
    set_default_playback(&target.id).ok()?;
    Some(target.name)
}
