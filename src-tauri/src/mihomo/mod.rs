mod connections;
mod controller;
pub(crate) mod logs;
pub(crate) mod traffic;

pub use connections::{mihomo_close_all_connections, mihomo_close_connection, mihomo_connections};
pub use controller::{
    current_node, mihomo_proxies, mihomo_proxy_delay, mihomo_reload, mihomo_rule_provider_update,
    mihomo_rule_providers, mihomo_rules, mihomo_select_proxy, mihomo_start, mihomo_status,
    mihomo_stop, mihomo_version, CoreState, CoreStatus,
};

pub(crate) use controller::{
    api_delete, api_get, api_put, encode_path_segment, initialize_secret, is_running, mixed_port,
    owns_core, secret, start_owned_for_lifecycle, stop_owned_for_update, CONTROLLER,
};
