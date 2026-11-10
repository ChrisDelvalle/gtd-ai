//! Own the tunnel's process group and drain both pipes; do not expose its admin API.
use crate::diagnostics::Diagnostics;
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

pub fn shutdown_signal() -> impl std::future::Future<Output = ()> {
    #[cfg(unix)]
    {
        // Register synchronously: a child can become ready before this future is polled.
        let term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
        async move {
            if let Ok(mut term) = term {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    async {
        let _ = tokio::signal::ctrl_c().await;
    }
}

// Only fixed-format operational fields survive. Never persist raw bodies, headers,
// error strings, commands, or unrecognized lines (which might contain task text).
fn summarize(line: &str) -> (String, String) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ("info".into(), "Unstructured tunnel output omitted".into());
    };
    let level = value
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or("info")
        .to_ascii_lowercase();
    let level = match level.as_str() {
        "error" | "fatal" => "error",
        "warn" | "warning" => "warning",
        _ => "info",
    };
    let mut fields = vec![format!("Tunnel {level} event")];
    // Structured identifiers/numbers are useful without recording user data.
    for key in [
        "component",
        "status",
        "status_code",
        "http_status",
        "attempt",
        "duration_ms",
        "elapsed_ms",
    ] {
        if let Some(v) = value.get(key) {
            if v.is_number() || v.is_boolean() {
                fields.push(format!("{key}={v}"));
            } else if key == "component"
                && let Some(s) = v.as_str().filter(|s| {
                    s.len() <= 64
                        && s.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
                })
            {
                fields.push(format!("component={s}"));
            }
        }
    }
    if value.get("component").and_then(Value::as_str) == Some("mcp-adapter")
        && let Some(operation) = value.get("operation").and_then(Value::as_str)
        && (matches!(
            operation,
            "adapter.ready"
                | "adapter.stop"
                | "adapter.uncaught"
                | "adapter.rejection"
                | "adapter.startup_timeout"
                | "adapter.startup_failed"
                | "backend.closed"
                | "backend.transport"
                | "resources.read"
        ) || [
            "capture_item",
            "list_items",
            "update_item",
            "undo_change",
            "apply_changes",
            "list_changes",
            "show_tasks",
            "create_project",
            "update_project",
            "list_projects",
            "show_projects",
            "show_gtd",
            "sync_state",
            "create_recurrence",
            "update_recurrence",
            "list_occurrences",
            "unknown_tool",
        ]
        .iter()
        .any(|name| {
            ["start", "finish", "failed"]
                .iter()
                .any(|suffix| operation == format!("{name}.{suffix}"))
        }))
    {
        fields.push(format!("operation={operation}"));
    }
    // Exact static messages only: a future upstream log change cannot leak payloads.
    if let Some(message) = value
        .get("msg")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        && [
            "starting tunnel client",
            "tunnel client started",
            "tunnel client stopped",
            "poll failed",
            "request completed",
            "response accepted",
            "health server started",
            "MCP process exited",
        ]
        .contains(&message)
    {
        fields.push(message.into());
    }
    (level.into(), fields.join(" · "))
}

async fn drain<R: tokio::io::AsyncRead + Unpin>(reader: R, diagnostics: Diagnostics) {
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        // A malicious/buggy line cannot allocate without bound. Consume it in chunks.
        let mut truncated = false;
        loop {
            let available = match reader.fill_buf().await {
                Ok(v) => v,
                Err(_) => return,
            };
            if available.is_empty() {
                break;
            }
            let take = available
                .iter()
                .position(|b| *b == b'\n')
                .map(|p| p + 1)
                .unwrap_or(available.len());
            let ended = available[take - 1] == b'\n';
            if buffer.len() + take <= 16_384 {
                buffer.extend_from_slice(&available[..take]);
            } else {
                truncated = true;
            }
            reader.consume(take);
            if ended {
                break;
            }
        }
        if buffer.is_empty() && !truncated {
            return;
        }
        let (level, message) = if truncated {
            ("warning".into(), "Oversized tunnel log line omitted".into())
        } else {
            summarize(&String::from_utf8_lossy(&buffer))
        };
        let diagnostics = diagnostics.clone();
        let _ = tokio::task::spawn_blocking(move || {
            diagnostics.event("tunnel.output", &level, &message)
        })
        .await;
    }
}

