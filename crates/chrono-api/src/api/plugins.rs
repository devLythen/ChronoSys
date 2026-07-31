use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_ARCHIVE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_plugins))
        .route("/reload", post(reload_plugins))
        .route("/install/zip", post(install_zip))
        .route("/install/github", post(install_github))
        .route("/{id}/policy", put(update_policy).delete(delete_plugin))
        .layer(DefaultBodyLimit::max(MAX_ARCHIVE_BYTES))
}


#[derive(Debug, Deserialize)]
pub struct GitHubInstallBody { pub url: String, #[serde(default)] pub git_ref: Option<String> }

#[derive(Debug, Deserialize)]
pub struct PolicyBody { pub enabled: bool, pub config: Value, pub tools: Value }

fn strip_frame(mut response: Value) -> Value {
    if let Value::Object(map) = &mut response { map.remove("type"); map.remove("query_id"); }
    response
}

fn host_error(response: &Value) -> Option<String> {
    response.get("error").and_then(Value::as_str).map(ToOwned::to_owned)
}

fn host_result(response: Value) -> ApiResult<Value> {
    if let Some(error) = host_error(&response) { return Err(ApiError::bad_request(error)); }
    Ok(strip_frame(response))
}

async fn list_plugins(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let response = state.query_agent(&json!({ "type": "plugin.list" })).await.map_err(|e| ApiError::internal(format!("agent-host query failed: {e}")))?;
    Ok(Json(host_result(response)?))
}

async fn reload_plugins(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let result = reload_agent_plugins(&state).await?;
    publish_plugins(&state, &result);
    Ok(Json(result))
}


async fn update_policy(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>, Json(body): Json<PolicyBody>) -> ApiResult<Json<Value>> {
    let response = state.query_agent(&json!({ "type": "plugin.policy", "plugin_id": id, "policy": { "enabled": body.enabled, "config": body.config, "tools": body.tools } })).await.map_err(|e| ApiError::internal(format!("agent-host query failed: {e}")))?;
    if let Some(error) = host_error(&response) { return Err(ApiError::bad_request(error)); }
    let result = strip_frame(response);
    let plugin = result.get("plugin").cloned().ok_or_else(|| ApiError::internal("agent-host policy response missing plugin"))?;
    state.publish_ws(vec!["plugins".into()], json!({ "type": "plugin.updated", "plugin": plugin }));
    Ok(Json(plugin))
}

async fn delete_plugin(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> ApiResult<Json<Value>> {
    if !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')) || id.is_empty() {
        return Err(ApiError::bad_request("invalid plugin id"));
    }
    let root = state.chrono_home.join("plugins/installed").join(&id);
    if !root.is_dir() { return Err(ApiError::not_found("plugin not found")); }
    tokio::task::spawn_blocking(move || fs::remove_dir_all(&root))
        .await
        .map_err(|e| ApiError::internal(format!("plugin removal task failed: {e}")))?
        .map_err(|e| ApiError::internal(format!("remove plugin: {e}")))?;
    let result = reload_agent_plugins(&state).await?;
    publish_plugins(&state, &result);
    Ok(Json(json!({ "ok": true })))
}

async fn install_zip(State(state): State<Arc<AppState>>, mut multipart: Multipart) -> ApiResult<Json<Value>> {
    let mut archive = None;
    while let Some(field) = multipart.next_field().await.map_err(|e| ApiError::bad_request(format!("invalid multipart body: {e}")))? {
        if field.name() == Some("archive") {
            if archive.is_some() { return Err(ApiError::bad_request("only one archive field is allowed")); }
            let bytes = field.bytes().await.map_err(|e| ApiError::bad_request(format!("read archive: {e}")))?;
            if bytes.len() > MAX_ARCHIVE_BYTES { return Err(ApiError::bad_request("archive exceeds 20 MiB limit")); }
            archive = Some(bytes.to_vec());
        }
    }
    let archive = archive.ok_or_else(|| ApiError::bad_request("missing archive field"))?;
    let staging = staging_dir(&state);
    let plugin_dir = tokio::task::spawn_blocking(move || extract_zip(&archive, &staging))
        .await
        .map_err(|e| ApiError::internal(format!("zip extraction task failed: {e}")))??;
    finish_install(&state, plugin_dir).await.map(Json)
}

async fn install_github(State(state): State<Arc<AppState>>, Json(body): Json<GitHubInstallBody>) -> ApiResult<Json<Value>> {
    let repo = github_repo_url(&body.url)?;
    let git_ref = body.git_ref.filter(|value| !value.trim().is_empty());
    if git_ref.as_deref().is_some_and(|value| !value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))) {
        return Err(ApiError::bad_request("git_ref contains unsupported characters"));
    }
    let staging = staging_dir(&state);
    let plugin_dir = tokio::task::spawn_blocking(move || clone_github(&repo, git_ref.as_deref(), &staging))
        .await
        .map_err(|e| ApiError::internal(format!("git clone task failed: {e}")))??;
    finish_install(&state, plugin_dir).await.map(Json)
}

fn staging_dir(state: &AppState) -> PathBuf {
    state.chrono_home.join("plugins").join(".staging").join(uuid::Uuid::new_v4().to_string())
}

