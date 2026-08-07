mod mihomo;
mod profiles;

use mihomo::{CoreState, mihomo_proxies, mihomo_proxy_delay, mihomo_reload, mihomo_select_proxy, mihomo_start, mihomo_status, mihomo_stop, mihomo_version};
use profiles::{profile_add, profile_apply, profile_download, profile_list, profile_remove};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CoreState::default())
        .invoke_handler(tauri::generate_handler![
            mihomo_start,
            mihomo_stop,
            mihomo_status,
            mihomo_version,
            mihomo_proxies,
            mihomo_reload,
            mihomo_select_proxy,
            mihomo_proxy_delay,
            profile_list,
            profile_add,
            profile_download,
            profile_apply,
            profile_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Felyx Proxy");
}
