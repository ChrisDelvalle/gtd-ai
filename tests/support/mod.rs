//! Explicit content defaults for pre-content-contract regression fixtures.
//! Content-contract tests deliberately do not use this helper.
#![allow(dead_code)]
use serde_json::{Value, json};
pub fn author(mut value: Value) -> Value {
    if let Some(v) = value.as_object_mut() {
        v.entry("brief")
            .or_insert(json!("Complete this disposable regression fixture."));
        v.entry("agent_notes").or_insert(json!(
            "Isolated regression fixture; no real-world action is authorized."
        ));
    }
    value
}
pub fn operation(name: &str, mut value: Value) -> Value {
    match name {
        "capture_item" | "capture" | "create_project" => value = author(value),
        "create_recurrence" => {
            if let Some(t) = value.get_mut("template") {
                *t = author(t.clone());
            }
        }
        "apply_changes" => {
            if let Some(a) = value.get_mut("operations").and_then(Value::as_array_mut) {
                for v in a {
                    let n = v["operation"].as_str().unwrap_or("").to_owned();
                    *v = operation(&n, v.clone());
                }
            }
        }
        _ => {}
    }
    value
}
pub fn input<T: serde::de::DeserializeOwned>(value: Value) -> T {
    let name = std::any::type_name::<T>().rsplit("::").next().unwrap();
    let operation = match name {
        "CaptureItem" => "capture",
        "CreateProject" => "create_project",
        "CreateRecurrence" => "create_recurrence",
        "ApplyChanges" => "apply_changes",
        _ => "",
    };
    serde_json::from_value(operation_value(operation, value)).unwrap()
}
fn operation_value(name: &str, value: Value) -> Value {
    operation(name, value)
}
