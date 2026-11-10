//! Built separately from the service; no database credentials on the command line.
use std::path::PathBuf;
use todo_mcp::postgres::operator::{Command, execute, read_config};
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let command = match args.first().and_then(|s| s.to_str()) {
        Some("inspect") => Command::Inspect,
        Some("import") => Command::Import,
        Some("verify") => Command::Verify,
        _ => {
            eprintln!("Usage: gtd-migrate inspect|import|verify /absolute/private-config.json");
            std::process::exit(2);
        }
    };
    if args.len() != 2 {
        eprintln!("Expected exactly one private configuration path");
        std::process::exit(2);
    }
    match read_config(&PathBuf::from(&args[1])).and_then(|config| execute(config, command)) {
        Ok(report) => println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("fixed report schema")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
