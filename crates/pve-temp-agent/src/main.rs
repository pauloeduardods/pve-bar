// SPDX-License-Identifier: GPL-3.0-or-later
//! pve-temp-agent: runs on the Proxmox host and serves the hwmon
//! temperatures as JSON on `GET /temps`, behind a bearer token. std only.

mod http;
mod hwmon;
mod json;
mod server;

use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::server::Context;

const USAGE: &str = "\
Usage: pve-temp-agent [--listen ADDR:PORT] [--token-file PATH] [--sysfs-root DIR]

Serves the host's hwmon temperatures on GET /temps (HTTP, bearer token).

  --listen ADDR:PORT  address to bind (default 0.0.0.0:9101)
  --token-file PATH   file holding the token, at least 32 characters
                      (default $CREDENTIALS_DIRECTORY/token, i.e. systemd
                      LoadCredential=token:...)
  --sysfs-root DIR    read sys/ and proc/ under DIR (tests only; default /)
  -h, --help          show this help
  -V, --version       show the version";

const DEFAULT_LISTEN: &str = "0.0.0.0:9101";
const MIN_TOKEN_LEN: usize = 32;
const MAX_TOKEN_FILE: u64 = 4096;

#[derive(Debug, PartialEq, Eq)]
struct Options {
    listen: SocketAddr,
    token_file: Option<PathBuf>,
    sysfs_root: PathBuf,
}

enum Parsed {
    Run(Options),
    Print(String),
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let mut options = Options {
        listen: DEFAULT_LISTEN.parse().expect("valid default address"),
        token_file: None,
        sysfs_root: PathBuf::from("/"),
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--listen" => {
                let text = value("--listen")?;
                options.listen = text
                    .parse()
                    .map_err(|_| format!("--listen needs ADDR:PORT, got {text:?}"))?;
            }
            "--token-file" => options.token_file = Some(value("--token-file")?.into()),
            "--sysfs-root" => options.sysfs_root = value("--sysfs-root")?.into(),
            "-h" | "--help" => return Ok(Parsed::Print(format!("{USAGE}\n"))),
            "-V" | "--version" => {
                return Ok(Parsed::Print(format!(
                    "pve-temp-agent {}\n",
                    env!("CARGO_PKG_VERSION")
                )));
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Parsed::Run(options))
}

/// `--token-file`, else `$CREDENTIALS_DIRECTORY/token`.
fn token_path(
    given: Option<PathBuf>,
    credentials_dir: Option<OsString>,
) -> Result<PathBuf, String> {
    match (given, credentials_dir) {
        (Some(path), _) => Ok(path),
        (None, Some(dir)) if !dir.is_empty() => Ok(Path::new(&dir).join("token")),
        _ => Err("no token: pass --token-file, or run under systemd with \
                  LoadCredential=token:/etc/pve-temp-agent/token"
            .to_owned()),
    }
}

/// The trimmed token. It goes in an HTTP header, so it must be visible ASCII.
fn parse_token(contents: &[u8]) -> Result<Vec<u8>, String> {
    let token = contents.trim_ascii();
    if token.len() < MIN_TOKEN_LEN {
        return Err(format!(
            "the token must be at least {MIN_TOKEN_LEN} characters, it has {}",
            token.len()
        ));
    }
    if !token.iter().all(u8::is_ascii_graphic) {
        return Err("the token must be printable ASCII without spaces".to_owned());
    }
    Ok(token.to_vec())
}

fn load_token(path: &Path) -> Result<Vec<u8>, String> {
    let mut contents = Vec::new();
    File::open(path)
        .and_then(|f| f.take(MAX_TOKEN_FILE).read_to_end(&mut contents))
        .map_err(|e| format!("cannot read the token file {}: {e}", path.display()))?;
    parse_token(&contents).map_err(|e| format!("{}: {e}", path.display()))
}

fn run(options: Options) -> Result<(), String> {
    let path = token_path(
        options.token_file,
        std::env::var_os("CREDENTIALS_DIRECTORY"),
    )?;
    let token = load_token(&path)?;
    let listener = TcpListener::bind(options.listen)
        .map_err(|e| format!("cannot listen on {}: {e}", options.listen))?;
    let ctx = Context {
        token,
        sysfs_root: options.sysfs_root,
    };
    let node = hwmon::hostname(&ctx.sysfs_root).unwrap_or_else(|| "?".to_owned());
    eprintln!(
        "pve-temp-agent {}: listening on {} for node {node}, {} sensors",
        env!("CARGO_PKG_VERSION"),
        options.listen,
        hwmon::scan(&ctx.sysfs_root).len()
    );
    server::serve(&listener, &ctx)
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Print(text)) => {
            print!("{text}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("pve-temp-agent: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("pve-temp-agent: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hwmon::fixture::Fixture;

    fn parse(args: &[&str]) -> Result<Parsed, String> {
        parse_args(args.iter().map(|s| (*s).to_owned()))
    }

    #[test]
    fn defaults_are_production_values() {
        let Ok(Parsed::Run(o)) = parse(&[]) else {
            panic!()
        };
        assert_eq!(
            o,
            Options {
                listen: "0.0.0.0:9101".parse().unwrap(),
                token_file: None,
                sysfs_root: PathBuf::from("/"),
            }
        );
    }

    #[test]
    fn options() {
        let Ok(Parsed::Run(o)) = parse(&[
            "--listen",
            "[::1]:9200",
            "--token-file",
            "/tmp/t",
            "--sysfs-root",
            "/tmp/x",
        ]) else {
            panic!()
        };
        assert_eq!(o.listen, "[::1]:9200".parse().unwrap());
        assert_eq!(o.token_file, Some(PathBuf::from("/tmp/t")));
        assert_eq!(o.sysfs_root, PathBuf::from("/tmp/x"));
        assert!(matches!(parse(&["--help"]), Ok(Parsed::Print(_))));
        assert!(matches!(parse(&["-V"]), Ok(Parsed::Print(_))));
    }

    #[test]
    fn bad_arguments() {
        assert!(parse(&["--listen", "pve.lan:9101"]).is_err());
        assert!(parse(&["--listen", "0.0.0.0"]).is_err());
        assert!(parse(&["--listen"]).is_err());
        assert!(parse(&["--token-file"]).is_err());
        assert!(parse(&["--frobnicate"]).is_err());
    }

    #[test]
    fn token_location() {
        assert_eq!(
            token_path(Some("/a".into()), Some("/run/creds".into())),
            Ok(PathBuf::from("/a"))
        );
        assert_eq!(
            token_path(None, Some("/run/creds".into())),
            Ok(PathBuf::from("/run/creds/token"))
        );
        assert!(token_path(None, None).is_err());
        assert!(token_path(None, Some("".into())).is_err());
    }

    #[test]
    fn token_rules() {
        let good = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_token(format!("  {good}\n").as_bytes()),
            Ok(good.into())
        );
        assert!(parse_token(&good.as_bytes()[1..]).is_err(), "too short");
        assert!(parse_token(b"").is_err());
        assert!(parse_token(format!("{good} {good}").as_bytes()).is_err());
        assert!(parse_token(format!("{good}\u{e9}").as_bytes()).is_err());
    }

    #[test]
    fn token_file() {
        let f = Fixture::new("token");
        f.write(
            "token",
            "0123456789abcdef0123456789abcdef0123456789abcdef\n",
        );
        f.write("short", "abc\n");
        assert_eq!(load_token(&f.path().join("token")).unwrap().len(), 48);
        assert!(load_token(&f.path().join("short")).is_err());
        assert!(load_token(&f.path().join("missing")).is_err());
    }
}
