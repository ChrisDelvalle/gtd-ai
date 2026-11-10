use super::*;
use crate::postgres::administration;
use axum::{
    extract::{Path, Query},
    response::Redirect,
};
use serde::Deserialize;
use serde_json::Value;

pub(super) async fn session(State(service): State<Service>, headers: HeaderMap) -> Response {
    let worker = service.clone();
    service.run(move || {
        let key=optional_session_cookie(&headers)?;
        let grant=key.as_ref().map(|key|worker.sessions.authenticate(key)).transpose();
        match grant {
            Ok(Some(grant))=>Ok(Json(json!({"authenticated":true,"enabled":true,"method":"oidc",
                "environment":worker.store.environment().as_str(),"account":{
                    "id":grant.account.id(),"username":grant.account.username(),"display_name":grant.account.display_name(),
                    "timezone":grant.account.timezone().name(),"administrator":grant.account.administrator()},
                "csrf":grant.csrf,"security_url":worker.security_url})).into_response()),
            // A delayed status response must not clear a newer cookie installed
            // by a concurrent sign-in. Only explicit login/logout set it.
            Ok(None)|Err(website_session::Error::SignIn)=>Ok(Json(json!({"authenticated":false,"enabled":true,"method":"oidc",
                    "environment":worker.store.environment().as_str()})).into_response()),
            Err(error)=>Err(error.into()),
        }
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Login {
    #[serde(default)]
    remember: bool,
    #[serde(default = "home")]
    return_to: String,
    #[serde(default)]
    reauthenticate: bool,
}
fn home() -> String {
    "/".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Timezone {
    expected_timezone: String,
    timezone: String,
}
pub(super) async fn timezone(
    State(service): State<Service>,
    headers: HeaderMap,
    Json(input): Json<Timezone>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, true)?;
            let timezone = worker
                .store
                .set_account_timezone(&grant.principal, &input.expected_timezone, &input.timezone)
                .map_err(|error| {
                    use crate::postgres::settings::Error::*;
                    let (status, code) = match error {
                        InvalidTimezone => (StatusCode::BAD_REQUEST, "invalid_timezone"),
                        Conflict => (StatusCode::CONFLICT, "settings_conflict"),
                        AccountUnavailable => (StatusCode::UNAUTHORIZED, "authentication_required"),
                        Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "settings_unavailable"),
                    };
                    Failure {
                        status,
                        code,
                        message: error.to_string(),
                    }
                })?;
            Ok(Json(json!({"timezone":timezone})).into_response())
        })
        .await
}
pub(super) async fn login(
    State(service): State<Service>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            if input.reauthenticate {
                worker.grant(&headers, true)?;
            }
            let current = optional_session_cookie(&headers)?;
            let started = worker.sessions.start(
                current.as_ref(),
                input.remember,
                &input.return_to,
                input.reauthenticate,
            )?;
            let mut response =
                Json(json!({"authorization_url":started.url.as_str()})).into_response();
            set_cookie(
                &mut response,
                LOGIN,
                started.login_cookie.value(),
                Some(600),
            );
            Ok(response)
        })
        .await
}
#[derive(Deserialize)]
pub(super) struct Callback {
    state: Option<String>,
    code: Option<String>,
    iss: Option<String>,
    error: Option<String>,
}
pub(super) async fn callback(
    State(service): State<Service>,
    headers: HeaderMap,
    Query(input): Query<Callback>,
) -> Response {
    let worker = service.clone();
    let mut response = service
        .run(move || {
            if input.error.is_some() {
                return Err(website_session::Error::SignIn.into());
            }
            let login = cookie(&headers, LOGIN)?.ok_or(website_session::Error::SignIn)?;
            let previous = optional_session_cookie(&headers)?;
            let signed = worker.sessions.finish(
                &login,
                input.state.as_deref().ok_or_else(Failure::invalid)?,
                input.iss.as_deref().ok_or_else(Failure::invalid)?,
                input.code.as_deref().ok_or_else(Failure::invalid)?,
                previous.as_ref(),
            )?;
            let mut response = Redirect::to(&signed.return_to).into_response();
            set_cookie(
                &mut response,
                SESSION,
                signed.cookie.value(),
                signed
                    .remember
                    .then_some(signed.expires_at - chrono::Utc::now().timestamp()),
            );
            Ok(response)
        })
        .await;
    // Never leave codes or provider errors in a rendered page or the UI state.
    // The login UI maps this fixed local marker to a concise retry message.
    if !response.status().is_redirection() {
        response = Redirect::to("/?auth_error=sign_in_failed").into_response();
    }
    set_cookie(&mut response, LOGIN, "", Some(0));
    response
}
pub(super) async fn logout(
    State(service): State<Service>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            if input != json!({}) {
                return Err(Failure::invalid());
            }
            if unique(&headers, "x-gtd-environment") != Some(worker.store.environment().as_str()) {
                return Err(website_session::Error::AccountChanged.into());
            }
            let account = unique(&headers, "x-gtd-account")
                .and_then(|id| Uuid::parse_str(id).ok())
                .ok_or_else(Failure::invalid)?;
            let csrf = unique(&headers, "x-gtd-csrf").ok_or_else(Failure::invalid)?;
            let key = cookie(&headers, SESSION)?.ok_or(website_session::Error::SignIn)?;
            worker.sessions.logout(&key, account, csrf)?;
            let mut response =
                Json(json!({"authenticated":false,"enabled":true,"method":"oidc"})).into_response();
            set_cookie(&mut response, SESSION, "", Some(0));
            set_cookie(&mut response, LOGIN, "", Some(0));
            Ok(response)
        })
        .await
}
pub(super) async fn tool(
    State(service): State<Service>,
    Path(name): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let worker = service.clone();
    let id = super::super::http::request_id(&headers);
    service
        .run(move || {
            let grant = worker.grant(&headers, true)?;
            if !crate::application::UI_READS.contains(&name.as_str())
                && !crate::application::UI_WRITES.contains(&name.as_str())
            {
                return Ok(failure(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Unknown operation",
                ));
            }
            Ok(
                match worker.store.execute_website(&grant.principal, &name, input) {
                    Ok(value) => Json(value).into_response(),
                    Err(error) => super::super::http::application_failure(error, id),
                },
            )
        })
        .await
}
pub(super) async fn view(
    State(service): State<Service>,
    headers: HeaderMap,
    Json(input): Json<crate::view::ViewRequest>,
) -> Response {
    let worker = service.clone();
    let id = super::super::http::request_id(&headers);
    service
        .run(move || {
            let grant = worker.grant(&headers, true)?;
            Ok(match worker.store.home_view(&grant.principal, input) {
                Ok(value) => Json(value).into_response(),
                Err(error) => super::super::http::application_failure(error, id),
            })
        })
        .await
}

