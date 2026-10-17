// SPDX-License-Identifier: GPL-3.0-or-later
//! The Proxmox client against a local HTTPS server with a self-signed
//! certificate, as every fresh Proxmox install has.

use std::sync::Arc;

use pve_core::config::Server;
use pve_sys::tls::Trust;
use pve_sys::{FetchError, ProxmoxClient};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

/// Serves `/api2/json/version` over TLS with a fresh self-signed certificate,
/// answering every connection; returns the URL and the certificate's DER.
async fn self_signed_server() -> (String, Vec<u8>) {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let der = cert.cert.der().to_vec();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.key_pair.serialize_der()));
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(der.clone())], key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                // A client that rejects the certificate fails the handshake here.
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let mut buf = vec![0; 4096];
                let _ = tls.read(&mut buf).await;
                let body = r#"{"data":{"version":"9.0.0"}}"#;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(reply.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    (url, der)
}

fn server(url: &str) -> Server {
    Server {
        id: "test".into(),
        url: url.into(),
        token_id: "monitor@pve!pve-bar".into(),
        ..Server::default()
    }
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn a_self_signed_certificate_is_a_tls_error_not_offline() {
    rt().block_on(async {
        let (url, _) = self_signed_server().await;
        let client = ProxmoxClient::with_trust(&server(&url), "x", Trust::PublicCa).unwrap();
        let err = client.get("/version").await.unwrap_err();
        assert!(matches!(err, FetchError::Tls(_)), "{err:?}");
    });
}

#[test]
fn capture_reads_the_fingerprint_and_pinning_it_works() {
    rt().block_on(async {
        let (url, der) = self_signed_server().await;
        let probe = ProxmoxClient::with_trust(&server(&url), "x", Trust::Capture).unwrap();
        let err = probe.get("/version").await.unwrap_err();
        assert!(matches!(err, FetchError::Tls(_)), "{err:?}");
        let fp = probe.seen_fingerprint().expect("fingerprint seen");
        assert_eq!(fp, pve_sys::tls::fingerprint(&der));

        let pinned = ProxmoxClient::with_trust(&server(&url), "x", Trust::Pinned(fp)).unwrap();
        let body = pinned.get("/version").await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("9.0.0"));
    });
}

#[test]
fn a_different_pinned_fingerprint_is_refused() {
    rt().block_on(async {
        let (url, _) = self_signed_server().await;
        let wrong = "AA:".repeat(31) + "AA";
        let client = ProxmoxClient::with_trust(&server(&url), "x", Trust::Pinned(wrong)).unwrap();
        let err = client.get("/version").await.unwrap_err();
        assert!(matches!(err, FetchError::Tls(_)), "{err:?}");
    });
}
