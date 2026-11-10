use std::path::PathBuf;
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        eprintln!(
            "Usage: gtd-activity-migrate upgrade|verify|rollback /absolute/private-config.json"
        );
        std::process::exit(2);
    }
    match todo_mcp::postgres::activity_operator::execute(
        &PathBuf::from(&args[1]),
        args[0].to_str().unwrap_or(""),
    ) {
        Ok(report) => println!("{}", serde_json::to_string_pretty(&report).unwrap()),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