pub async fn run(
    diagnostics: Diagnostics,
    socket: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let shutdown = shutdown_signal();
    let executable = std::env::current_exe()?;
    let runtime = std::env::var("TODO_MCP_RUNTIME").unwrap_or_else(|_| "rust".into());
    let mcp_command = match runtime.as_str() {
        "rust" => executable.display().to_string(),
        "node" => "node /app/adapter/server.mjs".into(),
        _ => return Err("TODO_MCP_RUNTIME must be rust or node".into()),
    };
    let mut command = Command::new("tunnel-client");
    if runtime == "node" {
        command
            .arg("run")
            .arg("--mcp.stdio-send-initialized-notification");
    } else {
        command.arg("run");
    }
    command
        .arg("--control-plane.api-key=file:/run/secrets/runtime-api-key")
        .arg(format!("--mcp.command={mcp_command}"))
        .arg("--control-plane.poll-channel=main")
        .arg(format!("--health.unix-socket={}", socket.display()))
        .args(["--log.level=info", "--log.format=json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let pid = child.id().ok_or("Tunnel process has no PID")?;
    diagnostics.event("tunnel.start", "success", "Tunnel process started");
    let stdout = tokio::spawn(drain(child.stdout.take().unwrap(), diagnostics.clone()));
    let stderr = tokio::spawn(drain(child.stderr.take().unwrap(), diagnostics.clone()));
    let status = tokio::select! {
        status = child.wait() => status?,
        _ = shutdown => {
            #[cfg(unix)] { let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM); }
            match tokio::time::timeout(Duration::from_secs(20), child.wait()).await {
                Ok(status) => status?,
                Err(_) => {
                    #[cfg(unix)] { let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGKILL); }
                    child.wait().await?
                }
            }
        }
    };
    // Clean up any descendants even if the parent exited unexpectedly.
    #[cfg(unix)]
    {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        let _ = stdout.await;
        let _ = stderr.await;
    })
    .await;
    diagnostics.event(
        "tunnel.stop",
        if status.success() { "success" } else { "error" },
        "Tunnel process exited",
    );
    if !status.success() {
        return Err("Tunnel process exited unsuccessfully".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batch_project_and_sync_operations_survive_sanitization() {
        for name in [
            "apply_changes",
            "create_project",
            "update_project",
            "list_projects",
            "show_projects",
            "show_gtd",
            "sync_state",
            "create_recurrence",
            "update_recurrence",
            "list_occurrences",
        ] {
            for suffix in ["start", "finish", "failed"] {
                let operation = format!("{name}.{suffix}");
                let (_, text) = summarize(
                    &serde_json::json!({
                        "component": "mcp-adapter",
                        "operation": operation,
                        "message": "PRIVATE_PROJECT_CONTENT",
                        "arguments": {"title": "PRIVATE_PROJECT_CONTENT"},
                    })
                    .to_string(),
                );
                assert!(text.contains(&format!("operation={operation}")), "{text}");
                assert!(!text.contains("PRIVATE_PROJECT_CONTENT"));
            }
        }
        for (component, operation) in [
            (
                "mcp-adapter",
                "create_project.finish.PRIVATE_PROJECT_CONTENT",
            ),
            ("mcp-adapter", "sync_state.PRIVATE_PROJECT_CONTENT"),
            ("other-component", "create_project.finish"),
        ] {
            let (_, text) = summarize(
                &serde_json::json!({"component": component, "operation": operation}).to_string(),
            );
            assert!(!text.contains("operation="), "{text}");
            assert!(!text.contains("PRIVATE_PROJECT_CONTENT"));
        }
    }

    #[test]
    fn raw_tunnel_content_is_not_retained() {
        let (_, text) = summarize(
            r#"{"level":"error","msg":"Authorization: Bearer secret; task title","headers":{"Authorization":"secret"},"body":"notes", "status_code":401,"error":"sk-test"}"#,
        );
        assert!(text.contains("401"));
        for secret in ["secret", "title", "notes", "sk-test", "Authorization"] {
            assert!(!text.contains(secret));
        }
        assert!(!summarize("sk-secret raw payload").1.contains("sk-secret"));
    }
}
