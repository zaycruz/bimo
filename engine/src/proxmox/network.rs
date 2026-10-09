//! Static address allocation for the no-DHCP guest segment (U5).
//!
//! The LAN has no DHCP, so the driver assigns each guest an address from the
//! target's `address_range`. An address is free when no guest the pool state
//! records and no guest visible to the driver token holds it.
use std::collections::BTreeSet;
use std::net::Ipv4Addr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddressRange {
    pub first: Ipv4Addr,
    pub last: Ipv4Addr,
}

impl AddressRange {
    /// Parse `a.b.c.d-e.f.g.h` (inclusive).
    pub fn parse(value: &str) -> Result<Self, String> {
        let (first, last) = value
            .split_once('-')
            .ok_or_else(|| "expected first-last, for example 10.0.0.10-10.0.0.20".to_owned())?;
        let first: Ipv4Addr = first.trim().parse().map_err(|_| format!("'{first}' is not an IPv4 address"))?;
        let last: Ipv4Addr = last.trim().parse().map_err(|_| format!("'{last}' is not an IPv4 address"))?;
        if u32::from(first) > u32::from(last) {
            return Err("the first address is above the last".to_owned());
        }
        if u32::from(last) - u32::from(first) > 1024 {
            return Err("the range holds more than 1024 addresses".to_owned());
        }
        Ok(Self { first, last })
    }

    pub fn contains(&self, address: Ipv4Addr) -> bool {
        (u32::from(self.first)..=u32::from(self.last)).contains(&u32::from(address))
    }

    pub fn len(&self) -> usize {
        (u32::from(self.last) - u32::from(self.first) + 1) as usize
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// The lowest address in the range that is not in `used`.
    pub fn allocate(&self, used: &BTreeSet<Ipv4Addr>) -> Option<Ipv4Addr> {
        (u32::from(self.first)..=u32::from(self.last))
            .map(Ipv4Addr::from)
            .find(|address| !used.contains(address))
    }
}

/// The address in a Proxmox LXC `netN` value (`...,ip=10.0.0.5/24,...`).
pub fn net_address(net: &str) -> Option<Ipv4Addr> {
    net.split(',').find_map(|part| {
        let value = part.strip_prefix("ip=")?;
        value.split('/').next()?.parse().ok()
    })
}

/// The `net0` value for a guest. `vlan` places the guest on its tenant's
/// segment (KTD5).
pub fn net0(bridge: &str, address: Ipv4Addr, prefix: u8, gateway: Ipv4Addr, vlan: Option<u16>) -> String {
    let mut value = format!("name=eth0,bridge={bridge},ip={address}/{prefix},gw={gateway}");
    if let Some(tag) = vlan {
        value.push_str(&format!(",tag={tag}"));
    }
    value
}
