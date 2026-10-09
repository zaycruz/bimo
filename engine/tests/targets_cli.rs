use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn monolith() -> &'static str {
    env!("CARGO_BIN_EXE_monolith")
}

fn run(args: &[&str]) -> (bool, String) {
    let output = Command::new(monolith())
        .args(args)
        .output()
        .expect("failed to run monolith");
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.success(), text)
}

struct TestDir(PathBuf);
impl TestDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "monolith-targets-cli-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn targets_lists_autodetected_local_target() {
    let (ok, text) = run(&["targets"]);
    assert!(ok, "targets command failed:\n{text}");
    assert!(text.contains("default target: local"), "{text}");
    assert!(text.contains("target local"), "{text}");
    assert!(text.contains("runtime=host_process"), "{text}");
}

#[test]
fn deploy_uses_local_target_by_default() {
    let dir = TestDir::new("deploy-local");
    let state_dir = dir.path().join("state");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo.toml");

    let (ok, text) = run(&[
        "deploy",
        manifest.to_str().unwrap(),
        "--state-dir",
        state_dir.to_str().unwrap(),
    ]);
    assert!(ok, "deploy command failed:\n{text}");
    assert!(text.contains("deploy target=local kind=local"), "{text}");
    assert!(text.contains("applied factory 'golden-path'"), "{text}");

    let (destroy_ok, destroy_text) = run(&["destroy", state_dir.to_str().unwrap()]);
    assert!(destroy_ok, "destroy command failed:\n{destroy_text}");
}

#[test]
fn deploy_selects_the_proxmox_driver_for_a_configured_target() {
    // Deploy goes through the substrate driver lookup. Without the token the
    // proxmox driver reports the missing token plainly. With
    // MONOLITH_PROXMOX_LIVE=1 and the token present the driver is reached on
    // the live cluster; it runs spec-declared agents, so a factory manifest is
    // refused before anything is created.
    let dir = TestDir::new("deploy-proxmox");
    let state_dir = dir.path().join("state");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/demo.toml");
    let targets = dir.path().join("targets.toml");
    let token_env = "MONOLITH_TARGETS_CLI_PROXMOX_TOKEN";
    fs::write(
        &targets,
        format!(
            r#"
schema_version = 1
default_target = "local"

[[targets]]
kind = "proxmox"
name = "lab"
api_url = "https://pve-node-b:8006/api2/json"
token_env = "{token_env}"
cluster = "homelab"
node = "pve-node-b"
guest_type = "lxc"
guest_id = 203
"#
        ),
    )
    .unwrap();
    let live = std::env::var("MONOLITH_PROXMOX_LIVE").as_deref() == Ok("1")
        && std::env::var("MONOLITH_PROXMOX_TOKEN").is_ok_and(|v| !v.is_empty());

    let mut command = Command::new(monolith());
    command.args([
        "deploy",
        manifest.to_str().unwrap(),
        "--state-dir",
        state_dir.to_str().unwrap(),
        "--target",
        "lab",
        "--targets-config",
        targets.to_str().unwrap(),
    ]);
    command.env_remove(token_env);
    if live {
        command.env(token_env, std::env::var("MONOLITH_PROXMOX_TOKEN").unwrap());
    }
    let output = command.output().expect("failed to run monolith");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.status.success(), "deploy of a factory manifest to proxmox must fail:\n{text}");
    assert!(!state_dir.exists(), "nothing may be created:\n{text}");
    if live {
        assert!(text.contains("uses the proxmox driver"), "{text}");
    } else {
        assert!(
            text.contains(&format!("environment variable {token_env} is not set")),
            "{text}"
        );
        assert!(text.contains(&format!("export {token_env}=")), "{text}");
    }
}
