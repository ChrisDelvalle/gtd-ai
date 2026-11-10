use std::process::Command;

fn configured(environment: &str, instant: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_todo-mcp"))
        .arg("--version")
        .env("TODO_ENVIRONMENT", environment)
        .env("TODO_BENCHMARK_NOW", instant)
        .output()
        .unwrap()
}

#[test]
fn a_normal_release_cannot_freeze_its_clock() {
    #[cfg(not(feature = "benchmark-clock"))]
    assert!(configured("production", "not-a-date").status.success());
    let before = chrono::Utc::now();
    let decision = todo_mcp::clock::now();
    assert!(decision >= before && decision <= chrono::Utc::now());
}

#[cfg(feature = "benchmark-clock")]
#[test]
fn benchmark_clock_requires_test_environment_and_a_valid_instant() {
    let denied = configured("production", "2026-10-09T16:00:00Z");
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("disposable test"));
    assert!(!configured("test", "invalid").status.success());
    assert!(configured("test", "2026-10-09T16:00:00Z").status.success());
}
