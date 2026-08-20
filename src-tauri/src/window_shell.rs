use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Theme, WebviewWindow};

const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl LogicalRect {
    fn validate(self, viewport_width: f64, viewport_height: f64) -> Result<Self, String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return Err("titlebar rectangle must contain finite values".to_string());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width <= 0.0 || self.height <= 0.0 {
            return Err(
                "titlebar rectangle must have a non-negative origin and positive size".to_string(),
            );
        }
        if self.width > 256.0 || self.height > 128.0 {
            return Err("titlebar rectangle exceeds the supported caption-button size".to_string());
        }
        if self.x + self.width > viewport_width + 1.0
            || self.y + self.height > viewport_height + 1.0
        {
            return Err("titlebar rectangle must stay inside the window client area".to_string());
        }
        Ok(self)
    }

    #[cfg(windows)]
    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowThemePreference {
    System,
    Light,
    Dark,
}

impl WindowThemePreference {
    fn tauri_theme(self) -> Option<Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(Theme::Light),
            Self::Dark => Some(Theme::Dark),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterialStatus {
    supported: bool,
    system_transparency_enabled: bool,
    applied: bool,
    fallback_reason: Option<String>,
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err("window shell commands are limited to the main window".to_string())
    }
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    platform::setup(app)
}

#[tauri::command]
pub fn window_set_maximize_button_rect(
    window: WebviewWindow,
    rect: LogicalRect,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let inner_size = window.inner_size().map_err(|error| error.to_string())?;
    let logical_size = inner_size.to_logical::<f64>(scale_factor);
    platform::set_maximize_button_rect(rect.validate(logical_size.width, logical_size.height)?)
}

#[tauri::command]
pub fn window_show_system_menu(window: WebviewWindow) -> Result<(), String> {
    ensure_main_window(&window)?;
    platform::show_system_menu(&window)
}

#[tauri::command]
pub fn window_material_set(
    window: WebviewWindow,
    enabled: bool,
    theme: WindowThemePreference,
) -> Result<WindowMaterialStatus, String> {
    ensure_main_window(&window)?;
    window
        .set_theme(theme.tauri_theme())
        .map_err(|error| error.to_string())?;
    platform::set_material(&window, enabled, theme)
}

#[cfg(windows)]
mod platform {
    use std::sync::{OnceLock, RwLock};