async fn finish_install(state: &AppState, plugin_dir: PathBuf) -> ApiResult<Value> {
    let manifest = plugin_dir.join("chrono.plugin.toml");
    let text = tokio::fs::read_to_string(&manifest).await.map_err(|_| ApiError::bad_request("archive/repository root must contain chrono.plugin.toml"))?;
    let id = toml_id(&text).ok_or_else(|| ApiError::bad_request("chrono.plugin.toml must contain a non-empty id"))?;
    let _version = toml_version(&text).ok_or_else(|| ApiError::bad_request("chrono.plugin.toml must contain a non-empty version"))?;
    let target = state.chrono_home.join("plugins/installed").join(&id);
    if target.exists() { return Err(ApiError::bad_request("plugin id is already installed")); }
    tokio::fs::create_dir_all(target.parent().unwrap()).await.map_err(|e| ApiError::internal(format!("create plugin directory: {e}")))?;
    tokio::fs::rename(&plugin_dir, &target).await.map_err(|e| ApiError::internal(format!("activate plugin: {e}")))?;
    let result = reload_agent_plugins(state).await?;
    publish_plugins(state, &result);
    Ok(result)
}

async fn reload_agent_plugins(state: &AppState) -> ApiResult<Value> {
    let response = state.query_agent(&json!({ "type": "plugin.reload" })).await.map_err(|e| ApiError::internal(format!("agent-host query failed: {e}")))?;
    host_result(response)
}

fn publish_plugins(state: &AppState, result: &Value) {
    if let Some(plugins) = result.get("plugins").and_then(Value::as_array) {
        for plugin in plugins { state.publish_ws(vec!["plugins".into()], json!({ "type": "plugin.updated", "plugin": plugin })); }
    }
}
fn github_repo_url(raw: &str) -> ApiResult<String> {
    let url = url::Url::parse(raw).map_err(|_| ApiError::bad_request("github URL is invalid"))?;
    if url.scheme() != "https" || url.host_str() != Some("github.com") || url.query().is_some() || url.fragment().is_some() {
        return Err(ApiError::bad_request("only clean https://github.com/owner/repo URLs are supported"));
    }
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))) {
        return Err(ApiError::bad_request("GitHub URL must be https://github.com/owner/repo"));
    }
    Ok(format!("https://github.com/{}/{}.git", parts[0], parts[1].trim_end_matches(".git")))
}

fn clone_github(repo: &str, git_ref: Option<&str>, staging: &Path) -> ApiResult<PathBuf> {
    std::fs::create_dir_all(staging).map_err(|e| ApiError::internal(format!("create staging: {e}")))?;
    let checkout = staging.join("plugin");
    let mut command = std::process::Command::new("git");
    command.arg("clone").arg("--depth").arg("1");
    if let Some(git_ref) = git_ref { command.arg("--branch").arg(git_ref); }
    let output = command.arg(repo).arg(&checkout).output().map_err(|e| ApiError::internal(format!("start git: {e}")))?;
    if !output.status.success() { return Err(ApiError::bad_request("git clone failed")); }
    Ok(checkout)
}

fn extract_zip(archive: &[u8], staging: &Path) -> ApiResult<PathBuf> {
    std::fs::create_dir_all(staging).map_err(|e| ApiError::internal(format!("create staging: {e}")))?;
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|_| ApiError::bad_request("invalid zip archive"))?;
    if zip.len() > MAX_ARCHIVE_ENTRIES { return Err(ApiError::bad_request("archive contains too many entries")); }
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(|_| ApiError::bad_request("read zip entry failed"))?;
        let enclosed = file.enclosed_name().ok_or_else(|| ApiError::bad_request("archive contains unsafe path"))?.to_owned();
        if enclosed.components().any(|component| !matches!(component, Component::Normal(_) | Component::CurDir)) { return Err(ApiError::bad_request("archive contains unsafe path")); }
        if file.is_dir() { continue; }
        total = total.saturating_add(file.size());
        if total > MAX_EXTRACTED_BYTES { return Err(ApiError::bad_request("archive exceeds 50 MiB extracted limit")); }
        let output = staging.join(&enclosed);
        if let Some(parent) = output.parent() { std::fs::create_dir_all(parent).map_err(|e| ApiError::internal(format!("create archive directory: {e}")))?; }
        let mut out = std::fs::File::create(&output).map_err(|e| ApiError::internal(format!("create archive file: {e}")))?;
        std::io::copy(&mut file, &mut out).map_err(|e| ApiError::internal(format!("extract archive file: {e}")))?;
    }
    let direct = staging.join("chrono.plugin.toml");
    if direct.exists() { return Ok(staging.to_path_buf()); }
    let dirs: Vec<_> = std::fs::read_dir(staging).map_err(|e| ApiError::internal(format!("read staging: {e}")))?.filter_map(Result::ok).filter(|entry| entry.file_type().ok().is_some_and(|kind| kind.is_dir())).collect();
    if dirs.len() == 1 && dirs[0].path().join("chrono.plugin.toml").exists() { return Ok(dirs[0].path()); }
    Err(ApiError::bad_request("archive must contain one plugin root with chrono.plugin.toml"))
}

fn toml_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| line.trim().strip_prefix(key)?.trim_start().strip_prefix('=')?.trim().strip_prefix('"')?.strip_suffix('"').map(ToOwned::to_owned))
}
fn toml_id(text: &str) -> Option<String> { toml_value(text, "id") }
fn toml_version(text: &str) -> Option<String> { toml_value(text, "version") }
