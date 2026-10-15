// SPDX-License-Identifier: GPL-3.0-or-later
//! The token secrets in the GNOME Keyring, through the freedesktop Secret
//! Service API on the session bus. Spoken directly over zbus (no libsecret):
//! a "plain" session is enough because the bus is local to the user.

use std::collections::HashMap;

use zbus::Connection;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

pub const APPLICATION: &str = "pve-bar";

/// (session, parameters, value, content type)
type Secret = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Service",
    default_service = "org.freedesktop.secrets",
    default_path = "/org/freedesktop/secrets"
)]
trait Service {
    fn open_session(
        &self,
        algorithm: &str,
        input: &Value<'_>,
    ) -> zbus::Result<(OwnedValue, OwnedObjectPath)>;

    fn search_items(
        &self,
        attributes: HashMap<&str, &str>,
    ) -> zbus::Result<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>)>;

    fn unlock(
        &self,
        objects: &[ObjectPath<'_>],
    ) -> zbus::Result<(Vec<OwnedObjectPath>, OwnedObjectPath)>;

    fn get_secrets(
        &self,
        items: &[ObjectPath<'_>],
        session: &ObjectPath<'_>,
    ) -> zbus::Result<HashMap<OwnedObjectPath, Secret>>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Collection",
    default_service = "org.freedesktop.secrets"
)]
trait Collection {
    fn create_item(
        &self,
        properties: HashMap<&str, Value<'_>>,
        secret: &(ObjectPath<'_>, &[u8], &[u8], &str),
        replace: bool,
    ) -> zbus::Result<(OwnedObjectPath, OwnedObjectPath)>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Prompt",
    default_service = "org.freedesktop.secrets"
)]
trait Prompt {
    fn prompt(&self, window_id: &str) -> zbus::Result<()>;

    #[zbus(signal)]
    fn completed(&self, dismissed: bool, result: Value<'_>) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Item",
    default_service = "org.freedesktop.secrets"
)]
trait Item {
    fn delete(&self) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Session",
    default_service = "org.freedesktop.secrets"
)]
trait Session {
    fn close(&self) -> zbus::Result<()>;
}

/// Which secret of which server (the `[name]` in pved.conf): its Proxmox
/// API token or its temperature agent token. The server name, not the URL or
/// token id, is the key, since two servers may share a token id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key<'a> {
    ApiToken { server: &'a str },
    TempAgent { server: &'a str },
}

impl Key<'_> {
    fn attributes(&self) -> HashMap<&str, &str> {
        let mut a = HashMap::from([("application", APPLICATION)]);
        let (kind, server) = match self {
            Key::ApiToken { server } => ("api-token", server),
            Key::TempAgent { server } => ("temp-agent", server),
        };
        a.insert("kind", kind);
        a.insert("server", server);
        a
    }

    fn label(&self) -> String {
        match self {
            Key::ApiToken { server } => format!("pve-bar: Proxmox API token ({server})"),
            Key::TempAgent { server } => format!("pve-bar: temperature agent token ({server})"),
        }
    }
}

fn err(context: &str, e: zbus::Error) -> String {
    format!("GNOME Keyring: {context}: {e}")
}

async fn open_session<'a>(
    conn: &Connection,
    service: &ServiceProxy<'a>,
) -> Result<SessionProxy<'a>, String> {
    let (_, path) = service
        .open_session("plain", &Value::from(""))
        .await
        .map_err(|e| err("cannot open a session (is gnome-keyring running?)", e))?;
    SessionProxy::builder(conn)
        .path(path)
        .map_err(|e| err("bad session path", e))?
        .build()
        .await
        .map_err(|e| err("session", e))
}

/// Runs a Secret Service prompt (unlock dialog) and waits for it.
async fn run_prompt(conn: &Connection, path: &OwnedObjectPath) -> Result<(), String> {
    use futures_util::StreamExt as _;
    if path.as_str() == "/" {
        return Ok(());
    }
    let prompt = PromptProxy::builder(conn)
        .path(path.as_ref())
        .map_err(|e| err("bad prompt path", e))?
        .build()
        .await
        .map_err(|e| err("prompt", e))?;
    let mut completed = prompt
        .receive_completed()
        .await
        .map_err(|e| err("prompt", e))?;
    prompt.prompt("").await.map_err(|e| err("prompt", e))?;
    match completed.next().await {
        Some(signal) => {
            let args = signal.args().map_err(|e| err("prompt reply", e))?;
            if args.dismissed {
                Err("GNOME Keyring: the unlock prompt was dismissed".to_owned())
            } else {
                Ok(())
            }
        }
        None => Err("GNOME Keyring: the prompt went away".to_owned()),
    }
}

