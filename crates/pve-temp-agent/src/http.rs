// SPDX-License-Identifier: GPL-3.0-or-later
//! The smallest HTTP/1.1 subset the agent needs: read one request head
//! (bounded), decide the status, write one response, close.

use std::io::{self, Read};

/// The request head (request line + headers) is never read past this.
pub const MAX_HEAD: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    BadRequest,
    Unauthorized,
    NotFound,
    MethodNotAllowed,
    HeadTooLarge,
    InternalError,
}

impl Status {
    pub fn code(self) -> u16 {
        match self {
            Self::Ok => 200,
            Self::BadRequest => 400,
            Self::Unauthorized => 401,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::HeadTooLarge => 431,
            Self::InternalError => 500,
        }
    }

    pub fn reason(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::BadRequest => "Bad Request",
            Self::Unauthorized => "Unauthorized",
            Self::NotFound => "Not Found",
            Self::MethodNotAllowed => "Method Not Allowed",
            Self::HeadTooLarge => "Request Header Fields Too Large",
            Self::InternalError => "Internal Server Error",
        }
    }
}

#[derive(Debug)]
pub enum HeadError {
    /// No blank line within [`MAX_HEAD`] bytes.
    TooLarge,
    /// The peer closed the connection; `true` if it sent anything first.
    Closed(bool),
    Io(io::Error),
}

/// Offset just past the blank line that ends the head (`\r\n\r\n`, or a
/// bare `\n\n` from hand-typed requests).
fn head_end(buf: &[u8]) -> Option<usize> {
    buf.iter().enumerate().find_map(|(i, &b)| {
        if b != b'\n' {
            return None;
        }
        match buf.get(i + 1..) {
            Some([b'\n', ..]) => Some(i + 2),
            Some([b'\r', b'\n', ..]) => Some(i + 3),
            _ => None,
        }
    })
}

/// Reads until the end of the head and returns it (body bytes, if any, are
/// dropped). Never reads more than [`MAX_HEAD`] bytes.
pub fn read_head(r: &mut impl Read) -> Result<Vec<u8>, HeadError> {
    let mut buf = vec![0u8; MAX_HEAD];
    let mut len = 0;
    loop {
        if len == MAX_HEAD {
            return Err(HeadError::TooLarge);
        }
        let n = match r.read(&mut buf[len..]) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(HeadError::Io(e)),
        };
        if n == 0 {
            return Err(HeadError::Closed(len > 0));
        }
        len += n;
        if let Some(end) = head_end(&buf[..len]) {
            buf.truncate(end);
            return Ok(buf);
        }
    }
}

fn trim(mut s: &[u8]) -> &[u8] {
    while let [b' ' | b'\t', rest @ ..] = s {
        s = rest;
    }
    while let [rest @ .., b' ' | b'\t'] = s {
        s = rest;
    }
    s
}

/// Equality whose running time depends only on the length of `expected`.
pub fn constant_time_eq(given: &[u8], expected: &[u8]) -> bool {
    let mut diff = u8::from(given.len() != expected.len());
    for (i, &e) in expected.iter().enumerate() {
        diff |= given.get(i).copied().unwrap_or(0) ^ e;
    }
    std::hint::black_box(diff) == 0
}

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// Decides the response for one request head. `token` is the expected
/// bearer token.
pub fn check_request(head: &[u8], token: &[u8]) -> Status {
    let mut lines = head
        .split(|&b| b == b'\n')
        .map(|l| l.strip_suffix(b"\r").unwrap_or(l));

    let Some(request_line) = lines.next() else {
        return Status::BadRequest;
    };
    let parts: Vec<&[u8]> = request_line.split(|&b| b == b' ').collect();
    let [method, target, version] = parts[..] else {
        return Status::BadRequest;
    };
    if method.is_empty()
        || !method.iter().all(|&b| is_tchar(b))
        || target.is_empty()
        || !target.iter().all(|&b| b.is_ascii_graphic())
        || !matches!(version, b"HTTP/1.1" | b"HTTP/1.0")
    {
        return Status::BadRequest;
    }

    let mut authorization = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some(colon) = line.iter().position(|&b| b == b':') else {
            return Status::BadRequest;
        };
        let name = &line[..colon];
        // An empty name, or leading whitespace (obsolete line folding).
        if name.is_empty() || !name.iter().all(|&b| is_tchar(b)) {
            return Status::BadRequest;
        }
        if name.eq_ignore_ascii_case(b"authorization") {
            if authorization.is_some() {
                return Status::BadRequest;
            }
            authorization = Some(trim(&line[colon + 1..]));
        }
    }

    if method != b"GET" {
        return Status::MethodNotAllowed;
    }
    if target != b"/temps" {
        return Status::NotFound;
    }
    let Some(value) = authorization else {
        return Status::Unauthorized;
    };
    let Some(space) = value.iter().position(|&b| b == b' ') else {
        return Status::Unauthorized;
    };
    let (scheme, credentials) = (&value[..space], trim(&value[space..]));
    if scheme.eq_ignore_ascii_case(b"bearer") && constant_time_eq(credentials, token) {
        Status::Ok
    } else {
        Status::Unauthorized
    }
}

