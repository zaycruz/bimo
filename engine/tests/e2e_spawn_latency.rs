//! U1: spawn-latency benchmark on a Proxmox cluster (R3, KTD1).
//!
//! Live only. Gated on `MONOLITH_PROXMOX_LIVE=1`, a proxmox target in the
//! targets file and that target's pool-scoped write token (see
//! `tests/common/live_gate.rs`). Every run writes a dated report to
//! `.monolith/reports/`; a live run also rewrites
//! `docs/benchmarks/spawn-latency.md`.
//!
//! Failure modes, written before the benchmark:
//! - a number measured anywhere but the cluster is presented as R3 evidence;
//! - a cold clone is counted toward the pooled-claim percentiles;
//! - the clock excludes the claim-time bind step (KTD10) or starts after the
//!   request;
//! - the run "passes" without having reached the cluster;
//! - no mechanism clears one second and the result does not say so (the stop
//!   verdict must be explicit, and nothing proceeds on an assumption);
//! - guests the run created are left on the cluster after it ends or fails.
//!
//! What the clock covers: from the claim request to the bound guest's first
//! authenticated answer. For a pooled claim that is pool-state lock, journal,
//! `POST /bind` and `GET /status` on the guest. For a cold clone it is also
//! linked clone, network config, start and the bind agent coming up. It does
//! not cover spec validation, the credential proxy (U7) or a runtime's
//! first-task probe (U8), which no guest can answer yet; the report says so.
//!
//! Settings: `MONOLITH_BENCH_RUNS` (pooled claims, default 10),
//! `MONOLITH_BENCH_COLD_RUNS` (cold clones, default the same).
mod common;

use common::live_gate::{gate, live_driver, repo, write_report, Gate, Recorder, Sweeper};
use monolith::substrate::Substrate;
use serde_json::{json, Value};
use std::time::Instant;

const R3_MS: f64 = 1000.0;
const POOL_TENANT: &str = "bench-pool";
const COLD_TENANT: &str = "bench-cold";

