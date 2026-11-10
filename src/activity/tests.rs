use super::*;

fn event(id: i64, undoes: Option<i64>) -> Event {
    Event {
        id,
        entity_id: "task".into(),
        entity_type: EntityType::Task,
        at: "2026-11-01T12:00:00Z".into(),
        category: if undoes.is_some() {
            Category::Undo
        } else {
            Category::Completed
        },
        automatic: false,
        undoes,
        completion: undoes.is_none(),
    }
}

#[test]
fn correction_chains_restore_original_completion() {
    let mut events = vec![event(1, None), event(2, Some(1))];
    assert_eq!(reversals(&events).get(&1), Some(&2));
    events.push(event(3, Some(2)));
    assert!(!reversals(&events).contains_key(&1));
    events.push(event(4, Some(3)));
    assert_eq!(reversals(&events).get(&1), Some(&2));
}

#[test]
fn calendar_days_include_dst_and_exclude_today() {
    let range = Range {
        days: Some(7),
        ..Default::default()
    };
    let w = range
        .resolve(chrono_tz::America::New_York, "2026-11-04T22:00:00+00:00")
        .unwrap();
    assert_eq!(w.from.as_deref(), Some("2026-10-28"));
    assert_eq!(w.through.as_deref(), Some("2026-11-03"));
    let start = DateTime::parse_from_rfc3339(w.start.as_ref().unwrap()).unwrap();
    let end = DateTime::parse_from_rfc3339(&w.end).unwrap();
    assert_eq!((end - start).num_hours(), 169);
    assert!(!w.contains("2026-11-04T05:00:00Z"));
    assert!(w.contains("2026-11-04T04:59:59Z"));
}

#[test]
fn charts_count_distinct_completions_and_exclude_system_work() {
    let mut events = vec![event(1, None), event(2, None), event(3, None)];
    events[2].automatic = true;
    let query = ChartQuery {
        from: "2026-11-01".into(),
        through: "2026-11-02".into(),
        ..Default::default()
    };
    let w = Range {
        from: Some(query.from.clone()),
        through: Some(query.through.clone()),
        days: None,
    }
    .resolve(chrono_tz::America::New_York, "2026-11-04T22:00:00+00:00")
    .unwrap();
    let result = counts(&events, &reversals(&events), &query, &w).unwrap();
    assert_eq!(result["total"], 1);
    assert_eq!(result["automatic_count"], 1);
    let changes = counts(
        &events,
        &reversals(&events),
        &ChartQuery {
            metric: Metric::Changes,
            ..query
        },
        &w,
    )
    .unwrap();
    assert_eq!(changes["total"], 2);
}

#[test]
fn corrections_outside_reporting_days_and_repeated_completions_are_historical() {
    let mut first = event(1, None);
    first.at = "2026-10-31T16:00:00Z".into();
    let mut second = event(2, None);
    second.at = "2026-11-01T16:00:00Z".into();
    let mut undo = event(3, Some(1));
    undo.at = "2026-11-04T16:00:00Z".into();
    let q = ChartQuery {
        from: "2026-10-31".into(),
        through: "2026-11-01".into(),
        ..Default::default()
    };
    let w = Range {
        from: Some(q.from.clone()),
        through: Some(q.through.clone()),
        days: None,
    }
    .resolve(chrono_tz::America::New_York, "2026-11-04T23:00:00Z")
    .unwrap();
    let source = vec![first, second];
    assert_eq!(
        counts(&source, &BTreeMap::new(), &q, &w).unwrap()["total"],
        2
    );
    let mut undo_chain = vec![undo];
    let corrected = counts(&source, &reversals(&undo_chain), &q, &w).unwrap();
    assert_eq!(corrected["total"], 1);
    assert_eq!(corrected["days"][0]["count"], 0);
    undo_chain.push(event(4, Some(3)));
    assert_eq!(
        counts(&source, &reversals(&undo_chain), &q, &w).unwrap()["days"][0]["count"],
        1
    );
}

#[test]
fn spring_calendar_days_and_partial_future_are_not_elapsed_hours_or_zeroes() {
    let w = Range {
        days: Some(7),
        ..Default::default()
    }
    .resolve(chrono_tz::America::New_York, "2026-03-10T17:00:00Z")
    .unwrap();
    assert_eq!(
        (DateTime::parse_from_rfc3339(&w.end).unwrap()
            - DateTime::parse_from_rfc3339(w.start.as_ref().unwrap()).unwrap())
        .num_hours(),
        167
    );
    let q = ChartQuery {
        from: "2026-03-10".into(),
        through: "2026-03-11".into(),
        ..Default::default()
    };
    let w = Range {
        from: Some(q.from.clone()),
        through: Some(q.through.clone()),
        days: None,
    }
    .resolve(chrono_tz::America::New_York, "2026-03-10T17:00:00Z")
    .unwrap();
    let c = counts(&[], &BTreeMap::new(), &q, &w).unwrap();
    assert_eq!(c["days"][0]["partial"], true);
    assert_eq!(c["days"][1]["future"], true);
    assert!(c["days"][1]["count"].is_null());
}
