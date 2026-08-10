use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InterfaceKind {
    Physical,
    ForeignTunnel,
    Virtual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Confidence {
    High,
    Ambiguous,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutboundInterface {
    pub alias: String,
    pub if_index: u32,
    pub kind: InterfaceKind,
    pub confidence: Confidence,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutboundCompatibility {
    pub foreign_tun_detected: bool,
    pub selected: Option<OutboundInterface>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
struct Adapter {
    alias: String,
    description: String,
    if_index: u32,
    up: bool,
    has_gateway: bool,
    has_unicast_address: bool,
    default_route_metric: Option<u32>,
    physical_type: bool,
    physical_address: bool,
    tunnel_type: bool,
}

fn decide(adapters: &[Adapter]) -> OutboundCompatibility {
    let foreign_tun_detected = adapters.iter().any(|adapter| {
        adapter.up
            && (adapter.tunnel_type
                || (!adapter.physical_type
                    && !adapter.physical_address
                    && adapter.description.to_ascii_lowercase().contains("tunnel")))
    });
    if !foreign_tun_detected {
        return OutboundCompatibility::default();
    }
    let mut candidates = adapters
        .iter()
        .filter(|adapter| {
            adapter.up
                && adapter.physical_type
                && adapter.physical_address
                && adapter.has_gateway
                && adapter.has_unicast_address
                && !adapter.tunnel_type
        })
        .collect::<Vec<_>>();
    if candidates.len() > 1 {
        let best_metric = candidates
            .iter()
            .filter_map(|adapter| adapter.default_route_metric)
            .min();
        if let Some(best_metric) = best_metric {
            let preferred = candidates
                .iter()
                .filter(|adapter| adapter.default_route_metric == Some(best_metric))
                .copied()
                .collect::<Vec<_>>();
            if preferred.len() == 1 {
                candidates = preferred;
            }
        }
    }
    match candidates.as_slice() {
        [adapter] => OutboundCompatibility {
            foreign_tun_detected,
            selected: Some(OutboundInterface {
                alias: adapter.alias.clone(),
                if_index: adapter.if_index,
                kind: InterfaceKind::Physical,
                confidence: Confidence::High,
                reason:
                    "active physical adapter with an address, upstream gateway, and preferred route"
                        .to_string(),
            }),
            reason: None,
        },
        [] => OutboundCompatibility {
            foreign_tun_detected,
            selected: None,
            reason: Some("unable to determine a physical upstream adapter".to_string()),
        },
        _ => OutboundCompatibility {
            foreign_tun_detected,
            selected: None,
            reason: Some("multiple physical upstream adapters are active".to_string()),
        },
    }
}

#[cfg(windows)]
pub(crate) fn resolve() -> Result<OutboundCompatibility, String> {
    use std::{ffi::c_void, ptr};
    use windows_sys::Win32::{
        Foundation::ERROR_BUFFER_OVERFLOW,
        NetworkManagement::{
            IpHelper::{
                FreeMibTable, GetAdaptersAddresses, GetIpForwardTable2, GAA_FLAG_INCLUDE_GATEWAYS,
                IF_TYPE_ETHERNET_CSMACD, IF_TYPE_IEEE80211, IF_TYPE_TUNNEL,
                IP_ADAPTER_ADDRESSES_LH, MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::AF_UNSPEC,
    };

    fn wide(value: *const u16) -> String {
        if value.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
        }
    }

    let mut size = 15 * 1024u32;
    let mut buffer = vec![0u8; size as usize];
    let result = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            GAA_FLAG_INCLUDE_GATEWAYS,
            ptr::null::<c_void>(),
            buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        )
    };
    if result == ERROR_BUFFER_OVERFLOW {
        buffer.resize(size as usize, 0);
    } else if result != 0 {
        return Err(format!("GetAdaptersAddresses failed: {result}"));
    }
    let result = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            GAA_FLAG_INCLUDE_GATEWAYS,
            ptr::null::<c_void>(),
            buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        )
    };
    if result != 0 {
        return Err(format!("GetAdaptersAddresses failed: {result}"));
    }
    let mut route_table = std::ptr::null_mut::<MIB_IPFORWARD_TABLE2>();
    let routes_result = unsafe { GetIpForwardTable2(AF_UNSPEC, &mut route_table) };
    let mut default_route_metrics = std::collections::HashMap::new();
    if routes_result == 0 && !route_table.is_null() {
        let count = unsafe { (*route_table).NumEntries as usize };
        let first = unsafe { (*route_table).Table.as_ptr() };
        for index in 0..count {
            let route: &MIB_IPFORWARD_ROW2 = unsafe { &*first.add(index) };
            if route.DestinationPrefix.PrefixLength == 0 && !route.Loopback {
                default_route_metrics
                    .entry(route.InterfaceIndex)
                    .and_modify(|metric: &mut u32| *metric = (*metric).min(route.Metric))
                    .or_insert(route.Metric);
            }
        }
        unsafe { FreeMibTable(route_table.cast()) };
    }

    let mut adapters = Vec::new();
    let mut current = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    while !current.is_null() {
        let item = unsafe { &*current };
        let if_index = unsafe { item.Anonymous1.Anonymous.IfIndex };
        adapters.push(Adapter {
            alias: wide(item.FriendlyName),
            description: wide(item.Description),
            if_index,
            up: item.OperStatus == IfOperStatusUp,
            has_gateway: !item.FirstGatewayAddress.is_null(),
            has_unicast_address: !item.FirstUnicastAddress.is_null(),
            default_route_metric: default_route_metrics.get(&if_index).copied(),
            physical_type: matches!(item.IfType, IF_TYPE_ETHERNET_CSMACD | IF_TYPE_IEEE80211),
            physical_address: item.PhysicalAddressLength > 0,
            tunnel_type: item.IfType == IF_TYPE_TUNNEL,
        });
        current = item.Next;
    }
    Ok(decide(&adapters))
}

#[cfg(not(windows))]
pub(crate) fn resolve() -> Result<OutboundCompatibility, String> {
    Ok(OutboundCompatibility::default())
}

#[cfg(test)]
mod tests {
    use super::{decide, Adapter};

    fn adapter(alias: &str, physical: bool, gateway: bool, tunnel: bool) -> Adapter {
        Adapter {
            alias: alias.to_string(),
            description: if tunnel { "Tunnel" } else { "Adapter" }.to_string(),
            if_index: 4,
            up: true,
            has_gateway: gateway,
            has_unicast_address: physical,
            default_route_metric: gateway.then_some(10),
            physical_type: physical,
            physical_address: physical,
            tunnel_type: tunnel,
        }
    }

    #[test]
    fn selects_only_physical_gateway_when_foreign_tunnel_exists() {
        let result = decide(&[
            adapter("Mimo", false, false, true),
            adapter("Ethernet", true, true, false),
        ]);
        assert!(result.foreign_tun_detected);
        assert_eq!(result.selected.unwrap().alias, "Ethernet");
    }

    #[test]
    fn does_not_guess_between_multiple_physical_gateways() {
        let result = decide(&[
            adapter("Mimo", false, false, true),
            adapter("Ethernet", true, true, false),
            adapter("Wi-Fi", true, true, false),
        ]);
        assert_eq!(result.selected, None);
        assert_eq!(
            result.reason.as_deref(),
            Some("multiple physical upstream adapters are active")
        );
    }

    #[test]
    fn leaves_normal_network_unbound() {
        let result = decide(&[adapter("Ethernet", true, true, false)]);
        assert!(!result.foreign_tun_detected);
        assert_eq!(result.selected, None);
    }

    #[test]
    fn prefers_the_lowest_metric_physical_default_route() {
        let mut ethernet = adapter("Ethernet", true, true, false);
        ethernet.if_index = 4;
        ethernet.default_route_metric = Some(50);
        let mut wifi = adapter("Wi-Fi", true, true, false);
        wifi.if_index = 8;
        wifi.default_route_metric = Some(10);
        let result = decide(&[adapter("Mimo", false, false, true), ethernet, wifi]);
        assert_eq!(result.selected.unwrap().alias, "Wi-Fi");
    }
}