pub(super) async fn logs(
    State(service): State<Service>,
    headers: HeaderMap,
    Query(query): Query<crate::diagnostics::LogQuery>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, false)?;
            if !grant.account.administrator() {
                return Err(admin_error(administration::Error::Forbidden));
            }
            let operations = worker.operations.as_ref().ok_or_else(Failure::busy)?;
            let value = operations.logs(query).map_err(|message| Failure {
                status: StatusCode::BAD_REQUEST,
                code: "invalid_log_query",
                message,
            })?;
            Ok(Json(value).into_response())
        })
        .await
}

pub(super) async fn health(State(service): State<Service>, headers: HeaderMap) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, false)?;
            if !grant.account.administrator() {
                return Err(admin_error(administration::Error::Forbidden));
            }
            let operations = worker.operations.as_ref().ok_or_else(Failure::busy)?;
            // Search checkpoints belong only to the caller. Service-wide transport
            // and log metadata contains no other account's records or audit history.
            let search = worker
                .store
                .search_health(&grant.principal)
                .map_err(|_| Failure::busy())?;
            Ok(Json(
                json!({"database":true,"search":search,"diagnostics":operations.health(),
            "tunnel":operations.tunnel_health(),"environment":worker.store.environment().as_str(),
            "version":env!("CARGO_PKG_VERSION"),"checked_at":chrono::Utc::now().to_rfc3339()}),
            )
            .into_response())
        })
        .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ListUsers {
    after: Option<Uuid>,
    limit: Option<i32>,
}
pub(super) async fn users(
    State(service): State<Service>,
    headers: HeaderMap,
    Query(query): Query<ListUsers>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, false)?;
            let result = worker
                .store
                .list_accounts(
                    &grant.administrator_identity(),
                    query.after,
                    query.limit.unwrap_or(50),
                )
                .map_err(admin_error)?;
            Ok(Json(result).into_response())
        })
        .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Administration {
    request_id: Uuid,
    command: administration::Command,
}
pub(super) async fn administration_request(
    State(service): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, false)?;
            let result = worker
                .store
                .administration_request(&grant.administrator_identity(), id)
                .map_err(admin_error)?;
            Ok(Json(json!({"operation":result})).into_response())
        })
        .await
}
pub(super) async fn administration_operation(
    State(service): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, false)?;
            let result = worker
                .store
                .administration_operation(&grant.administrator_identity(), id)
                .map_err(admin_error)?;
            Ok(Json(json!({"operation":result})).into_response())
        })
        .await
}
pub(super) async fn administer(
    State(service): State<Service>,
    headers: HeaderMap,
    Json(input): Json<Administration>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            let grant = worker.grant(&headers, true)?;
            let identity = grant.administrator_identity();
            let operation = worker
                .store
                .begin_administration(&identity, input.request_id, input.command)
                .map_err(admin_error)?;
            let result = worker
                .provisioning
                .resume(&identity, operation.id)
                .map_err(provider_error)?;
            Ok(provisioned(result, &worker.origin))
        })
        .await
}
pub(super) async fn resume(
    State(service): State<Service>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    let worker = service.clone();
    service
        .run(move || {
            if input != json!({}) {
                return Err(Failure::invalid());
            }
            let grant = worker.grant(&headers, true)?;
            let result = worker
                .provisioning
                .resume(&grant.administrator_identity(), id)
                .map_err(provider_error)?;
            Ok(provisioned(result, &worker.origin))
        })
        .await
}
fn provisioned(result: super::super::provisioning::Provisioned, origin: &str) -> Response {
    // The only serialization of the generated credential. No journal, request
    // log, retry receipt, task record or browser persistent storage receives it.
    Json(json!({"operation":result.operation,"temporary_password":result.temporary_password.map(|p|p.expose_once()),
        "sign_in_url":format!("{origin}/")})).into_response()
}
fn provider_error(error: super::super::provisioning::Error) -> Failure {
    match error {
        super::super::provisioning::Error::Administration(error) => admin_error(error),
        _ => Failure {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "provisioning_pending",
            message: error.to_string(),
        },
    }
}
fn admin_error(error: administration::Error) -> Failure {
    use administration::Error::*;
    let (status, code) = match error {
        Forbidden => (StatusCode::FORBIDDEN, "admin_required"),
        Reauthentication => (StatusCode::FORBIDDEN, "reauthentication_required"),
        Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "administration_unavailable",
        ),
        InvalidRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
        TargetUnavailable => (StatusCode::NOT_FOUND, "not_found"),
        _ => (StatusCode::CONFLICT, "administration_conflict"),
    };
    Failure {
        status,
        code,
        message: error.to_string(),
    }
}
