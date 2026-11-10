use super::{
    read_snapshot::Snapshot,
    tests::{fixture_with_budget, principal},
    write_tests::{capture, run},
    *,
};
use crate::model::{ListItems, Status};
use serde_json::{Value, json};
use std::time::Instant;

fn stats(mut times: Vec<f64>) -> Value {
    times.sort_by(f64::total_cmp);
    json!({"n":times.len(),"median":times[times.len()/2],"p95":times[(times.len()*95).div_ceil(100)-1]})
}

#[test]
#[ignore = "Manual paired read benchmark with a fresh loopback PostgreSQL account"]
fn paired_exact_reads_with_dependencies() {
    assert_eq!(std::env::var("GTD_ACTIVITY_BENCH").as_deref(), Ok("1"));
    let (_container, mut admin, config, account, foreign) = fixture_with_budget("1g", "1g");
    admin
        .batch_execute("DROP INDEX gtd.tasks_timed_holds")
        .unwrap();
    admin.execute("DELETE FROM gtd.tasks", &[]).unwrap();
    let store = Store::connect(config, Environment::Staging, 2).unwrap();
    let template = run(&store, "a", "capture", capture("graph-template")).task;
    let p = principal("a");
    let stamp = crate::clock::timestamp();
    let mut reports = Vec::new();
    let ids: Vec<_> = (0..2500).map(|_| Uuid::new_v4().to_string()).collect();
    let mut previous = 0;
    for count in [25, 250, 2500] {
        // The first target has one external blocker and three transitive
        // dependents. The second participates in a nearly account-wide chain.
        let mut tasks: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut task = template.clone();
                task.id = id.clone();
                task.last_change_id = (i + 2) as i64;
                task.notes = "Collect the relevant records and verify the result. ".repeat(70);
                task.blocked_by = match i {
                    0 => vec![ids[4].clone()],
                    1..=3 => vec![ids[i - 1].clone()],
                    6.. if i % 4 != 0 => vec![ids[i - 1].clone()],
                    _ => Vec::new(),
                };
                if i == 3 {
                    task.status = Status::Waiting;
                    task.planning.importance = Some(crate::planning::Importance::Critical);
                }
                if i == 4 {
                    task.status = Status::Done;
                }
                if i == 6 {
                    task.status = Status::Blocked;
                    task.planning.not_before =
                        Some(serde_json::from_value(json!({"date":"2090-03-11"})).unwrap());
                }
                serde_json::to_string(&task).unwrap()
            })
            .collect();
        // A wide component exercises the fallback tradeoff without requiring
        // quadratic creation through the application's mutation path.
        let wide = ids[5].clone();
        for i in previous.max(6)..count {
            let mut task: crate::model::Task = serde_json::from_str(&tasks[i]).unwrap();
            task.blocked_by.push(wide.clone());
            task.blocked_by.sort_unstable();
            task.blocked_by.dedup();
            tasks[i] = serde_json::to_string(&task).unwrap();
        }
        let mut setup = admin.transaction().unwrap();
        let slice = (&ids[previous..count], &tasks[previous..count]);
        let offset = previous as i64;
        setup.execute("INSERT INTO gtd.tasks(account_id,id,document) SELECT $1,i,d FROM unnest($2::text[],$3::text[]) t(i,d)",&[&account,&slice.0,&slice.1]).unwrap();
        setup
            .execute(
                "INSERT INTO gtd.changes(account_id,id,task_id,document,entity_type,token)
            SELECT $1,n+$5+1,i,json_build_object('id',n+$5+1,'task_id',i,'operation','capture',
                'reason','Fixture','after',d::jsonb,'origin','test','created_at',$4::text)::text,
                'task',gen_random_uuid()::text
            FROM unnest($2::text[],$3::text[]) WITH ORDINALITY t(i,d,n)",
                &[&account, &slice.0, &slice.1, &stamp, &offset],
            )
            .unwrap();
        setup.execute("INSERT INTO gtd.revisions(account_id,seq,entity_id,entity_type,document)
            SELECT $1,n+$4+1,i,'task',d FROM unnest($2::text[],$3::text[]) WITH ORDINALITY t(i,d,n)",&[&account,&slice.0,&slice.1,&offset]).unwrap();
        setup.execute("INSERT INTO gtd.dependencies(account_id,task_id,prerequisite_id)
            SELECT account_id,id,prerequisite FROM gtd.tasks
            CROSS JOIN LATERAL jsonb_array_elements_text(document::jsonb->'blocked_by') AS prerequisite
            WHERE account_id=$1 AND id=ANY($2)",&[&account,&slice.0]).unwrap();
        setup
            .execute(
                "UPDATE gtd.account_state SET high=$2 WHERE account_id=$1",
                &[&account, &(count as i64 + 1)],
            )
            .unwrap();
        setup.commit().unwrap();
        previous = count;
        admin
            .batch_execute("ANALYZE gtd.tasks; ANALYZE gtd.dependencies; ANALYZE gtd.revisions")
            .unwrap();
        for (kind, id) in [("small-component", &ids[0]), ("large-component", &wide)] {
            let input = ListItems {
                task_id: Some(id.clone()),
                ..Default::default()
            };
            let run = |focused: bool| {
                store
                    .read_current(&p, |tx| {
                        let mut cursor = tx.list_cursor(None, "tasks", Value::Null, false, 0)?;
                        cursor.evaluated_at = stamp.clone();
                        let snapshot = Snapshot::load_for(
                            tx,
                            cursor.high,
                            stamp.clone(),
                            focused.then_some(id.as_str()),
                        )?;
                        let result = tx.task_page(input.clone(), 20, 50, cursor, &snapshot)?;
                        Ok(crate::view::task_list(&result, &input))
                    })
                    .unwrap()
            };
            let baseline = run(false);
            assert_eq!(run(true), baseline);
            assert_eq!(baseline["items"][0]["id"], *id);
            assert!(baseline["next_change_at"].is_string());
            if kind == "small-component" {
                assert_eq!(
                    baseline["items"][0]["recommendation"]["source_task_id"],
                    ids[3]
                );
            }
            let mut samples = [Vec::new(), Vec::new()];
            for pair in 0..30 {
                for variant in [pair % 2, 1 - pair % 2] {
                    let start = Instant::now();
                    let result = run(variant == 1);
                    samples[variant].push(start.elapsed().as_secs_f64() * 1000.);
                    assert_eq!(result, baseline);
                }
            }
            reports.push(json!({"records":count,"shape":kind,"full":stats(samples[0].clone()),"focused":stats(samples[1].clone())}));
        }
        if count == 2500 {
            let typed = store.read(&p, |tx| {
                let sql = "SELECT document FROM gtd.tasks WHERE account_id=$1 AND id=$2";
                let mut samples = [Vec::new(), Vec::new()];
                for pair in 0..60 {
                    for variant in [pair % 2, 1 - pair % 2] {
                        let start = Instant::now();
                        let row = if variant == 0 {
                            tx.tx.query_one(sql, &[&account, &ids[0]])?
                        } else {
                            tx.tx.query_typed_one(sql, &[(&account, Type::UUID), (&ids[0], Type::TEXT)])?
                        };
                        samples[variant].push(start.elapsed().as_secs_f64() * 1000.);
                        assert_eq!(row.get::<_, String>(0), tasks[0]);
                    }
                }
                Ok(json!({"prepared":stats(samples[0].clone()),"typed":stats(samples[1].clone())}))
            }).unwrap();
            println!("GTD_TYPED_QUERY={typed}");

            let mut reads = [Vec::new(), Vec::new()];
            let mut edits = [Vec::new(), Vec::new()];
            let mut plan = Vec::new();
            let query = ListItems {
                task_id: Some(ids[0].clone()),
                ..Default::default()
            };
            let expected = store.list(&p, query.clone()).unwrap();
            for indexed in [false, true, true, false] {
                if indexed {
                    admin
                        .batch_execute(include_str!("timed_holds_index.sql"))
                        .unwrap();
                } else {
                    admin
                        .batch_execute("DROP INDEX IF EXISTS gtd.tasks_timed_holds")
                        .unwrap();
                }
                let elapsed = store.read(&p, |tx| {
                    let sql = "EXPLAIN (ANALYZE, BUFFERS) SELECT document::jsonb->>'not_before'
                        FROM gtd.tasks WHERE account_id=$1 AND entity_type='task'
                        AND document::jsonb->>'status'='blocked' AND document::jsonb->>'not_before' IS NOT NULL";
                    Ok(tx.tx.query_typed(sql, &[(&account, Type::UUID)])?.into_iter()
                        .map(|r|r.get::<_,String>(0)).collect::<Vec<_>>())
                }).unwrap();
                plan.push(json!({"indexed":indexed,"plan":elapsed}));
                for n in 0..15 {
                    let start = Instant::now();
                    let result = store.list(&p, query.clone()).unwrap();
                    reads[usize::from(indexed)].push(start.elapsed().as_secs_f64() * 1000.);
                    assert_eq!(result.items, expected.items);
                    let start = Instant::now();
                    store
                        .write(&p, |tx| {
                            tx.tx.batch_execute("SAVEPOINT edit_probe")?;
                            tx.tx.execute_typed(
                                "UPDATE gtd.tasks SET document=jsonb_set(document::jsonb,
                            '{title}',to_jsonb($3::text))::text WHERE account_id=$1 AND id=$2",
                                &[
                                    (&account, Type::UUID),
                                    (&ids[6], Type::TEXT),
                                    (&format!("Fixture hold edit {n}"), Type::TEXT),
                                ],
                            )?;
                            tx.tx.batch_execute(
                                "ROLLBACK TO SAVEPOINT edit_probe; RELEASE SAVEPOINT edit_probe",
                            )?;
                            Ok(())
                        })
                        .unwrap();
                    edits[usize::from(indexed)].push(start.elapsed().as_secs_f64() * 1000.);
                }
            }
            println!(
                "GTD_TIMED_HOLDS={}",
                json!({"reads":{"no_index":stats(reads[0].clone()),"index":stats(reads[1].clone())},
                "edits":{"no_index":stats(edits[0].clone()),"index":stats(edits[1].clone())},"plans":plan})
            );
        }
        assert!(
            store
                .list(
                    &principal("b"),
                    ListItems {
                        task_id: Some(ids[0].clone()),
                        ..Default::default()
                    }
                )
                .unwrap()
                .items
                .is_empty()
        );
        assert_ne!(account, foreign);
    }
    println!("GTD_EXACT_READS={}", json!(reports));
}