#[test]
fn pooled_claim_reaches_first_task_under_one_second_on_the_cluster() {
    let (targets, target) = match gate() {
        Gate::NotRun(reason) => {
            let report = write_report(
                "spawn-latency",
                "NOT_RUN",
                json!({"reason": reason, "r3_evidence": false}),
            );
            eprintln!("NOT RUN: {reason}. Report: {}", report.display());
            return;
        }
        Gate::Requested(reason) => {
            let report = write_report(
                "spawn-latency",
                "NOT_RUN",
                json!({"reason": reason, "r3_evidence": false, "requested": true}),
            );
            panic!("NOT RUN (live run requested): {reason}. Report: {}", report.display());
        }
        Gate::Live { targets, target, .. } => (targets, target),
    };
    let runs = env_count("MONOLITH_BENCH_RUNS", 10);
    let cold_runs = env_count("MONOLITH_BENCH_COLD_RUNS", runs);
    let driver = live_driver(&targets, &target);
    let settings = driver.settings().expect("the live target has every driver field").clone();
    let template_version = match driver.template_version() {
        Ok(version) => version,
        Err(error) => {
            let reason = format!(
                "the golden template is not ready, so nothing was measured: {error} (next: {})",
                error.next.join("; ")
            );
            let report = write_report(
                "spawn-latency",
                "BLOCKED",
                json!({"reason": reason, "target": target, "r3_evidence": false}),
            );
            panic!("BLOCKED: {reason} Report: {}", report.display());
        }
    };
    let sweeper = Sweeper::new(&driver, &[POOL_TENANT, COLD_TENANT]);

    // Cold path: clone, configure, start, bind. Reported, never counted
    // toward R3.
    let mut cold = Vec::new();
    for run in 0..cold_runs {
        let mut journal = Recorder::default();
        let started = Instant::now();
        let claim = driver
            .cold_claim(COLD_TENANT, &format!("bench-cold-{run}"), run as u64 + 1, &mut journal)
            .unwrap_or_else(|error| panic!("cold clone {run} failed: {error}"));
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        sweeper.track(claim.vmid);
        assert!(!claim.pooled);
        assert_eq!(journal.touched.first(), Some(&claim.resource), "journaled before it was touched");
        cold.push(json!({"run": run, "ms": round(ms), "vmid": claim.vmid}));
        driver.destroy(&claim.resource).expect("destroy cold guest");
        eprintln!("cold {run}: {ms:.0} ms (vmid {})", claim.vmid);
    }

    // Pooled path: fill (untimed), then time each claim.
    let first_fill = driver.fill(POOL_TENANT).expect("fill the bench pool");
    assert!(first_fill.errors.is_empty(), "fill errors: {:?}", first_fill.errors);
    let mut idle_mem = Vec::new();
    for vmid in &first_fill.ready {
        sweeper.track(*vmid);
        if let Ok(Some(bytes)) = driver.guest_memory(*vmid) {
            idle_mem.push(json!({"vmid": vmid, "mem_mb": round(bytes as f64 / 1048576.0)}));
        }
    }
    let mut pooled = Vec::new();
    let mut fell_back = Vec::new();
    let mut fill_ms = Vec::new();
    for run in 0..runs {
        let fill_started = Instant::now();
        let fill = driver.fill(POOL_TENANT).expect("refill the bench pool");
        assert!(fill.errors.is_empty(), "refill errors: {:?}", fill.errors);
        for vmid in &fill.created {
            sweeper.track(*vmid);
        }
        if !fill.created.is_empty() {
            fill_ms.push(round(fill_started.elapsed().as_secs_f64() * 1000.0 / fill.created.len() as f64));
        }
        let mut journal = Recorder::default();
        let started = Instant::now();
        let claim = driver
            .claim(POOL_TENANT, &format!("bench-pool-{run}"), run as u64 + 1, &mut journal)
            .unwrap_or_else(|error| panic!("pooled claim {run} failed: {error}"));
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        sweeper.track(claim.vmid);
        assert_eq!(claim.status["payload"]["agent"], format!("bench-pool-{run}"));
        assert_eq!(claim.status["payload"]["tenant"], POOL_TENANT);
        let row = json!({"run": run, "ms": round(ms), "vmid": claim.vmid});
        if claim.pooled {
            pooled.push(row);
        } else {
            fell_back.push(row);
        }
        driver.destroy(&claim.resource).expect("destroy claimed guest");
        eprintln!("pooled {run}: {ms:.0} ms (vmid {}, pooled={})", claim.vmid, claim.pooled);
    }
    let drained = driver.drain(Some(POOL_TENANT)).expect("drain the bench pool");

    // Whether this node could host a Firecracker layer (KTD1 fallback).
    let firecracker = match driver.api_get(&format!("/nodes/{}/status", settings.node)).unwrap() {
        Ok(status) => {
            let flags = status["cpuinfo"]["flags"].as_str().unwrap_or_default().to_owned();
            json!({
                "hvm": status["cpuinfo"]["hvm"],
                "vmx_or_svm": flags.split_whitespace().any(|f| f == "vmx" || f == "svm"),
                "note": "hardware virtualization on the node; Firecracker would also need nested virtualization inside a guest or a bare-metal host",
            })
        }
        Err(error) => json!({"unknown": format!("the driver token cannot read node status: {error}")}),
    };

    let cold_stats = stats(&cold);
    let pooled_stats = stats(&pooled);
    let pooled_p95 = pooled_stats["p95_ms"].as_f64();
    let meets = pooled.len() == runs && pooled_p95.is_some_and(|p95| p95 < R3_MS);
    let verdict = if meets {
        "pool: a pooled claim of a pre-cloned, started LXC guest clears R3; build U6 on the warm pool".to_owned()
    } else if pooled.len() < runs {
        format!(
            "STOP: {} of {runs} claims fell back to a cold clone, so the pool did not hold; R3 is not shown",
            fell_back.len()
        )
    } else {
        format!(
            "STOP: pooled p95 {} ms is not under {R3_MS} ms; no mechanism measured clears R3",
            pooled_p95.unwrap_or(f64::NAN)
        )
    };
    let detail = json!({
        "target": target,
        "node": settings.node,
        "guest_type": "lxc",
        "template_id": settings.template_id,
        "template_version": template_version,
        "guest_memory_mb": settings.memory_mb,
        "warm_pool_size": settings.warm_pool_size,
        "runs": runs,
        "cold_runs": cold_runs,
        "r3_threshold_ms": R3_MS,
        "r3_evidence": true,
        "clock": "claim request to the bound guest's first authenticated answer (bind + status); excludes spec validation, the credential proxy (U7) and a runtime first-task probe (U8)",
        "pooled": {"stats": pooled_stats, "samples": pooled},
        "pooled_fell_back_to_cold": fell_back,
        "cold": {"stats": cold_stats, "samples": cold},
        "refill_ms_per_guest": fill_ms,
        "idle_memory_per_pooled_guest": idle_mem,
        "firecracker": firecracker,
        "drained": drained,
        "verdict": verdict,
        "meets_r3": meets,
    });
    let report = write_report("spawn-latency", if meets { "PASSED" } else { "FAILED" }, detail.clone());
    write_benchmark_doc(&detail, &report);
    drop(sweeper);
    assert!(meets, "{verdict}. Report: {}", report.display());
    eprintln!("{verdict}. Report: {}", report.display());
}

