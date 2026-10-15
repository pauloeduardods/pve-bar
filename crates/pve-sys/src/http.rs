// SPDX-License-Identifier: GPL-3.0-or-later
//! The HTTP clients: the Proxmox API (read-only GETs) and pve-temp-agent.
//! One reqwest client each, kept for the life of the process, so the TCP and
//! TLS connection is reused between polls.

use std::time::Duration;

use pve_core::config::Server;
use pve_core::resources::{self, Resource};
use pve_core::temp::{self, TempReport};
use reqwest::header::{AUTHORIZATION, HeaderValue};

use crate::tls::{self, Seen, Trust};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Keep the idle connection a bit longer than the polling interval.
const IDLE_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// Unreachable, timed out, refused, DNS failure, 5xx.
    Offline(String),
    /// 401 or 403: wrong token, expired, or missing privileges.
    Unauthorized(String),
    /// The certificate did not match the pinned fingerprint or the CAs.
    Tls(String),
    /// The server answered something pve-bar cannot read.
    Protocol(String),
}

impl FetchError {
    pub fn message(&self) -> &str {
        match self {
            Self::Offline(m) | Self::Unauthorized(m) | Self::Tls(m) | Self::Protocol(m) => m,
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

fn build_client(trust: Trust) -> Result<(reqwest::Client, Seen), String> {
    let (tls, seen) = tls::client_config(trust)?;
    let client = reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .pool_idle_timeout(IDLE_TIMEOUT)
        .pool_max_idle_per_host(1)
        .http1_only()
        .user_agent(concat!("pve-bar/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("could not create the HTTP client: {e}"))?;
    Ok((client, seen))
}

fn classify(e: &reqwest::Error, what: &str) -> FetchError {
    if let Some(tls) = tls::find_tls_error(Some(e)) {
        return FetchError::Tls(format!("TLS error talking to {what}: {tls}"));
    }
    let mut text = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        text = format!("{text}: {s}");
        source = s.source();
    }
    if e.is_timeout() {
        FetchError::Offline(format!("{what} did not answer in time"))
    } else if e.is_connect() {
        FetchError::Offline(format!("cannot connect to {what}: {text}"))
    } else {
        FetchError::Offline(format!("request to {what} failed: {text}"))
    }
}

async fn get_body(
    client: &reqwest::Client,
    url: &str,
    auth: &HeaderValue,
    what: &str,
) -> Result<Vec<u8>, FetchError> {
    let response = client
        .get(url)
        .header(AUTHORIZATION, auth.clone())
        .send()
        .await
        .map_err(|e| classify(&e, what))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(FetchError::Unauthorized(format!(
            "{what} refused the token ({status})"
        )));
    }
    if status.is_server_error() {
        return Err(FetchError::Offline(format!("{what} answered {status}")));
    }
    if !status.is_success() {
        return Err(FetchError::Protocol(format!("{what} answered {status}")));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| classify(&e, what))
}

fn sensitive(value: &str) -> Result<HeaderValue, String> {
    let mut h = HeaderValue::from_str(value)
        .map_err(|_| "the token contains characters not allowed in an HTTP header".to_owned())?;
    h.set_sensitive(true);
    Ok(h)
}

pub struct ProxmoxClient {
    http: reqwest::Client,
    base: String,
    auth: HeaderValue,
    seen: Seen,
}

impl ProxmoxClient {
    pub fn new(server: &Server, secret: &str) -> Result<Self, String> {
        let trust = if server.fingerprint.is_empty() {
            Trust::PublicCa
        } else {
            Trust::Pinned(server.fingerprint.clone())
        };
        Self::with_trust(server, secret, trust)
    }

    pub fn with_trust(server: &Server, secret: &str, trust: Trust) -> Result<Self, String> {
        let (http, seen) = build_client(trust)?;
        Ok(Self {
            http,
            base: format!("{}/api2/json", server.url),
            auth: sensitive(&format!(
                "PVEAPIToken={}={}",
                server.token_id,
                secret.trim()
            ))?,
            seen,
        })
    }

    /// The fingerprint of the certificate the server presented, once a
    /// handshake was attempted.
    pub fn seen_fingerprint(&self) -> Option<String> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// GET `/api2/json{path}`; read-only by construction (no other verb).
    pub async fn get(&self, path: &str) -> Result<Vec<u8>, FetchError> {
        get_body(
            &self.http,
            &format!("{}{path}", self.base),
            &self.auth,
            "Proxmox",
        )
        .await
    }

    pub async fn resources(&self) -> Result<Vec<Resource>, FetchError> {
        let body = self.get("/cluster/resources").await?;
        resources::parse(&body).map_err(FetchError::Protocol)
    }
}

pub struct TempClient {
    http: reqwest::Client,
    url: String,
    auth: HeaderValue,
}

impl TempClient {
    pub fn new(base_url: &str, token: &str) -> Result<Self, String> {
        let (http, _) = build_client(Trust::PublicCa)?;
        Ok(Self {
            http,
            url: format!("{}/temps", base_url.trim_end_matches('/')),
            auth: sensitive(&format!("Bearer {}", token.trim()))?,
        })
    }

    pub async fn report(&self) -> Result<TempReport, FetchError> {
        let body = get_body(&self.http, &self.url, &self.auth, "the temperature agent").await?;
        temp::parse(&body).map_err(FetchError::Protocol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A one-shot HTTP server on 127.0.0.1 that answers `reply` and hands
    /// back the request it received.
    async fn serve_once(reply: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let n = sock.read(&mut buf).await.unwrap();
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (format!("http://{addr}"), handle)
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn temp_client_sends_the_bearer_token_and_parses() {
        rt().block_on(async {
            let body = r#"{"schema":1,"node":"pve","sensors":[{"chip":"coretemp","label":"Package id 0","celsius":50.0}]}"#;
            let reply: &'static str = Box::leak(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .into_boxed_str(),
            );
            let (url, server) = serve_once(reply).await;
            let client = TempClient::new(&url, "s3cret\n").unwrap();
            let report = client.report().await.unwrap();
            assert_eq!(report.node, "pve");
            let request = server.await.unwrap();
            assert!(request.starts_with("GET /temps HTTP/1.1"), "{request}");
            assert!(request.to_ascii_lowercase().contains("authorization: bearer s3cret\r\n"));
        });
    }

    #[test]
    fn status_codes_are_classified() {
        rt().block_on(async {
            for (reply, want) in [
                (
                    "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    "unauth",
                ),
                (
                    "HTTP/1.1 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    "offline",
                ),
                (
                    "HTTP/1.1 404 Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    "protocol",
                ),
                (
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    "protocol",
                ),
            ] {
                let (url, _server) = serve_once(reply).await;
                let err = TempClient::new(&url, "t")
                    .unwrap()
                    .report()
                    .await
                    .unwrap_err();
                let got = match err {
                    FetchError::Unauthorized(_) => "unauth",
                    FetchError::Offline(_) => "offline",
                    FetchError::Protocol(_) => "protocol",
                    FetchError::Tls(_) => "tls",
                };
                assert_eq!(got, want, "{reply:?}: {err}");
            }
        });
    }

    #[test]
    fn connection_refused_is_offline() {
        rt().block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            drop(listener);
            let err = TempClient::new(&url, "t")
                .unwrap()
                .report()
                .await
                .unwrap_err();
            assert!(matches!(err, FetchError::Offline(_)), "{err:?}");
        });
    }

    #[test]
    fn proxmox_auth_header() {
        let config = Server {
            id: "home".into(),
            url: "https://pve.lan:8006".into(),
            token_id: "monitor@pve!pve-bar".into(),
            ..Server::default()
        };
        let c = ProxmoxClient::new(&config, " 1234-abcd \n").unwrap();
        assert_eq!(c.base, "https://pve.lan:8006/api2/json");
        assert_eq!(
            c.auth.to_str().unwrap(),
            "PVEAPIToken=monitor@pve!pve-bar=1234-abcd"
        );
        assert!(c.auth.is_sensitive());
        assert!(ProxmoxClient::new(&config, "bad\u{7f}").is_err());
    }
}