    use tauri::{
        utils::config::WindowEffectsConfig,
        window::{Effect, EffectsBuilder},
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
        Graphics::Gdi::ScreenToClient,
        UI::{
            HiDpi::GetDpiForWindow,
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                GetCursorPos, GetSystemMenu, PostMessageW, SetForegroundWindow, TrackPopupMenuEx,
                HTCLIENT, HTMAXBUTTON, HTNOWHERE, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NCDESTROY,
                WM_NCHITTEST, WM_SYSCOMMAND,
            },
        },
    };
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
        RegKey,
    };

    use super::{
        AppHandle, LogicalRect, Manager, WebviewWindow, WindowMaterialStatus,
        WindowThemePreference, MAIN_WINDOW_LABEL,
    };

    const WINDOW_SUBCLASS_ID: usize = 0x4d49_4f50;
    const WINDOWS_11_MINIMUM_BUILD: u32 = 22_000;

    static MAXIMIZE_BUTTON_RECT: OnceLock<RwLock<Option<LogicalRect>>> = OnceLock::new();

    fn maximize_button_rect() -> &'static RwLock<Option<LogicalRect>> {
        MAXIMIZE_BUTTON_RECT.get_or_init(|| RwLock::new(None))
    }

    pub fn setup(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .ok_or_else(|| "main window is unavailable".to_string())?;
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        let installed = unsafe {
            // SAFETY: `hwnd` belongs to the main UI thread while `setup` is running. The callback
            // uses process-lifetime state, never retains message pointers, and is removed on
            // `WM_NCDESTROY` with the same function and identifier.
            SetWindowSubclass(hwnd, Some(window_subclass_proc), WINDOW_SUBCLASS_ID, 0)
        };
        if installed == 0 {
            Err(format!(
                "failed to install the Windows titlebar subclass: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    pub fn set_maximize_button_rect(rect: LogicalRect) -> Result<(), String> {
        *maximize_button_rect()
            .write()
            .map_err(|_| "titlebar hit-test state lock is poisoned".to_string())? = Some(rect);
        Ok(())
    }

    pub fn show_system_menu(window: &WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        let mut cursor = POINT::default();
        if unsafe { GetCursorPos(&mut cursor) } == 0 {
            return Err(format!(
                "failed to read the system-menu cursor position: {}",
                std::io::Error::last_os_error()
            ));
        }
        let menu = unsafe { GetSystemMenu(hwnd, 0) };
        if menu.is_null() {
            return Err("the Windows system menu is unavailable".to_string());
        }

        unsafe {
            // SAFETY: `hwnd` and its system-owned menu remain valid for the synchronous menu
            // interaction. `TPM_RETURNCMD` returns a command identifier instead of dispatching it.
            let _ = SetForegroundWindow(hwnd);
            let command = TrackPopupMenuEx(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON,
                cursor.x,
                cursor.y,
                hwnd,
                std::ptr::null(),
            );
            if command != 0 && PostMessageW(hwnd, WM_SYSCOMMAND, command as usize, 0) == 0 {
                return Err(format!(
                    "failed to dispatch the Windows system-menu command: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }

    pub fn set_material(
        window: &WebviewWindow,
        enabled: bool,
        theme: WindowThemePreference,
    ) -> Result<WindowMaterialStatus, String> {
        let supported =
            windows_build_number().is_some_and(|build| build >= WINDOWS_11_MINIMUM_BUILD);
        let system_transparency_enabled = transparency_enabled();
        let fallback_reason =
            material_fallback_reason(enabled, supported, system_transparency_enabled);

        if let Some(reason) = fallback_reason {
            window
                .set_effects(None::<WindowEffectsConfig>)
                .map_err(|error| error.to_string())?;
            return Ok(WindowMaterialStatus {
                supported,
                system_transparency_enabled,
                applied: false,
                fallback_reason: Some(reason.to_string()),
            });
        }

        let effect = match theme {
            WindowThemePreference::System => Effect::Mica,
            WindowThemePreference::Light => Effect::MicaLight,
            WindowThemePreference::Dark => Effect::MicaDark,
        };
        if window
            .set_effects(EffectsBuilder::new().effect(effect).build())
            .is_err()
        {
            let _ = window.set_effects(None::<WindowEffectsConfig>);
            return Ok(WindowMaterialStatus {
                supported,
                system_transparency_enabled,
                applied: false,
                fallback_reason: Some("effect-unavailable".to_string()),
            });
        }

        Ok(WindowMaterialStatus {
            supported,
            system_transparency_enabled,
            applied: true,
            fallback_reason: None,
        })
    }

    fn windows_build_number() -> Option<u32> {
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
            .ok()?;
        key.get_value::<String, _>("CurrentBuildNumber")
            .or_else(|_| key.get_value::<String, _>("CurrentBuild"))
            .ok()?
            .parse()
            .ok()
    }

    fn transparency_enabled() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
            .and_then(|key| key.get_value::<u32, _>("EnableTransparency"))
            .is_ok_and(|enabled| enabled != 0)
    }

    fn material_fallback_reason(
        enabled: bool,
        supported: bool,
        system_transparency_enabled: bool,
    ) -> Option<&'static str> {
        if !enabled {
            Some("disabled-by-user")
        } else if !supported {
            Some("unsupported-windows-version")
        } else if !system_transparency_enabled {
            Some("system-transparency-disabled")
        } else {
            None
        }
    }

    unsafe extern "system" fn window_subclass_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _reference_data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(window_subclass_proc), WINDOW_SUBCLASS_ID);
            if let Ok(mut rect) = maximize_button_rect().write() {
                *rect = None;
            }
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }

        if message != WM_NCHITTEST {
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }

        // Let Tao retain ownership of resize edges, corners, and any other non-client area.
        let downstream = DefSubclassProc(hwnd, message, wparam, lparam);
        if downstream != HTCLIENT as LRESULT && downstream != HTNOWHERE as LRESULT {
            return downstream;
        }

        let Some(rect) = maximize_button_rect().read().ok().and_then(|rect| *rect) else {
            return downstream;
        };
        let Some((x, y)) = logical_client_point(hwnd, lparam) else {
            return downstream;
        };
        resolve_hit_test(downstream, Some(rect), (x, y))
    }

    fn resolve_hit_test(
        downstream: LRESULT,
        rect: Option<LogicalRect>,
        point: (f64, f64),
    ) -> LRESULT {
        if downstream != HTCLIENT as LRESULT && downstream != HTNOWHERE as LRESULT {
            return downstream;
        }
        if rect.is_some_and(|rect| rect.contains(point.0, point.1)) {
            HTMAXBUTTON as LRESULT
        } else {
            downstream
        }
    }

    fn signed_low_word(value: LPARAM) -> i32 {
        (value as u16 as i16) as i32
    }

    fn signed_high_word(value: LPARAM) -> i32 {
        ((value as u32 >> 16) as u16 as i16) as i32
    }

    unsafe fn logical_client_point(hwnd: HWND, lparam: LPARAM) -> Option<(f64, f64)> {
        let mut point = POINT {
            x: signed_low_word(lparam),
            y: signed_high_word(lparam),
        };
        if ScreenToClient(hwnd, &mut point) == 0 {
            return None;
        }
        let dpi = GetDpiForWindow(hwnd);
        if dpi == 0 {
            return None;
        }
        physical_to_logical((point.x, point.y), dpi)
    }

    fn physical_to_logical(point: (i32, i32), dpi: u32) -> Option<(f64, f64)> {
        if dpi == 0 {
            return None;
        }
        let scale_factor = f64::from(dpi) / 96.0;
        Some((
            f64::from(point.0) / scale_factor,
            f64::from(point.1) / scale_factor,
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn validates_caption_button_bounds() {
            let rect = LogicalRect {
                x: 754.0,
                y: 0.0,
                width: 46.0,
                height: 32.0,
            };
            assert!(rect.validate(800.0, 650.0).is_ok());
            assert!(LogicalRect {
                x: f64::NAN,
                ..rect
            }
            .validate(800.0, 650.0)
            .is_err());
            assert!(LogicalRect { x: 790.0, ..rect }
                .validate(800.0, 650.0)
                .is_err());
        }

        #[test]
        fn uses_half_open_hit_test_bounds() {
            let rect = LogicalRect {
                x: 450.0,
                y: 0.0,
                width: 46.0,
                height: 32.0,
            };
            assert!(rect.contains(450.0, 0.0));
            assert!(rect.contains(495.999, 31.999));
            assert!(!rect.contains(496.0, 16.0));
            assert!(!rect.contains(470.0, 32.0));
        }

        #[test]
        fn preserves_downstream_resize_hit_tests() {
            let rect = LogicalRect {
                x: 450.0,
                y: 0.0,
                width: 46.0,
                height: 32.0,
            };
            assert_eq!(resolve_hit_test(12, Some(rect), (470.0, 16.0)), 12);
            assert_eq!(
                resolve_hit_test(HTCLIENT as LRESULT, Some(rect), (470.0, 16.0)),
                HTMAXBUTTON as LRESULT
            );
        }

        #[test]
        fn converts_physical_points_at_real_dpi_scales() {
            assert_eq!(physical_to_logical((600, 300), 96), Some((600.0, 300.0)));
            assert_eq!(physical_to_logical((600, 300), 120), Some((480.0, 240.0)));
            assert_eq!(physical_to_logical((600, 300), 144), Some((400.0, 200.0)));
            assert_eq!(physical_to_logical((600, 300), 0), None);
        }

        #[test]
        fn decodes_negative_virtual_screen_coordinates() {
            let x = -120_i16;
            let y = 200_i16;
            let packed = ((y as u16 as u32) << 16) | u32::from(x as u16);
            assert_eq!(signed_low_word(packed as LPARAM), -120);
            assert_eq!(signed_high_word(packed as LPARAM), 200);
        }

        #[test]
        fn material_policy_has_deterministic_solid_fallbacks() {
            assert_eq!(
                material_fallback_reason(false, true, true),
                Some("disabled-by-user")
            );
            assert_eq!(
                material_fallback_reason(true, false, true),
                Some("unsupported-windows-version")
            );
            assert_eq!(
                material_fallback_reason(true, true, false),
                Some("system-transparency-disabled")
            );
            assert_eq!(material_fallback_reason(true, true, true), None);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{
        AppHandle, LogicalRect, WebviewWindow, WindowMaterialStatus, WindowThemePreference,
    };

    pub fn setup(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn set_maximize_button_rect(_rect: LogicalRect) -> Result<(), String> {
        Ok(())
    }

    pub fn show_system_menu(_window: &WebviewWindow) -> Result<(), String> {
        Err("the Windows system menu is unavailable on this platform".to_string())
    }

    pub fn set_material(
        _window: &WebviewWindow,
        _enabled: bool,
        _theme: WindowThemePreference,
    ) -> Result<WindowMaterialStatus, String> {
        Ok(WindowMaterialStatus {
            supported: false,
            system_transparency_enabled: false,
            applied: false,
            fallback_reason: Some("unsupported-platform".to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_window_theme_preferences() {
        assert_eq!(WindowThemePreference::System.tauri_theme(), None);
        assert_eq!(
            WindowThemePreference::Light.tauri_theme(),
            Some(Theme::Light)
        );
        assert_eq!(WindowThemePreference::Dark.tauri_theme(), Some(Theme::Dark));
    }
}
