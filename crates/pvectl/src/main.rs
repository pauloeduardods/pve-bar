// SPDX-License-Identifier: GPL-3.0-or-later
//! pvectl: pve-bar from the terminal. `status` and `doctor` talk to Proxmox
//! directly with the same config and keyring as pved, so they work without
//! pved or the extension. `setup` adds or edits a server.

mod doctor;
mod setup;
mod status;
mod term;

use std::path::PathBuf;
use std::process::ExitCode;

use pve_core::config::{Config, Server};
use pve_sys::paths;
use pve_sys::secret::{self, Key};
use pve_sys::{ProxmoxClient, TempClient};
use zbus::Connection;

const USAGE: &str = "\
Usage: pvectl <command> [options]

Commands:
  status [--json] [NAME]   show every server (or just NAME): nodes and guests
  status --watch [NAME]    the same every 10 s, with graphs of the last minutes
  doctor [NAME]            check the setup and suggest fixes
  setup NAME               add or edit the server NAME (interactive)
  remove NAME              forget the server NAME and its secrets

Options:
  --config PATH            use PATH instead of ~/.config/pve-bar/pved.conf
  -h, --help               show this help
  -V, --version            show the version

Servers live in ~/.config/pve-bar/pved.conf; their tokens in the GNOME Keyring.";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Status {
        json: bool,
        watch: bool,
        server: Option<String>,
    },
    Doctor {
        server: Option<String>,
    },
    Setup {
        server: String,
    },
    Remove {
        server: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    command: Command,
    config: PathBuf,
}

enum Parsed {
    Run(Options),
    Print(String),
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let mut config = None;
    let mut json = false;
    let mut watch = false;
    let mut words = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                config = Some(PathBuf::from(args.next().ok_or("--config needs a value")?))
            }
            "--json" => json = true,
            "--watch" => watch = true,
            "-h" | "--help" => return Ok(Parsed::Print(format!("{USAGE}\n"))),
            "-V" | "--version" => {
                return Ok(Parsed::Print(format!(
                    "pvectl {}\n",
                    env!("CARGO_PKG_VERSION")
                )));
            }
            s if s.starts_with('-') => return Err(format!("unknown option: {s}")),
            _ => words.push(arg),
        }
    }
    let mut words = words.into_iter();
    let verb = words.next().ok_or("missing command")?;
    let name = words.next();
    if let Some(extra) = words.next() {
        return Err(format!("unexpected argument: {extra}"));
    }
    if (json || watch) && verb != "status" {
        return Err("--json and --watch only apply to status".to_owned());
    }
    if json && watch {
        return Err("--json and --watch do not go together".to_owned());
    }
    let need_name = |name: Option<String>| name.ok_or(format!("{verb} needs a server NAME"));
    let command = match verb.as_str() {
        "status" => Command::Status {
            json,
            watch,
            server: name,
        },
        "doctor" => Command::Doctor { server: name },
        "setup" => Command::Setup {
            server: need_name(name)?,
        },
        "remove" => Command::Remove {
            server: need_name(name)?,
        },
        other => return Err(format!("unknown command: {other}")),
    };
    Ok(Parsed::Run(Options {
        command,
        config: config.unwrap_or_else(paths::config_path),
    }))
}

/// The configured servers, or just `only`.
pub fn select<'a>(config: &'a Config, only: Option<&str>) -> Result<Vec<&'a Server>, String> {
    match only {
        Some(name) => config
            .server(name)
            .map(|s| vec![s])
            .ok_or_else(|| format!("no server named {name:?}; see: pvectl status")),
        None => Ok(config.servers.iter().collect()),
    }
}

/// The Proxmox client (and temperature client, if configured) for `server`,
/// with their tokens from the keyring.
pub async fn clients(
    conn: &Connection,
    server: &Server,
) -> Result<(ProxmoxClient, Option<Result<TempClient, String>>), String> {
    let token = secret::lookup(conn, &Key::ApiToken { server: &server.id }, true)
        .await?
        .ok_or_else(|| {
            format!(
                "no API token for {} in the GNOME Keyring; run: pvectl setup {}",
                server.id, server.id
            )
        })?;
    let api = ProxmoxClient::new(server, &token)?;
    let temp = if server.temp_url.is_empty() {
        None
    } else {
        Some(
            match secret::lookup(conn, &Key::TempAgent { server: &server.id }, true).await {
                Ok(Some(t)) => TempClient::new(&server.temp_url, &t),
                Ok(None) => Err(format!(
                    "no temperature agent token in the GNOME Keyring; run: pvectl setup {}",
                    server.id
                )),
                Err(e) => Err(e),
            },
        )
    };
    Ok((api, temp))
}

