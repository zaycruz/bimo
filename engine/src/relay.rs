//! The control-plane end of a guest's egress tunnel (U7, stage 1).
//!
//! A runtime in a guest reaches the network only through its credential
//! proxy, and the proxy (with its CA key and the real secrets) runs on the
//! control-plane host, never in a guest. The relay carries the runtime's
//! proxy connections there without exposing the proxy on the network: it
//! keeps a few authenticated connections open to the guest's bind agent
//! (`GET /tunnel` with the per-guest credential, answered 101). The bind
//! agent hands one to each connection the runtime makes to its loopback
//! egress port and sends 0x01; the relay then connects the proxy's loopback
//! listener and splices the two. 0x00 is a keepalive.
//!
//! Run by the driver as `monolith relay ...` in its own process group, so it
//! outlives the CLI invocation that started it and is stopped like any other
//! journaled process. The credential is read from a file, never argv.
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// The guest sends a keepalive every 15 s; four missed ones mean the tunnel
/// is dead.
const IDLE_READ_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(10);

pub struct Relay {
    /// The guest's bind agent, `address:port`.
    pub guest: String,
    pub credential: String,
    /// The proxy's loopback tunnel listener on this host.
    pub upstream: u16,
    /// Idle tunnels kept open at once.
    pub idle: usize,
}

enum Failure {
    /// The guest refused the credential or has no tunnel endpoint; retrying
    /// will not help.
    Fatal(String),
    Retry(String),
}

/// `monolith relay --guest <addr:port> --credential-file <file> --upstream <port> [--idle <n>]`
pub fn main(arguments: &[String]) -> i32 {
    let value = |flag: &str| {
        arguments
            .iter()
            .position(|a| a == flag)
            .and_then(|i| arguments.get(i + 1))
            .cloned()
    };
    let (Some(guest), Some(file), Some(upstream)) =
        (value("--guest"), value("--credential-file"), value("--upstream"))
    else {
        eprintln!("usage: monolith relay --guest <addr:port> --credential-file <file> --upstream <port> [--idle <n>]");
        return 64;
    };
    let Ok(upstream) = upstream.parse::<u16>() else {
        eprintln!("relay: --upstream must be a port");
        return 64;
    };
    let idle = value("--idle").and_then(|v| v.parse().ok()).unwrap_or(4usize).clamp(1, 32);
    let credential = match std::fs::read_to_string(PathBuf::from(&file)) {
        Ok(text) => text.trim().to_owned(),
        Err(error) => {
            eprintln!("relay: could not read the guest credential file: {error}");
            return 66;
        }
    };
    run(Relay {
        guest,
        credential,
        upstream,
        idle,
    })
}

/// Keep `idle` tunnels open until a fatal refusal. Returns the exit code.
pub fn run(relay: Relay) -> i32 {
    let relay = Arc::new(relay);
    let workers: Vec<_> = (0..relay.idle)
        .map(|_| {
            let relay = Arc::clone(&relay);
            thread::spawn(move || worker(&relay))
        })
        .collect();
    for worker in workers {
        if let Ok(Err(message)) = worker.join() {
            eprintln!("relay: stopping: {message}");
            return 2;
        }
    }
    0
}

fn worker(relay: &Relay) -> Result<(), String> {
    let mut backoff = Duration::from_millis(250);
    loop {
        match open(relay) {
            Ok(Some(stream)) => {
                backoff = Duration::from_millis(250);
                let upstream = relay.upstream;
                thread::spawn(move || splice(stream, upstream));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(Failure::Fatal(message)) => return Err(message),
            Err(Failure::Retry(message)) => {
                eprintln!("relay: {message}; retrying in {} ms", backoff.as_millis());
                thread::sleep(backoff);
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

fn address(guest: &str) -> Result<SocketAddr, Failure> {
    guest
        .to_socket_addrs()
        .map_err(|e| Failure::Retry(format!("cannot resolve {guest}: {e}")))?
        .next()
        .ok_or_else(|| Failure::Retry(format!("{guest} has no address")))
}

/// Open one tunnel and wait for it to be used. `Ok(None)` when it closed or
/// went quiet while idle.
fn open(relay: &Relay) -> Result<Option<TcpStream>, Failure> {
    let retry = |context: &str, error: io::Error| Failure::Retry(format!("{context}: {error}"));
    let mut stream = TcpStream::connect_timeout(&address(&relay.guest)?, CONNECT_TIMEOUT)
        .map_err(|e| retry(&format!("cannot reach {}", relay.guest), e))?;
    let _ = stream.set_nodelay(true);
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| retry("socket", e))?;
    let request = format!(
        "GET /tunnel HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nConnection: Upgrade\r\nUpgrade: monolith-tunnel\r\n\r\n",
        relay.guest, relay.credential
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| retry("tunnel request", e))?;
    let head = read_head(&mut stream).map_err(|e| retry("tunnel response", e))?;
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    match status {
        101 => {}
        401 | 403 => {
            return Err(Failure::Fatal(format!(
                "the guest at {} refused the credential (HTTP {status})",
                relay.guest
            )))
        }
        404 => {
            return Err(Failure::Fatal(format!(
                "the bind agent at {} has no tunnel endpoint; the template predates runtime delivery",
                relay.guest
            )))
        }
        other => return Err(Failure::Retry(format!("tunnel answered HTTP {other}"))),
    }
    stream
        .set_read_timeout(Some(IDLE_READ_TIMEOUT))
        .map_err(|e| retry("socket", e))?;
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => return Ok(None),
            Ok(_) if byte[0] == 0 => continue,
            Ok(_) if byte[0] == 1 => {
                stream.set_read_timeout(None).map_err(|e| retry("socket", e))?;
                return Ok(Some(stream));
            }
            Ok(_) => return Err(Failure::Retry(format!("unexpected tunnel byte {:#04x}", byte[0]))),
        }
    }
}

/// Read an HTTP response head byte by byte, so nothing after it is consumed.
fn read_head(stream: &mut TcpStream) -> io::Result<String> {
    let mut head = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err(io::Error::other("response head too long"));
        }
        if stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed during the response head"));
        }
        head.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

fn splice(guest: TcpStream, upstream_port: u16) {
    let upstream = match TcpStream::connect(("127.0.0.1", upstream_port)) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("relay: the proxy on 127.0.0.1:{upstream_port} is not answering: {error}");
            let _ = guest.shutdown(Shutdown::Both);
            return;
        }
    };
    let _ = upstream.set_nodelay(true);
    let (Ok(mut guest_read), Ok(mut upstream_write)) = (guest.try_clone(), upstream.try_clone()) else {
        return;
    };
    let outbound = thread::spawn(move || {
        let _ = io::copy(&mut guest_read, &mut upstream_write);
        let _ = upstream_write.shutdown(Shutdown::Write);
    });
    let (mut upstream_read, mut guest_write) = (upstream, guest);
    let _ = io::copy(&mut upstream_read, &mut guest_write);
    let _ = guest_write.shutdown(Shutdown::Both);
    let _ = upstream_read.shutdown(Shutdown::Both);
    let _ = outbound.join();
}