/// A complete response; every one closes the connection.
pub fn response(status: Status, content_type: &str, body: &str) -> Vec<u8> {
    let extra = match status {
        Status::Unauthorized => "WWW-Authenticate: Bearer\r\n",
        Status::MethodNotAllowed => "Allow: GET\r\n",
        _ => "",
    };
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\n{extra}Connection: close\r\n\r\n{body}",
        status.code(),
        status.reason(),
        body.len(),
    )
    .into_bytes()
}

/// A plain-text error response.
pub fn error_response(status: Status) -> Vec<u8> {
    response(
        status,
        "text/plain; charset=utf-8",
        &format!("{}\n", status.reason()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &[u8] = b"0123456789abcdef0123456789abcdef0123456789abcdef";

    fn check(head: &str) -> Status {
        check_request(head.as_bytes(), TOKEN)
    }

    fn get(path: &str, auth: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: pve\r\n{auth}User-Agent: t\r\n\r\n")
    }

    const GOOD_AUTH: &str =
        "Authorization: Bearer 0123456789abcdef0123456789abcdef0123456789abcdef\r\n";

    #[test]
    fn good_request() {
        assert_eq!(check(&get("/temps", GOOD_AUTH)), Status::Ok);
        // Case-insensitive header name and scheme, extra spaces, HTTP/1.0,
        // bare LF line endings.
        assert_eq!(
            check(&format!(
                "GET /temps HTTP/1.0\nauthorization:   bearer  {}  \n\n",
                std::str::from_utf8(TOKEN).unwrap()
            )),
            Status::Ok
        );
    }

    #[test]
    fn missing_or_wrong_token() {
        assert_eq!(check(&get("/temps", "")), Status::Unauthorized);
        assert_eq!(
            check(&get("/temps", "Authorization: Bearer nope\r\n")),
            Status::Unauthorized
        );
        assert_eq!(
            check(&get("/temps", "Authorization: Bearer\r\n")),
            Status::Unauthorized
        );
        assert_eq!(
            check(&get(
                "/temps",
                "Authorization: Basic 0123456789abcdef0123456789abcdef0123456789abcdef\r\n"
            )),
            Status::Unauthorized
        );
        // A prefix or an extension of the token is wrong too.
        assert_eq!(
            check(&get(
                "/temps",
                "Authorization: Bearer 0123456789abcdef0123456789abcdef0123456789abcde\r\n"
            )),
            Status::Unauthorized
        );
        assert_eq!(
            check(&get(
                "/temps",
                "Authorization: Bearer 0123456789abcdef0123456789abcdef0123456789abcdefX\r\n"
            )),
            Status::Unauthorized
        );
    }

    #[test]
    fn wrong_path_or_method() {
        assert_eq!(check(&get("/", GOOD_AUTH)), Status::NotFound);
        assert_eq!(check(&get("/temps/", GOOD_AUTH)), Status::NotFound);
        assert_eq!(check(&get("/temps?x=1", GOOD_AUTH)), Status::NotFound);
        assert_eq!(
            check(&format!("POST /temps HTTP/1.1\r\n{GOOD_AUTH}\r\n")),
            Status::MethodNotAllowed
        );
        assert_eq!(
            check("HEAD /temps HTTP/1.1\r\n\r\n"),
            Status::MethodNotAllowed
        );
        assert_eq!(
            check("get /temps HTTP/1.1\r\n\r\n"),
            Status::MethodNotAllowed
        );
    }

    #[test]
    fn malformed() {
        for head in [
            "",
            "\r\n\r\n",
            "GET /temps\r\n\r\n",
            "GET  /temps HTTP/1.1\r\n\r\n",
            "GET /temps HTTP/2\r\n\r\n",
            "GET /temps HTTP/1.1 extra\r\n\r\n",
            "G\0T /temps HTTP/1.1\r\n\r\n",
            "GET /te\x01mps HTTP/1.1\r\n\r\n",
            "GET /temps HTTP/1.1\r\nno colon here\r\n\r\n",
            "GET /temps HTTP/1.1\r\n: empty name\r\n\r\n",
            "GET /temps HTTP/1.1\r\nHost: a\r\n folded: b\r\n\r\n",
        ] {
            assert_eq!(check(head), Status::BadRequest, "{head:?}");
        }
        // Two Authorization headers are ambiguous.
        assert_eq!(
            check(&format!(
                "GET /temps HTTP/1.1\r\n{GOOD_AUTH}{GOOD_AUTH}\r\n"
            )),
            Status::BadRequest
        );
    }

    #[test]
    fn garbage_never_panics() {
        let mut seed: u32 = 0x1234_5678;
        for len in 0..600 {
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    // Bias towards bytes that matter to the parser.
                    match seed % 8 {
                        0 => b'\n',
                        1 => b' ',
                        2 => b':',
                        3 => b'\r',
                        _ => (seed >> 8) as u8,
                    }
                })
                .collect();
            assert_ne!(check_request(&bytes, TOKEN), Status::Ok);
            let _ = read_head(&mut bytes.as_slice());
        }
    }

    #[test]
    fn reads_head_and_stops() {
        let req = format!("{}BODY THAT IS NEVER READ", get("/temps", GOOD_AUTH));
        let head = read_head(&mut req.as_bytes()).unwrap();
        assert!(head.ends_with(b"User-Agent: t\r\n\r\n"));
        assert_eq!(check_request(&head, TOKEN), Status::Ok);
    }

    #[test]
    fn oversized_head() {
        let req = format!(
            "GET /temps HTTP/1.1\r\nX-Pad: {}\r\n\r\n",
            "a".repeat(MAX_HEAD)
        );
        assert!(matches!(
            read_head(&mut req.as_bytes()),
            Err(HeadError::TooLarge)
        ));
        // An endless stream is cut off after MAX_HEAD bytes too.
        assert!(matches!(
            read_head(&mut io::repeat(b'x')),
            Err(HeadError::TooLarge)
        ));
        // Exactly at the limit is fine.
        let pad = MAX_HEAD - "GET /temps HTTP/1.1\r\nX: \r\n\r\n".len();
        let req = format!("GET /temps HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(pad));
        assert_eq!(req.len(), MAX_HEAD);
        assert!(read_head(&mut req.as_bytes()).is_ok());
    }

    #[test]
    fn truncated_head() {
        assert!(matches!(
            read_head(&mut "".as_bytes()),
            Err(HeadError::Closed(false))
        ));
        assert!(matches!(
            read_head(&mut "GET /temps HTTP/1.1\r\n".as_bytes()),
            Err(HeadError::Closed(true))
        ));
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abd", b"abc"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(!constant_time_eq(b"abc\0", b"abc"));
        assert!(!constant_time_eq(b"", b"abc"));
    }

    #[test]
    fn responses_close_the_connection() {
        let r = String::from_utf8(error_response(Status::Unauthorized)).unwrap();
        assert!(r.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(r.contains("\r\nWWW-Authenticate: Bearer\r\n"));
        assert!(r.contains("\r\nConnection: close\r\n"));
        assert!(r.ends_with("\r\n\r\nUnauthorized\n"));
        let r = String::from_utf8(response(Status::Ok, "application/json", "{}")).unwrap();
        assert!(r.contains("\r\nContent-Length: 2\r\n"));
        let r = String::from_utf8(error_response(Status::MethodNotAllowed)).unwrap();
        assert!(r.contains("\r\nAllow: GET\r\n"));
    }
}