/// Reads a secret. Ok(None) when there is none. With `interactive`, a locked
/// keyring shows the unlock prompt; without it, a locked keyring is an error.
pub async fn lookup(
    conn: &Connection,
    key: &Key<'_>,
    interactive: bool,
) -> Result<Option<String>, String> {
    let service = ServiceProxy::new(conn)
        .await
        .map_err(|e| err("not available", e))?;
    let (unlocked, locked) = service
        .search_items(key.attributes())
        .await
        .map_err(|e| err("search failed", e))?;
    let item = match (unlocked.into_iter().next(), locked.into_iter().next()) {
        (Some(item), _) => item,
        (None, None) => return Ok(None),
        (None, Some(item)) => {
            if !interactive {
                return Err("GNOME Keyring is locked; log in again or unlock it".to_owned());
            }
            let (_, prompt) = service
                .unlock(&[item.as_ref()])
                .await
                .map_err(|e| err("unlock failed", e))?;
            run_prompt(conn, &prompt).await?;
            item
        }
    };
    let session = open_session(conn, &service).await?;
    let result = service
        .get_secrets(&[item.as_ref()], &session.inner().path().clone())
        .await
        .map_err(|e| err("cannot read the secret", e));
    let _ = session.close().await;
    let mut secrets = result?;
    let Some((_, _, value, _)) = secrets.remove(&item) else {
        return Ok(None);
    };
    String::from_utf8(value)
        .map(Some)
        .map_err(|_| "GNOME Keyring: the stored secret is not text".to_owned())
}

/// Stores (or replaces) a secret in the default collection ("login").
pub async fn store(conn: &Connection, key: &Key<'_>, secret: &str) -> Result<(), String> {
    let service = ServiceProxy::new(conn)
        .await
        .map_err(|e| err("not available", e))?;
    let session = open_session(conn, &service).await?;
    let collection = CollectionProxy::builder(conn)
        .path("/org/freedesktop/secrets/aliases/default")
        .map_err(|e| err("bad collection path", e))?
        .build()
        .await
        .map_err(|e| err("no default collection", e))?;
    let properties = HashMap::from([
        (
            "org.freedesktop.Secret.Item.Label",
            Value::from(key.label()),
        ),
        (
            "org.freedesktop.Secret.Item.Attributes",
            Value::from(key.attributes()),
        ),
    ]);
    let session_path = session.inner().path().clone();
    let result = collection
        .create_item(
            properties,
            &(session_path, &[], secret.as_bytes(), "text/plain"),
            true,
        )
        .await
        .map_err(|e| err("cannot store the secret", e));
    let outcome = match result {
        Ok((_, prompt)) => run_prompt(conn, &prompt).await,
        Err(e) => Err(e),
    };
    let _ = session.close().await;
    outcome
}

/// Deletes the secret, if there is one.
pub async fn delete(conn: &Connection, key: &Key<'_>) -> Result<(), String> {
    let service = ServiceProxy::new(conn)
        .await
        .map_err(|e| err("not available", e))?;
    let (unlocked, locked) = service
        .search_items(key.attributes())
        .await
        .map_err(|e| err("search failed", e))?;
    for path in unlocked.into_iter().chain(locked) {
        let item = ItemProxy::builder(conn)
            .path(path)
            .map_err(|e| err("bad item path", e))?
            .build()
            .await
            .map_err(|e| err("item", e))?;
        let prompt = item.delete().await.map_err(|e| err("cannot delete", e))?;
        run_prompt(conn, &prompt).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_name_the_secret() {
        let a = Key::ApiToken { server: "home" }.attributes();
        assert_eq!(a["application"], "pve-bar");
        assert_eq!(a["kind"], "api-token");
        assert_eq!(a["server"], "home");
        let t = Key::TempAgent { server: "lab" };
        assert_eq!(t.attributes()["kind"], "temp-agent");
        assert!(t.label().contains("lab"));
    }
}
