//! Live checks on the Proxmox cluster (U5 to U9).
//!
//! Gated on `MONOLITH_PROXMOX_LIVE=1`, a proxmox target in the targets file
//! and that target's pool-scoped write token (see
//! `tests/common/live_gate.rs`). Every run writes a dated report to
//! `.monolith/reports/`.
//!
//! Live safety, enforced by the driver this suite drives: only the
//! user-provided pool-scoped token is used; no token, role, ACL, SDN or
//! firewall is created or modified; only guests cloned into the designated
//! pool and VMID range by this run are created, and only those are
//! destroyed. The out-of-pool check is a read, never a write.
//!
//! Failure modes, written before the cases:
//! - a guest is created outside the designated pool, outside the VMID range,
//!   without the ownership tag or marker, or on another tenant's address;
//! - the driver touches a VMID outside its range (the template, production
//!   guests) instead of refusing before any API call;
//! - an out-of-pool operation succeeds with the driver token (KTD3);
//! - a guest is created before it is journaled, so a killed apply leaves a
//!   guest nobody knows about; or recovery from the journal does not remove it;
//! - destroy is not idempotent (a second destroy fails);
//! - apply on the cluster reports ready without a first accepted task (AE1);
//! - an agent guest reaches the network other than through its tenant's
//!   proxy guest, or two tenants share a segment or address (AE4, KTD5);
//! - the agent guest can read a real secret or the CA key (AE3);
//! - the run "passes" without having reached the cluster;
//! - guests the run created are left behind when it fails.
mod common;

use common::live_gate::{gate, live_driver, write_report, Gate, Recorder, Sweeper};
use monolith::substrate::{codes, GuestRef, Resource, ResourceKind, Substrate};
use serde_json::{json, Value};

