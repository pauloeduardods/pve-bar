// SPDX-License-Identifier: GPL-3.0-or-later
//! pve-sys: the real I/O behind pve-core. The Proxmox and temperature agent
//! HTTP clients, certificate pinning, the GNOME Keyring and the config file.
//! Shared by pved and pvectl so neither duplicates I/O code.

pub mod http;
pub mod paths;
pub mod secret;
pub mod tls;

pub use http::{FetchError, ProxmoxClient, TempClient};