pub fn load_config(path: &std::path::Path) -> Result<Config, String> {
    paths::load(path)?.ok_or_else(|| {
        format!(
            "no {} yet; add a server with: pvectl setup NAME",
            path.display()
        )
    })
}

/// Asks a running pved to re-read the config; harmless when it is not running.
pub fn reload_pved() {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "try-reload-or-restart", "pved.service"])
        .stderr(std::process::Stdio::null())
        .status();
}

async fn remove(config_path: &std::path::Path, name: &str) -> Result<(), String> {
    let mut config = load_config(config_path)?;
    if !config.remove(name) {
        return Err(format!("no server named {name:?}"));
    }
    paths::save(config_path, &config)?;
    if let Ok(conn) = Connection::session().await {
        for key in [
            Key::ApiToken { server: name },
            Key::TempAgent { server: name },
        ] {
            if let Err(e) = secret::delete(&conn, &key).await {
                eprintln!("warning: {e}");
            }
        }
    }
    reload_pved();
    println!("Removed {name}.");
    Ok(())
}

async fn run(options: Options) -> Result<ExitCode, String> {
    match options.command {
        Command::Status {
            json,
            watch,
            server,
        } => status::run(&options.config, server.as_deref(), json, watch).await,
        Command::Doctor { server } => doctor::run(&options.config, server.as_deref()).await,
        Command::Setup { server } => setup::run(&options.config, &server).await,
        Command::Remove { server } => remove(&options.config, &server)
            .await
            .map(|()| ExitCode::SUCCESS),
    }
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Print(text)) => {
            print!("{text}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("pvectl: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("pvectl: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(options)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("pvectl: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Command, String> {
        match parse_args(args.iter().map(|s| (*s).to_owned()))? {
            Parsed::Run(o) => Ok(o.command),
            Parsed::Print(_) => Err("printed".into()),
        }
    }

    #[test]
    fn commands() {
        assert_eq!(
            parse(&["status"]),
            Ok(Command::Status {
                json: false,
                watch: false,
                server: None
            })
        );
        assert_eq!(
            parse(&["status", "--json", "home"]),
            Ok(Command::Status {
                json: true,
                watch: false,
                server: Some("home".into())
            })
        );
        assert_eq!(
            parse(&["status", "--watch"]),
            Ok(Command::Status {
                json: false,
                watch: true,
                server: None
            })
        );
        assert_eq!(parse(&["doctor"]), Ok(Command::Doctor { server: None }));
        assert_eq!(
            parse(&["setup", "lab"]),
            Ok(Command::Setup {
                server: "lab".into()
            })
        );
        assert_eq!(
            parse(&["remove", "lab"]),
            Ok(Command::Remove {
                server: "lab".into()
            })
        );
    }

    #[test]
    fn bad_arguments() {
        assert!(parse(&[]).is_err());
        assert!(parse(&["setup"]).is_err());
        assert!(parse(&["doctor", "--json"]).is_err());
        assert!(parse(&["doctor", "--watch"]).is_err());
        assert!(parse(&["status", "--watch", "--json"]).is_err());
        assert!(parse(&["status", "a", "b"]).is_err());
        assert!(parse(&["frobnicate"]).is_err());
        assert!(parse(&["status", "--bogus"]).is_err());
        assert_eq!(parse(&["--help"]), Err("printed".into()));
    }

    #[test]
    fn select_servers() {
        let config = Config::parse(
            "[a]\nurl = https://a:8006\ntoken_id = x@pve!y\n[b]\nurl = https://b:8006\ntoken_id = x@pve!y\n",
        )
        .unwrap();
        assert_eq!(select(&config, None).unwrap().len(), 2);
        assert_eq!(select(&config, Some("b")).unwrap()[0].id, "b");
        assert!(select(&config, Some("c")).is_err());
    }
}
