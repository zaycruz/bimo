//! Unix process-group ownership. Runtime launches every supervisor with `setsid`.
use std::io;
use std::time::Duration;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub process_group: i32,
    pub session: String,
    pub launch_fingerprint: String,
    pub start_time: u128,
}

pub fn identity_alive(identity: &ProcessIdentity) -> bool {
    if !identity_shape_is_valid(identity) || !identity_matches_start_time(identity) {
        return false;
    }
    unsafe {
        libc::kill(identity.pid as i32, 0) == 0
            && libc::getpgid(identity.pid as i32) == identity.process_group
    }
}
fn identity_shape_is_valid(identity: &ProcessIdentity) -> bool {
    identity.pid != 0 && identity.process_group > 0 && identity.process_group == identity.pid as i32
}
fn identity_matches_start_time(identity: &ProcessIdentity) -> bool {
    process_start_time(identity.pid) == Some(identity.start_time)
}
pub fn process_start_time(pid: u32) -> Option<u128> {
    #[cfg(target_os = "macos")]
    {
        let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let result = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if result >= size {
            return Some(
                u128::from(info.pbi_start_tvsec) * 1_000_000 + u128::from(info.pbi_start_tvusec),
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (_, fields) = text.rsplit_once(") ")?;
        return fields
            .split_whitespace()
            .nth(19)
            .and_then(|value| value.parse::<u128>().ok());
    }
    None
}

pub fn stop_group(identity: &ProcessIdentity, grace: Duration) -> io::Result<()> {
    if !identity_shape_is_valid(identity) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid managed process identity",
        ));
    }
    let leader_matches = identity_matches_start_time(identity);
    let leader_group = unsafe { libc::getpgid(identity.pid as i32) };
    if leader_matches {
        if leader_group >= 0 && leader_group != identity.process_group {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "managed pid no longer owns recorded process group",
            ));
        }
    } else if process_start_time(identity.pid).is_some() {
        // The pid is alive but belongs to a different process: the recorded
        // leader exited and its pid was reused. A reused pid that is a
        // process-group leader (every pod-process is, via setsid) would pass
        // the group check below and get its group killed, taking down the new
        // pod. Refuse instead.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed pid was reused by a different process",
        ));
    } else if leader_group >= 0 && leader_group != identity.process_group {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed pid was reused outside recorded process group",
        ));
    }
    // The supervisor is the process-group leader. If it exited, its group can
    // still contain adapter descendants, so terminate the recorded group.
    if !process_group_exists(identity.process_group)? {
        return Ok(());
    }
    let signal = unsafe { libc::kill(-identity.process_group, libc::SIGTERM) };
    if signal != 0 {
        let error = io::Error::last_os_error();
        // ESRCH: the group vanished. EPERM: the group now contains only
        // zombies (a zombie group leader makes kill(-pgid, sig) fail with
        // EPERM on macOS), so there is nothing left to terminate.
        match error.raw_os_error() {
            Some(libc::ESRCH) | Some(libc::EPERM) => {}
            _ => return Err(error),
        }
    }
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline {
        if !process_group_exists(identity.process_group)? {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let signal = unsafe { libc::kill(-identity.process_group, libc::SIGKILL) };
    if signal != 0 {
        let error = io::Error::last_os_error();
        // ESRCH: the group vanished. EPERM: the group now contains only
        // zombies, so there is nothing left to terminate.
        match error.raw_os_error() {
            Some(libc::ESRCH) | Some(libc::EPERM) => {}
            _ => return Err(error),
        }
    }
    if process_group_exists(identity.process_group)? {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "managed process group survived termination",
        ));
    }
    Ok(())
}
fn process_group_exists(group: i32) -> io::Result<bool> {
    match unsafe { libc::kill(-group, 0) } {
        0 => Ok(true),
        -1 => match io::Error::last_os_error().raw_os_error() {
            // ESRCH: no such group. EPERM: the group contains only zombies
            // (a zombie group leader makes kill(-pgid, 0) fail with EPERM on
            // macOS), so it is effectively gone.
            Some(libc::ESRCH) | Some(libc::EPERM) => Ok(false),
            _ => Err(io::Error::last_os_error()),
        },
        _ => unreachable!(),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct RestartPolicy {
    pub failures: u32,
    pub restart_required: bool,
}
impl RestartPolicy {
    pub fn record_failure(&mut self) -> Option<Duration> {
        self.failures += 1;
        if self.failures >= 5 {
            self.restart_required = true;
            None
        } else {
            Some(Duration::from_millis(
                (100u64 * (1u64 << self.failures)).min(10_000),
            ))
        }
    }
}
