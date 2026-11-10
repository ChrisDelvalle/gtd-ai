//! Decision time can be frozen only in an explicitly built disposable benchmark.
//! Audit timestamps, timeouts and authentication continue to use the real clock.
use chrono::{DateTime, Utc};

#[cfg(feature = "benchmark-clock")]
static FIXED: std::sync::OnceLock<DateTime<Utc>> = std::sync::OnceLock::new();

pub(crate) fn audit_now() -> DateTime<Utc> {
    Utc::now()
}

pub fn initialize() -> Result<(), String> {
    #[cfg(feature = "benchmark-clock")]
    if let Ok(value) = std::env::var("TODO_BENCHMARK_NOW") {
        if std::env::var("TODO_ENVIRONMENT").as_deref() != Ok("test") {
            return Err("A benchmark clock requires the disposable test environment".into());
        }
        let instant = DateTime::parse_from_rfc3339(&value)
            .map_err(|_| "TODO_BENCHMARK_NOW must be an RFC3339 instant")?
            .with_timezone(&Utc);
        FIXED
            .set(instant)
            .map_err(|_| "Benchmark clock was already initialized")?;
    }
    Ok(())
}

pub fn now() -> DateTime<Utc> {
    #[cfg(feature = "benchmark-clock")]
    if let Some(value) = FIXED.get() {
        return *value;
    }
    Utc::now()
}

pub fn timestamp() -> String {
    now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
