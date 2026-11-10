use serde_json::{Value, json};
use tempfile::TempDir;
use todo_mcp::store::Store;

fn preview(rule: Value, through: &str) -> Vec<String> {
    let dir = TempDir::new().unwrap();
    let mut store = Store::open(dir.path().join("calendar.db")).unwrap();
    let from = rule["start_date"].clone();
    let result = store
        .list_occurrences(
            serde_json::from_value(json!({"rule":rule,"from":from,"through":through,"limit":100}))
                .unwrap(),
        )
        .unwrap();
    result["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["scheduled_date"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn daily_dates_are_contiguous_across_both_new_york_dst_boundaries() {
    for (start, through, expected) in [
        (
            "2026-03-07",
            "2026-03-10",
            vec!["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"],
        ),
        (
            "2026-10-31",
            "2026-11-03",
            vec!["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"],
        ),
    ] {
        assert_eq!(
            preview(json!({"start_date":start,"frequency":"daily"}), through),
            expected
        );
    }
}

#[test]
fn selected_weekdays_and_intervals_use_calendar_weeks() {
    assert_eq!(
        preview(
            json!({"start_date":"2026-10-05","frequency":"weekly","interval":2,"weekdays":["MO","FR"],"count":4}),
            "2026-11-01"
        ),
        vec!["2026-10-05", "2026-10-09", "2026-10-19", "2026-10-23"]
    );
}

#[test]
fn monthly_ordinal_and_last_weekday_follow_each_month() {
    assert_eq!(
        preview(
            json!({"start_date":"2027-01-01","frequency":"monthly","weekdays":["MO"],"ordinal":-1,"count":3}),
            "2027-04-01"
        ),
        vec!["2027-01-25", "2027-02-22", "2027-03-29"]
    );
    assert_eq!(
        preview(
            json!({"start_date":"2027-01-01","frequency":"monthly","weekdays":["TU"],"ordinal":2,"count":3}),
            "2027-04-01"
        ),
        vec!["2027-01-12", "2027-02-09", "2027-03-09"]
    );
}

#[test]
fn leap_year_occurrences_omit_invalid_dates_without_using_up_count() {
    assert_eq!(
        preview(
            json!({"start_date":"2028-02-29","frequency":"yearly","count":3}),
            "2036-03-01"
        ),
        vec!["2028-02-29", "2032-02-29", "2036-02-29"]
    );
}

#[test]
fn until_end_date_is_inclusive_and_custom_daily_interval_is_preserved() {
    assert_eq!(
        preview(
            json!({"start_date":"2026-10-01","frequency":"daily","interval":2,"until":"2026-10-05"}),
            "2026-10-09"
        ),
        vec!["2026-10-01", "2026-10-03", "2026-10-05"]
    );
}
