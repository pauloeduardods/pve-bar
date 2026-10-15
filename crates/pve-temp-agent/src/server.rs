// SPDX-License-Identifier: GPL-3.0-or-later
//! One connection at a time: read the head under a deadline, answer, close.

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::http::{self, HeadError, Status};
use crate::{hwmon, json};

/// Budget for reading a whole request head, and for each write.
pub const TIMEOUT: Duration = Duration::from_secs(5);

pub struct Context {
    pub token: Vec<u8>,
    pub sysfs_root: PathBuf,
}

/// Reads from a stream with one overall deadline, so a client trickling a
/// byte at a time cannot hold the (single) connection slot for longer than
/// [`TIMEOUT`].
struct Deadline<'a> {
    stream: &'a TcpStream,
    until: Instant,
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.stream.set_read_timeout(Some(left))?;
        let mut stream = self.stream;
        stream.read(buf)
    }
}

fn log_rejected(status: Status, peer: SocketAddr) {
    eprintln!(
        "pve-temp-agent: {} {} for {peer}",
        status.code(),
        status.reason()
    );
}

/// The response for one parsed request head.
fn respond(head: &[u8], peer: SocketAddr, ctx: &Context) -> Vec<u8> {
    let status = http::check_request(head, &ctx.token);
    if status != Status::Ok {
        log_rejected(status, peer);
        return http::error_response(status);
    }
    let Some(node) = hwmon::hostname(&ctx.sysfs_root) else {
        eprintln!("pve-temp-agent: cannot read the host name; 500 for {peer}");
        return http::error_response(Status::InternalError);
    };
    let sensors = hwmon::scan(&ctx.sysfs_root);
    http::response(
        Status::Ok,
        "application/json",
        &json::render(&node, &sensors),
    )
}

/// Serves one connection to completion. Never panics on client input.
pub fn handle(stream: TcpStream, peer: SocketAddr, ctx: &Context) {
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let mut reader = Deadline {
        stream: &stream,
        until: Instant::now() + TIMEOUT,
    };
    let reply = match http::read_head(&mut reader) {
        Ok(head) => respond(&head, peer, ctx),
        Err(HeadError::TooLarge) => {
            log_rejected(Status::HeadTooLarge, peer);
            http::error_response(Status::HeadTooLarge)
        }
        Err(HeadError::Closed(false)) => return, // a port probe; nothing to say
        Err(HeadError::Closed(true)) => {
            log_rejected(Status::BadRequest, peer);
            return;
        }
        Err(HeadError::Io(e)) => {
            eprintln!("pve-temp-agent: no request from {peer}: {e}");
            return;
        }
    };
    let mut stream = &stream;
    if stream
        .write_all(&reply)
        .and_then(|()| stream.flush())
        .is_ok()
    {
        let _ = stream.shutdown(Shutdown::Write);
    }
}

/// Accepts connections forever, one at a time.
pub fn serve(listener: &TcpListener, ctx: &Context) -> ! {
    loop {
        match listener.accept() {
            Ok((stream, peer)) => handle(stream, peer, ctx),
            Err(e) => {
                // E.g. EMFILE or ECONNABORTED: log and back off briefly.
                eprintln!("pve-temp-agent: accept failed: {e}");
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hwmon::fixture::Fixture;
    use std::thread;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

    /// Serves `requests.len()` connections on 127.0.0.1:0 and returns each
    /// raw response.
    fn exchange(fixture: &Fixture, requests: &[&[u8]]) -> Vec<String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let ctx = Context {
            token: TOKEN.as_bytes().to_vec(),
            sysfs_root: fixture.path().to_path_buf(),
        };
        let count = requests.len();
        let server = thread::spawn(move || {
            for _ in 0..count {
                let (stream, peer) = listener.accept().unwrap();
                handle(stream, peer, &ctx);
            }
        });
        let replies = requests
            .iter()
            .map(|req| {
                let mut stream = TcpStream::connect(addr).unwrap();
                stream.set_read_timeout(Some(TIMEOUT)).unwrap();
                stream.write_all(req).unwrap();
                let mut reply = String::new();
                stream.read_to_string(&mut reply).unwrap();
                reply
            })
            .collect();
        server.join().unwrap();
        replies
    }

    #[test]
    fn real_request_over_tcp() {
        let f = Fixture::typical("tcp");
        let good =
            format!("GET /temps HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n\r\n");
        let replies = exchange(
            &f,
            &[
                good.as_bytes(),
                b"GET /temps HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n",
                b"GET /metrics HTTP/1.1\r\n\r\n",
                b"DELETE /temps HTTP/1.1\r\n\r\n",
                b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\r\n\r\n",
            ],
        );
        let (head, body) = replies[0].split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        assert!(head.contains("Content-Type: application/json"));
        assert!(head.contains("Connection: close"));
        assert_eq!(
            body,
            r#"{"schema":1,"node":"pve","sensors":[{"chip":"coretemp","label":"Core 0","celsius":51.0},{"chip":"coretemp","label":"Package id 0","celsius":54.0},{"chip":"nvme","label":"Composite","celsius":41.85}]}"#
        );
        assert!(replies[1].starts_with("HTTP/1.1 401 "));
        assert!(replies[2].starts_with("HTTP/1.1 404 "));
        assert!(replies[3].starts_with("HTTP/1.1 405 "));
        assert!(replies[4].starts_with("HTTP/1.1 400 "));
    }

    #[test]
    fn oversized_and_missing_hostname_over_tcp() {
        let f = Fixture::new("tcp-nohost");
        // Exactly MAX_HEAD bytes without a blank line: the server consumes all
        // of it, so closing does not reset the connection under the reply.
        let mut big = format!("GET /temps HTTP/1.1\r\nX: {}", "a".repeat(http::MAX_HEAD));
        big.truncate(http::MAX_HEAD);
        let good = format!("GET /temps HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\n\r\n");
        let replies = exchange(&f, &[big.as_bytes(), good.as_bytes()]);
        assert!(replies[0].starts_with("HTTP/1.1 431 "), "{}", replies[0]);
        assert!(replies[1].starts_with("HTTP/1.1 500 "));
    }
}
