//! Static contract for the authenticated adapter. No account data or credentials.
use crate::postgres::Environment;
use serde_json::{Value, json};

pub(super) fn document(environment: Environment) -> Value {
    let mut tools: Vec<Value> = crate::server::tools()
        .into_iter()
        .map(|tool| serde_json::to_value(tool).expect("tool schema"))
        .collect();
    tools.push(json!({
        "name":"get_profile",
        "description":"Return the profile represented by this request's authenticated credentials. Its opaque ID stays unchanged across token renewal and reconnection.",
        "inputSchema":{"type":"object","properties":{},"additionalProperties":false},
        "outputSchema":{"type":"object","properties":{
            "id":{"type":"string","minLength":1,"pattern":"\\S"},
            "name":{"type":"string"},"nickname":{"type":"string"}
        },"required":["id"],"additionalProperties":false},
        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false},
        "_meta":{"openai/profile":true,"ui":{"visibility":["model"]},"openai/widgetAccessible":false}
    }));
    for tool in &mut tools {
        // Resource attachment belongs to the Node adapter's immutable bundle.
        if tool["name"] == "gtd_ui_read" {
            let schema = &mut tool["inputSchema"];
            let mut widget = crate::mcp_contract::ui_schema(vec![(
                "widget_pages".into(),
                serde_json::to_value(schemars::schema_for!(crate::postgres::WidgetPagesRequest))
                    .unwrap(),
            )]);
            schema["oneOf"]
                .as_array_mut()
                .unwrap()
                .append(widget["oneOf"].as_array_mut().unwrap());
            schema["$defs"]
                .as_object_mut()
                .unwrap()
                .append(widget["$defs"].as_object_mut().unwrap());
            tool["outputSchema"]["anyOf"].as_array_mut().unwrap().push(json!({
                "type":"object","required":["version","account","environment","timezone","revision","evaluated_at","pages","records"],
                "properties":{"version":{"const":1},"account":{"type":"string"},"environment":{"type":"string"},
                    "timezone":{"type":"string"},"revision":{"type":"integer"},"evaluated_at":{"type":"string"},
                    "pages":{"type":"array"},"records":{"type":"array"}}
            }));
        }
        let meta = tool["_meta"].as_object_mut().expect("tool metadata");
        meta.remove("openai/outputTemplate");
        if let Some(ui) = meta.get_mut("ui").and_then(Value::as_object_mut) {
            ui.remove("resourceUri");
        }
        let security = json!([{"type":"oauth2","scopes":["gtd:access"]}]);
        meta.insert("securitySchemes".into(), security.clone());
        tool["securitySchemes"] = security;
    }
    let prefix = match environment {
        Environment::Staging => {
            "STAGING: disposable data. Do not treat these records as real commitments.\n"
        }
        Environment::Production => "",
    };
    json!({"contract_version":1,"version":env!("CARGO_PKG_VERSION"),"environment":environment.as_str(),
        "instructions":format!("{prefix}{}",include_str!("../instructions.txt")),"tools":tools})
}

pub(super) fn result(name: &str, value: Value) -> Value {
    let text = crate::server::result_text(name, &value);
    json!({"content":[{"type":"text","text":text}],"structuredContent":value,"isError":false})
}
