#![cfg(unix)]
use std::{
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

#[test]
fn supervisor_drains_output_forwards_termination_and_records_shutdown() {
    exercise_shutdown("rust");
    exercise_shutdown("node");
}

fn exercise_shutdown(runtime: &str) {
    let dir = TempDir::new().unwrap();
    let child_marker = dir.path().join("child-stopped");
    let started = dir.path().join("started");
    let args = dir.path().join("args");
    let fake = dir.path().join("tunnel-client");
    std::fs::write(&fake, r#"#!/bin/sh
printf '%s\n' "$@" > "$TODO_TEST_ARGS"
trap 'wait; exit 0' TERM
/bin/sh -c 'trap "touch \"$TODO_TEST_CHILD_MARKER\"; exit 0" TERM; touch "$TODO_TEST_STARTED"; while :; do sleep 1; done' &
printf '%s\n' '{"level":"info","status_code":200,"msg":"task body must not be logged"}'
wait
"#).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut process = Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
        .arg("--supervise-tunnel")
        .arg("--db")
        .arg(dir.path().join("tasks.db"))
        .env(
            "PATH",
            format!(
                "{}:{}",
                dir.path().display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env("TODO_LOG_DB_PATH", dir.path().join("events.db"))
        .env("TODO_TEST_CHILD_MARKER", &child_marker)
        .env("TODO_TEST_STARTED", &started)
        .env("TODO_TEST_ARGS", &args)
        .env("TODO_MCP_RUNTIME", runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !started.exists() {
        assert!(Instant::now() < deadline, "fake tunnel did not start");
        std::thread::sleep(Duration::from_millis(25));
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(process.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let status = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = process.kill();
            panic!("supervisor failed bounded shutdown");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(status.success(), "supervisor exit status: {status:?}");
    let args = std::fs::read_to_string(args).unwrap();
    assert_eq!(
        args.contains("--mcp.stdio-send-initialized-notification"),
        runtime == "node"
    );
    if runtime == "node" {
        assert!(args.contains("--mcp.command=node /app/adapter/server.mjs"));
    }

    assert!(child_marker.exists(), "descendant did not receive TERM");
    let db = rusqlite::Connection::open(dir.path().join("events.db")).unwrap();
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM events WHERE operation='tunnel.stop' AND outcome='success'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    let leaked: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM events WHERE message LIKE '%task body%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leaked, 0);
}
