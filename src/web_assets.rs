//! Public, content-free website shell and versioned assets. User data is served
//! separately through authenticated APIs; unknown API paths are never SPA routes.
use axum::{
    Router,
    http::{StatusCode, header},
    response::Response,
    routing::get_service,
};
#[cfg(feature = "postgres-storage")]
use axum::{
    extract::Request,
    http::Method,
    middleware::{self, Next},
    response::IntoResponse,
};
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};

pub fn assets_dir() -> PathBuf {
    std::env::var_os("TODO_WEB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("web/dist"))
}

pub(crate) fn routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
    let assets = assets_dir();
    let mut routes = Router::new().nest_service(
        "/assets",
        get_service(
            ServeDir::new(assets.join("assets"))
                .precompressed_br()
                .precompressed_gzip(),
        ),
    );
    // Only application destinations receive the shell. Unknown APIs and missing
    // assets retain their real 404; direct links must return a successful document.
    for path in [
        "/",
        "/tasks",
        "/tasks/{id}",
        "/projects",
        "/projects/{id}",
        "/repeating",
        "/repeating/{id}",
        "/review",
        "/activity",
        "/charts",
        "/results",
        "/help",
        "/logs",
        "/health",
        "/users",
    ] {
        routes = routes.route_service(path, get_service(ServeFile::new(assets.join("index.html"))));
    }
    routes.fallback_service(ServeDir::new(&assets))
}

#[cfg(feature = "postgres-storage")]
pub(crate) fn router() -> Router {
    routes().layer(middleware::from_fn(guard))
}

pub(crate) fn valid_shell_path(path: &str) -> bool {
    let parts: Vec<_> = path.trim_matches('/').split('/').collect();
    !(parts.len() == 2
        && matches!(parts[0], "tasks" | "projects" | "repeating")
        && (parts[1].len() != 36 || uuid::Uuid::parse_str(parts[1]).is_err()))
}

#[cfg(feature = "postgres-storage")]
async fn guard(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = if !matches!(request.method(), &Method::GET | &Method::HEAD) {
        StatusCode::METHOD_NOT_ALLOWED.into_response()
    } else if !valid_shell_path(&path) {
        StatusCode::NOT_FOUND.into_response()
    } else {
        next.run(request).await
    };
    headers(&path, &mut response);
    response
}

pub(crate) fn headers(path: &str, response: &mut Response) {
    let immutable_asset = immutable_asset_path(path);
    let cacheable = immutable_asset
        && (response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED);
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        if cacheable {
            "public, max-age=31536000, immutable"
        } else {
            "no-store"
        }
        .parse()
        .unwrap(),
    );
    if immutable_asset {
        headers.insert(header::VARY, "Accept-Encoding".parse().unwrap());
    }
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'".parse().unwrap());
}

fn immutable_asset_path(path: &str) -> bool {
    let Some(name) = path.strip_prefix("/assets/") else {
        return false;
    };
    if name.contains('/') {
        return false;
    }
    let Some(stem) = name
        .strip_suffix(".js")
        .or_else(|| name.strip_suffix(".css"))
    else {
        return false;
    };
    let Some((_, hash)) = stem.rsplit_once('-') else {
        return false;
    };
    hash.len() >= 8 && hash.bytes().all(|byte| byte.is_ascii_alphanumeric())
}
