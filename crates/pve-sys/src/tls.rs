// SPDX-License-Identifier: GPL-3.0-or-later
//! TLS for the Proxmox API.
//!
//! Proxmox ships a self-signed certificate, so pve-bar pins the SHA-256
//! fingerprint of the server certificate (the one the Proxmox UI shows under
//! Certificates). Pinning replaces the CA and host name checks: only that
//! exact certificate is accepted. Without a fingerprint the system-independent
//! webpki roots are used, for servers with a public certificate.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// `AB:CD:...` for a DER certificate.
pub fn fingerprint(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    let mut out = String::with_capacity(95);
    for (i, b) in digest.as_ref().iter().enumerate() {
        if i > 0 {
            out.push(':');
        }
        out.push_str(&format!("{b:02X}"));
    }
    out
}

/// What the verifier saw, for `pvectl setup` and `pvectl doctor`.
pub type Seen = Arc<Mutex<Option<String>>>;

#[derive(Debug)]
struct Pinned {
    /// None: accept nothing, only record (used to read the fingerprint).
    expected: Option<String>,
    seen: Seen,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got = fingerprint(end_entity.as_ref());
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = Some(got.clone());
        match &self.expected {
            Some(expected) if *expected == got => Ok(ServerCertVerified::assertion()),
            _ => Err(rustls::Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// How the server certificate is checked.
pub enum Trust {
    /// The webpki roots and the host name.
    PublicCa,
    /// Exactly this fingerprint (`AB:CD:...`).
    Pinned(String),
    /// Reject every certificate but record its fingerprint.
    Capture,
}

/// A rustls config for `trust`, plus where the seen fingerprint lands.
pub fn client_config(trust: Trust) -> Result<(ClientConfig, Seen), String> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?;
    let seen = Seen::default();
    let mut config = match trust {
        Trust::PublicCa => {
            let roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            builder.with_root_certificates(roots).with_no_client_auth()
        }
        Trust::Pinned(fp) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinned {
                expected: Some(fp),
                seen: Arc::clone(&seen),
                algorithms: provider.signature_verification_algorithms,
            }))
            .with_no_client_auth(),
        Trust::Capture => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinned {
                expected: None,
                seen: Arc::clone(&seen),
                algorithms: provider.signature_verification_algorithms,
            }))
            .with_no_client_auth(),
    };
    // HTTP/1.1 with keep-alive: one request every 10 s needs nothing more.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((config, seen))
}

/// The first rustls error in an error's source chain, looking inside
/// `io::Error`s too (hyper wraps the handshake failure in one).
pub fn find_tls_error<'a>(
    mut e: Option<&'a (dyn std::error::Error + 'static)>,
) -> Option<&'a rustls::Error> {
    while let Some(err) = e {
        if let Some(tls) = err.downcast_ref::<rustls::Error>() {
            return Some(tls);
        }
        if let Some(io) = err.downcast_ref::<std::io::Error>()
            && let Some(tls) = io.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>())
        {
            return Some(tls);
        }
        e = err.source();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_format() {
        let fp = fingerprint(b"hello");
        assert_eq!(fp.len(), 95);
        assert!(fp.starts_with("2C:F2:4D:BA"));
        assert_eq!(pve_core::config::normalize_fingerprint(&fp), Some(fp));
    }

    #[test]
    fn configs_build() {
        for trust in [Trust::PublicCa, Trust::Pinned("AA".into()), Trust::Capture] {
            let (c, _) = client_config(trust).unwrap();
            assert_eq!(c.alpn_protocols, [b"http/1.1".to_vec()]);
        }
    }

    #[test]
    fn pinned_verifier_accepts_only_its_fingerprint() {
        let cert = CertificateDer::from(b"not really a cert".to_vec());
        let name = ServerName::try_from("pve.lan").unwrap();
        let mk = |expected: Option<String>| Pinned {
            expected,
            seen: Seen::default(),
            algorithms: provider().signature_verification_algorithms,
        };
        let fp = fingerprint(cert.as_ref());
        let ok = mk(Some(fp.clone()));
        assert!(
            ok.verify_server_cert(&cert, &[], &name, &[], UnixTime::now())
                .is_ok()
        );
        let bad = mk(Some("00".into()));
        assert!(
            bad.verify_server_cert(&cert, &[], &name, &[], UnixTime::now())
                .is_err()
        );
        assert_eq!(bad.seen.lock().unwrap().as_deref(), Some(fp.as_str()));
        let capture = mk(None);
        assert!(
            capture
                .verify_server_cert(&cert, &[], &name, &[], UnixTime::now())
                .is_err()
        );
    }
}