/// U5: create, tag, scope, recover and destroy real guests.
#[test]
fn driver_creates_scoped_tagged_guests_and_destroys_only_its_own() {
    let (targets, target) = match gate() {
        Gate::NotRun(reason) => {
            let report = write_report("proxmox-driver", "NOT_RUN", json!({"reason": reason}));
            eprintln!("NOT RUN: {reason}. Report: {}", report.display());
            return;
        }
        Gate::Requested(reason) => {
            let report = write_report("proxmox-driver", "NOT_RUN", json!({"reason": reason, "requested": true}));
            panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
        }
        Gate::Live { targets, target, .. } => (targets, target),
    };
    let driver = live_driver(&targets, &target);
    let settings = driver.settings().expect("the live target has every driver field").clone();
    if let Err(error) = driver.template_version() {
        let reason = format!("the golden template is not ready: {error} (next: {})", error.next.join("; "));
        let report = write_report("proxmox-driver", "BLOCKED", json!({"reason": reason, "target": target}));
        panic!("BLOCKED: {reason} Report: {}", report.display());
    }
    let sweeper = Sweeper::new(&driver, &["e2e-u5-a", "e2e-u5-b", "e2e-u5-crash"]);
    let mut checks = serde_json::Map::new();

    // Scope: VMIDs outside the range are refused before any API call. The
    // template and an unrelated guest are the two that matter.
    for vmid in [settings.template_id, 116] {
        let foreign = Resource {
            kind: ResourceKind::Guest,
            id: format!("pve:{}:{vmid}", settings.node),
            process: None,
            guest: Some(GuestRef {
                node: settings.node.clone(),
                vmid,
                guest_type: "lxc".to_owned(),
                address: None,
                template_version: None,
            }),
        };
        let error = driver.destroy(&foreign).expect_err("an out-of-range VMID must be refused");
        assert_eq!(error.code, codes::SUBSTRATE_REFUSED, "{error}");
        checks.insert(format!("refuses_vmid_{vmid}"), json!(error.message));
    }

    // KTD3: the token itself cannot reach outside the pool (read only).
    let denied = driver
        .api_get(&format!("/nodes/{}/lxc/116/config", settings.node))
        .unwrap()
        .expect_err("the pool-scoped token must not read a guest outside its pool");
    assert_eq!(denied.status, 403, "{denied}");
    checks.insert("out_of_pool_read_denied".into(), json!(denied.to_string()));

    // Happy path: two tenants, two guests, never the same address.
    let mut a_journal = Recorder::default();
    let a = driver.cold_claim("e2e-u5-a", "e2e-u5-a", 1, &mut a_journal).expect("create guest for tenant a");
    sweeper.track(a.vmid);
    let mut b_journal = Recorder::default();
    let b = driver.cold_claim("e2e-u5-b", "e2e-u5-b", 1, &mut b_journal).expect("create guest for tenant b");
    sweeper.track(b.vmid);
    for (claim, journal) in [(&a, &a_journal), (&b, &b_journal)] {
        assert_eq!(journal.touched, vec![claim.resource.clone()], "journaled before touched");
        assert_eq!(journal.created, vec![claim.resource.clone()]);
        assert!((settings.vmid_low..=settings.vmid_high).contains(&claim.vmid));
        assert!(settings.addresses.contains(claim.address));
        assert!(driver.alive(&claim.resource).unwrap(), "guest {} runs", claim.vmid);
    }
    assert_ne!(a.address, b.address, "two tenants share an address");
    let visible = driver.visible_guests().unwrap();
    for claim in [&a, &b] {
        let entry = visible
            .iter()
            .find(|g| g["vmid"].as_u64() == Some(u64::from(claim.vmid)))
            .expect("created guest is visible");
        assert_eq!(entry["pool"], Value::from(settings.pool.clone()));
        assert_eq!(entry["node"], Value::from(settings.node.clone()));
        let tags = entry["tags"].as_str().unwrap_or_default();
        assert!(tags.split(';').any(|t| t == "monolith"), "tags: {tags}");
        let config = driver
            .api_get(&format!("/nodes/{}/lxc/{}/config", settings.node, claim.vmid))
            .unwrap()
            .unwrap();
        assert!(config["description"].as_str().unwrap_or_default().contains("monolith-owned"));
    }
    checks.insert(
        "guests".into(),
        json!([
            {"tenant": "e2e-u5-a", "vmid": a.vmid, "address": a.address.to_string()},
            {"tenant": "e2e-u5-b", "vmid": b.vmid, "address": b.address.to_string()},
        ]),
    );
    checks.insert(
        "segments".into(),
        if settings.tenant_vlans.is_empty() {
            json!("shared bridge: tenant_vlans is empty, per-tenant segments (KTD5) are not provisioned yet")
        } else {
            json!(settings.tenant_vlans)
        },
    );

    // A killed apply: the guest exists, the journal has it as touched, the
    // control plane never recorded it as created. Recovery from the journal
    // removes it.
    let mut crashed = Recorder {
        fail_created: true,
        ..Recorder::default()
    };
    let error = driver
        .cold_claim("e2e-u5-crash", "e2e-u5-crash", 1, &mut crashed)
        .expect_err("injected journal failure");
    assert_eq!(error.code, codes::STATE_FAILED);
    assert_eq!(crashed.touched.len(), 1, "the guest was journaled before it was touched");
    let orphan = crashed.touched[0].clone();
    let orphan_vmid = orphan.guest.as_ref().unwrap().vmid;
    sweeper.track(orphan_vmid);
    assert!(driver.alive(&orphan).unwrap(), "the orphan exists before recovery");
    driver.destroy(&orphan).expect("recovery destroys the journaled guest");
    assert!(driver.vmid_free(orphan_vmid).unwrap(), "the orphan is gone");
    checks.insert("killed_apply_recovered_vmid".into(), json!(orphan_vmid));

    // Destroy, then destroy again: both succeed and the VMIDs are free.
    for claim in [&a, &b] {
        driver.destroy(&claim.resource).expect("destroy");
        driver.destroy(&claim.resource).expect("second destroy is a no-op");
        assert!(!driver.alive(&claim.resource).unwrap());
        assert!(driver.vmid_free(claim.vmid).unwrap());
    }
    checks.insert("destroy_idempotent".into(), json!(true));
    drop(sweeper);
    let report = write_report(
        "proxmox-driver",
        "PASSED",
        json!({"target": target, "node": settings.node, "pool": settings.pool, "checks": checks}),
    );
    eprintln!("PASSED. Report: {}", report.display());
}

/// AE4 on the cluster: tenant segments (KTD5). AE1 to AE3 on the cluster
/// live in `tests/e2e_proxmox_agents.rs` (eve and Hermes in guests, no real
/// key in a guest). Segment isolation needs the per-tenant VLANs and their
/// firewall rules, provisioned out of band; until the target maps tenants to
/// segments, the gate open reports BLOCKED and fails rather than passing on
/// nothing.
#[test]
fn agents_on_the_cluster_are_isolated_and_hold_no_real_credentials() {
    match gate() {
        Gate::NotRun(reason) => {
            let report = write_report("proxmox-live", "NOT_RUN", json!({"reason": reason}));
            eprintln!("NOT RUN: {reason}. Report: {}", report.display());
        }
        Gate::Requested(reason) => {
            let report = write_report("proxmox-live", "NOT_RUN", json!({"reason": reason, "requested": true}));
            panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
        }
        Gate::Live { targets, target, .. } => {
            let reason = "AE4 (tenant segments, KTD5) needs per-tenant VLANs and firewall rules provisioned \
                          out of band and mapped in the target's tenant_vlans; they are not, so guests of \
                          different tenants share vmbr0. AE1 to AE3 on the cluster are proven by \
                          tests/e2e_proxmox_agents.rs. Nothing was created by this test.";
            let report = write_report(
                "proxmox-live",
                "BLOCKED",
                json!({"reason": reason, "target": target, "targets_file": targets}),
            );
            panic!("BLOCKED: {reason} Report: {}", report.display());
        }
    }
}