fn env_count(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Nearest-rank percentiles over the samples' `ms`.
fn stats(samples: &[Value]) -> Value {
    let mut values: Vec<f64> = samples.iter().filter_map(|s| s["ms"].as_f64()).collect();
    if values.is_empty() {
        return json!({"n": 0});
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = |p: f64| values[((p / 100.0 * values.len() as f64).ceil() as usize).clamp(1, values.len()) - 1];
    json!({
        "n": values.len(),
        "min_ms": values[0],
        "p50_ms": rank(50.0),
        "p95_ms": rank(95.0),
        "max_ms": values[values.len() - 1],
        "mean_ms": round(values.iter().sum::<f64>() / values.len() as f64),
    })
}

fn write_benchmark_doc(detail: &Value, report: &std::path::Path) {
    let p = &detail["pooled"]["stats"];
    let c = &detail["cold"]["stats"];
    let row = |name: &str, s: &Value| {
        format!(
            "| {name} | {} | {} | {} | {} | {} |\n",
            s["n"], s["p50_ms"], s["p95_ms"], s["min_ms"], s["max_ms"]
        )
    };
    let mem: Vec<String> = detail["idle_memory_per_pooled_guest"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| format!("{} MB (vmid {})", m["mem_mb"], m["vmid"]))
        .collect();
    let text = format!(
        "# Spawn latency (U1)\n\n\
         Generated by `MONOLITH_PROXMOX_LIVE=1 cargo test --test e2e_spawn_latency -- --nocapture`.\n\
         Machine-readable report: `{report}`.\n\n\
         ## Verdict\n\n{verdict}\n\n\
         ## Setup\n\n\
         - Target `{target}`, node `{node}`, guest type `lxc`, template {template} (version `{version}`).\n\
         - Linked clones (`full=0`) on `local-lvm`, {memory} MB each, warm pool size {size} per tenant.\n\
         - Clock: {clock}.\n\n\
         ## Results\n\n\
         | Path | n | p50 ms | p95 ms | min ms | max ms |\n|---|---|---|---|---|---|\n{pooled_row}{cold_row}\n\
         R3 threshold: pooled p95 under {threshold} ms. Cold clones are reported, not counted toward R3.\n\n\
         - Claims that fell back to a cold clone: {fell_back}\n\
         - Refill time per pooled guest (ms, off the request path): {refill}\n\
         - Idle memory per pooled guest: {mem}\n\
         - Firecracker fallback (node virtualization): {firecracker}\n",
        report = report.display(),
        verdict = detail["verdict"].as_str().unwrap_or_default(),
        target = detail["target"].as_str().unwrap_or_default(),
        node = detail["node"].as_str().unwrap_or_default(),
        template = detail["template_id"],
        version = detail["template_version"].as_str().unwrap_or_default(),
        memory = detail["guest_memory_mb"],
        size = detail["warm_pool_size"],
        clock = detail["clock"].as_str().unwrap_or_default(),
        pooled_row = row("pooled claim", p),
        cold_row = row("cold clone", c),
        threshold = R3_MS,
        fell_back = detail["pooled_fell_back_to_cold"].as_array().map_or(0, Vec::len),
        refill = detail["refill_ms_per_guest"],
        mem = if mem.is_empty() { "not read".to_owned() } else { mem.join(", ") },
        firecracker = detail["firecracker"],
    );
    let path = repo().join("docs/benchmarks/spawn-latency.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}
