//! Actual image wiring, without public ingress, live identities or model prompts.
use super::tests::fixture;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

struct Running(String);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.0]).output();
    }
}
fn docker(args: &[&str]) -> Output {
    Command::new("docker")
        .args(args)
        .output()
        .expect("Docker required")
}
fn successful(args: &[&str]) -> String {
    let output = docker(args);
    assert!(
        output.status.success(),
        "Container fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn private(path: &Path, content: &[u8]) {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(content)
        .unwrap();
}
fn image(variable: &str) -> String {
    let value = std::env::var(variable).expect("Set the exact fixture image ID");
    assert!(
        value.starts_with("sha256:")
            && value.len() == 71
            && value[7..].bytes().all(|b| b.is_ascii_hexdigit())
    );
    value
}
fn curl(name: &str, url: &str, extra: &[&str]) -> String {
    let mut args = vec![
        "exec",
        name,
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        "2",
        "-i",
    ];
    args.extend(extra);
    args.push(url);
    successful(&args)
}
fn ready(name: &str, url: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let output = docker(&[
            "exec",
            name,
            "curl",
            "--fail",
            "--silent",
            "--max-time",
            "1",
            url,
        ]);
        if output.status.success() {
            return;
        }
        if Instant::now() >= deadline {
            let logs = docker(&["logs", name]);
            panic!(
                "Disposable container did not become ready at {url}: {}",
                String::from_utf8_lossy(&logs.stderr)
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}
#[test]
#[ignore = "Build pinned service/adapter images and set GTD_TEST_SERVICE_IMAGE/GTD_TEST_ADAPTER_IMAGE; local disposable Docker only"]
fn packaged_services_share_private_loopback_and_serve_the_existing_website() {
    let service_image = image("GTD_TEST_SERVICE_IMAGE");
    let adapter_image = image("GTD_TEST_ADAPTER_IMAGE");
    let (pg, mut admin, runtime, _, _) = fixture();
    let database_identity: uuid::Uuid = admin
        .query_one("SELECT identity FROM gtd.schema_meta", &[])
        .unwrap()
        .get(0);
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    private(
        &directory.path().join("runtime.dsn"),
        format!(
            "host=127.0.0.1 port=5432 user=gtd_runtime dbname=postgres password={}",
            std::str::from_utf8(runtime.get_password().unwrap()).unwrap()
        )
        .as_bytes(),
    );
    private(
        &directory.path().join("website.secret"),
        b"synthetic-offline-browser-secret",
    );
    private(
        &directory.path().join("administration.secret"),
        b"synthetic-offline-administration-secret",
    );
    let issuer = "https://identity.invalid/realms/gtd-staging";
    let resource = "https://mcp.invalid/mcp";
    private(&directory.path().join("service.json"),&serde_json::to_vec(&json!({
        "environment":"staging","listen":"127.0.0.1:18554","database_dsn_file":"/config/runtime.dsn","database_identity":database_identity,
        "pool_size":4,"issuer":issuer,"resource":resource,
        "protected_resource_metadata":"https://mcp.invalid/.well-known/oauth-protected-resource/mcp",
        "website":{"origin":"https://website.invalid/","client_id":"gtd-website","client_secret_file":"/config/website.secret",
            "provider_private_url":"http://127.0.0.1:18556/","realm":"gtd-staging","administration_client_id":"gtd-administration",
            "administration_secret_file":"/config/administration.secret","oauth_clients":["gtd-website","gtd-chatgpt","gtd-claude"]}
    })).unwrap());
    private(&directory.path().join("adapter.json"),&serde_json::to_vec(&json!({"environment":"staging","port":18555,
        "backendOrigin":"http://127.0.0.1:18554","issuer":issuer,"resource":resource,
        "ingresses":[{"host":"127.0.0.1:18555","metadataOrigin":"http://127.0.0.1:18555","uiHost":"openai"}]
    })).unwrap());
    // Share only the disposable DB's namespace; no host networking or new ports.
    let network = format!("container:{}", pg.name());
    let inspected_network = format!(
        "container:{}",
        successful(&["inspect", pg.name(), "--format", "{{.Id}}"]).trim()
    );
    let owner = fs::metadata(directory.path()).unwrap();
    let user = format!("{}:{}", owner.uid(), owner.gid());
    assert_ne!(
        owner.uid(),
        0,
        "Run this fixture as the ordinary developer user"
    );
    let mount = format!(
        "type=bind,source={},target=/config,readonly",
        directory.path().display()
    );
    let launch = |image: &str, config: &str| {
        // Catch bind-mount permission/ownership differences on Docker Desktop
        // without ever printing the synthetic credential/configuration contents.
        successful(&[
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--user",
            &user,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--mount",
            &mount,
            "--entrypoint",
            "sh",
            image,
            "-c",
            "test -r /config/runtime.dsn && test -r /config/service.json && test -r /config/adapter.json",
        ]);
        let name = format!("gtd-image-fixture-{}", Uuid::new_v4().simple());
        let running = Running(name.clone());
        successful(&[
            "run",
            "--detach",
            "--pull",
            "never",
            "--name",
            &name,
            "--network",
            &network,
            "--user",
            &user,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            "512m",
            "--cpus",
            "1",
            "--pids-limit",
            "128",
            "--tmpfs",
            "/tmp:size=16m",
            "--mount",
            &mount,
            image,
            config,
        ]);
        running
    };
    let service = launch(&service_image, "/config/service.json");
    ready(&service.0, "http://127.0.0.1:18554/internal/ready");
    let adapter = launch(&adapter_image, "/config/adapter.json");
    ready(
        &adapter.0,
        "http://127.0.0.1:18555/.well-known/oauth-protected-resource/mcp",
    );
    let html = curl(&service.0, "http://127.0.0.1:18554/", &[]);
    assert!(
        html.starts_with("HTTP/1.1 200") && html.contains("<html") && html.contains("no-store")
    );
    let asset = html
        .split("src=\"")
        .filter_map(|s| s.split('"').next())
        .find(|s| s.starts_with("/assets/") && s.ends_with(".js"))
        .unwrap();
    let asset_response = curl(
        &service.0,
        &format!("http://127.0.0.1:18554{asset}"),
        &["--head", "-H", "Accept-Encoding: br"],
    );
    assert!(
        asset_response
            .to_lowercase()
            .contains("content-encoding: br")
            && asset_response.contains("immutable")
    );
    let deep = curl(&service.0, "http://127.0.0.1:18554/projects", &[]);
    assert!(deep.starts_with("HTTP/1.1 200") && deep.contains("<html"));
    for path in ["/api/users", "/api/logs", "/api/health"] {
        let response = curl(&service.0, &format!("http://127.0.0.1:18554{path}"), &[]);
        assert!(response.starts_with("HTTP/1.1 401") && !response.contains("<html"));
    }
    let discovery = curl(
        &adapter.0,
        "http://127.0.0.1:18555/.well-known/oauth-protected-resource/mcp",
        &[],
    );
    assert!(discovery.contains(resource) && discovery.contains(issuer));
    let anonymous = curl(
        &adapter.0,
        "http://127.0.0.1:18555/mcp",
        &[
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "--data",
            "{}",
        ],
    );
    assert!(
        anonymous.starts_with("HTTP/1.1 401")
            && anonymous.to_lowercase().contains("www-authenticate:")
    );
    assert!(
        curl(&adapter.0, "http://127.0.0.1:18555/internal/contract", &[])
            .starts_with("HTTP/1.1 404")
    );
    assert!(
        curl(
            &adapter.0,
            "http://127.0.0.1:18555/.well-known/oauth-protected-resource/mcp",
            &["-H", "Host: unconfigured.invalid"]
        )
        .starts_with("HTTP/1.1 403")
    );
    for name in [&service.0, &adapter.0] {
        let inspect: Value = serde_json::from_str(&successful(&["inspect", name])).unwrap();
        assert_eq!(inspect[0]["HostConfig"]["ReadonlyRootfs"], true);
        assert_eq!(inspect[0]["HostConfig"]["NetworkMode"], inspected_network);
        assert!(
            inspect[0]["HostConfig"]["PortBindings"].is_object()
                && inspect[0]["HostConfig"]["PortBindings"]
                    .as_object()
                    .unwrap()
                    .is_empty()
        );
        successful(&[
            "exec",
            name,
            "test",
            "!",
            "-e",
            "/usr/local/bin/gtd-migrate",
        ]);
    }
    successful(&["stop", "--time", "10", &adapter.0, &service.0]);
    println!(
        "{{\"scenario\":\"container-wiring\",\"public_ports_added\":0,\"models\":0,\"synthetic_only\":true}}"
    );
}

#[test]
#[ignore = "Build private operator image and set GTD_TEST_OPERATOR_IMAGE; synthetic snapshot and network-disabled container only"]
fn migration_image_inspects_copied_sqlite_without_network() {
    let operator_image = image("GTD_TEST_OPERATOR_IMAGE");
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().join("source.sqlite3");
    let mut old = crate::store::Store::open(&path).unwrap();
    old.capture(
        serde_json::from_value(
            json!({"request_id":"offline-image","title":"Disposable image inspection",
        "importance":"normal","reason":"Fixture"}),
        )
        .unwrap(),
    )
    .unwrap();
    let environment = old.environment();
    drop(old);
    let source_id: String =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .query_row(
                "SELECT value FROM store_meta WHERE key='identity'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    let source = super::legacy::Source {
        identity: source_id.parse().unwrap(),
        environment,
    };
    let expected = serde_json::to_value(
        super::legacy::Snapshot::open(&path, &source)
            .unwrap()
            .report(),
    )
    .unwrap();
    private(
        &directory.path().join("config.json"),
        &serde_json::to_vec(&json!({
        "source_path":"/fixture/source.sqlite3","source":source}))
        .unwrap(),
    );
    let owner = fs::metadata(directory.path()).unwrap();
    assert_ne!(owner.uid(), 0);
    let user = format!("{}:{}", owner.uid(), owner.gid());
    let mount = format!(
        "type=bind,source={},target=/fixture,readonly",
        directory.path().display()
    );
    let output = successful(&[
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--user",
        &user,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "256m",
        "--pids-limit",
        "64",
        "--mount",
        &mount,
        &operator_image,
        "inspect",
        "/fixture/config.json",
    ]);
    let report: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(report["operation"], "inspect");
    assert_eq!(report["source"], expected);
    assert!(!output.contains("Disposable image inspection"));
}
