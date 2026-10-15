// SPDX-License-Identifier: GPL-3.0-or-later
//! Prompts for `pvectl setup`.

use std::io::{self, BufRead, IsTerminal, Write};
use std::process::{Command, Stdio};

fn read_line() -> Result<String, String> {
    let mut line = String::new();
    let n = io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| format!("cannot read the answer: {e}"))?;
    if n == 0 {
        return Err("input ended".to_owned());
    }
    Ok(line.trim().to_owned())
}

/// Asks `question`; an empty answer gives `default`.
pub fn ask(question: &str, default: &str) -> Result<String, String> {
    if default.is_empty() {
        print!("{question}: ");
    } else {
        print!("{question} [{default}]: ");
    }
    let _ = io::stdout().flush();
    let answer = read_line()?;
    Ok(if answer.is_empty() {
        default.to_owned()
    } else {
        answer
    })
}

pub fn confirm(question: &str, default_yes: bool) -> Result<bool, String> {
    let hint = if default_yes { "Y/n" } else { "y/N" };
    let answer = ask(&format!("{question} ({hint})"), "")?;
    Ok(match answer.to_ascii_lowercase().as_str() {
        "" => default_yes,
        "y" | "yes" | "s" | "sim" => true,
        _ => false,
    })
}

fn stty(arg: &str) {
    let _ = Command::new("stty")
        .arg(arg)
        .stdin(Stdio::inherit())
        .stderr(Stdio::null())
        .status();
}

/// Asks for a secret without echoing it (when stdin is a terminal). An empty
/// answer returns "".
pub fn ask_secret(question: &str) -> Result<String, String> {
    print!("{question}: ");
    let _ = io::stdout().flush();
    let tty = io::stdin().is_terminal();
    if tty {
        stty("-echo");
    }
    let answer = read_line();
    if tty {
        stty("echo");
        println!();
    }
    answer
}
