// ChronoSys — single entry point.
// Start with: cargo run -p chrono-sys
// Or after install: chrono

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::Context;
use chrono_config::ConfigStore;
use chrono_gateway::http::{resolve_bind, HttpOptions};
use chrono_gateway::runner::run_gateway;
use chrono_gateway::{find_bun, resolve_agent_host_dir};
use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "chrono",
    version,
    about = "ChronoSys gateway: chat adapters, agent host, and WebUI control plane.",
    long_about = "ChronoSys connects chat platforms to tool-calling AI agents. \
                  This process starts the gateway, spawns agent-host, and serves the WebUI.",
    after_help = "Environment fallbacks:\n  \
        CHRONO_HOME          state directory (default: ./.chrono)\n  \
        CHRONO_API_HOST      bind host (default: 127.0.0.1)\n  \
        CHRONO_API_PORT      bind port (default: 8787)\n  \
        CHRONO_WEBUI_DIST    built WebUI directory (default: webui/dist)\n\n\
        --host overrides CHRONO_API_HOST/CHRONO_API_PORT."
)]
struct Cli {
    /// Bind address for WebUI/API, for example 0.0.0.0:8787.
    #[arg(long, value_name = "IP:PORT")]
    host: Option<SocketAddr>,

    /// State directory containing config DB, sessions, logs, and sandboxes.
    #[arg(long, value_name = "DIR")]
    home: Option<PathBuf>,

    /// Directory containing the built WebUI index.html and assets.
    #[arg(long, value_name = "DIR")]
    webui_dist: Option<PathBuf>,

}

fn main() {
    let cli = Cli::parse();
    if let Err(err) = run(cli) {
        eprintln!("\x1b[31;1m[chrono]\x1b[0m {err:#}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
    let chrono_home = cli
        .home
        .or_else(|| std::env::var("CHRONO_HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(".chrono"));

    std::fs::create_dir_all(chrono_home.join("state")).context("create state dir")?;
    let chrono_home = chrono_home
        .canonicalize()
        .unwrap_or_else(|_| chrono_home.clone());

    let http_options = HttpOptions {
        bind: cli.host,
        webui_dist: cli.webui_dist,
    };
    // Fail before spawning agent-host when the bind address is invalid.
    resolve_bind(&http_options).context("validate control-plane options")?;

    let bun_path = find_bun().context("bun is required on PATH for agent-host")?;
    let agent_host_dir = resolve_agent_host_dir().context("agent-host dir")?;

    let db_path = chrono_home.join("state/chrono.db");
    let store = ConfigStore::open(&db_path).context("open config DB")?;
    let public_url = store
        .settings()
        .get("server.public_url")
        .ok()
        .flatten()
        .and_then(|setting| {
            setting
                .value_json
                .as_str()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(ToOwned::to_owned)
        });

    eprintln!(
        "\x1b[36m[chrono]\x1b[0m starting (CHRONO_HOME={})",
        chrono_home.display()
    );
    match public_url.as_deref() {
        Some(url) => eprintln!("\x1b[36m[chrono]\x1b[0m configure via WebUI → {url}"),
        None => eprintln!(
            "\x1b[36m[chrono]\x1b[0m configure via WebUI → {}",
            bind_hint(http_options.bind)
        ),
    }

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        bun_path,
        agent_host_dir,
        store,
        http_options,
    ))
    .context("gateway failed")
}


fn bind_hint(bind: Option<SocketAddr>) -> String {
    let addr = bind
        .or_else(|| {
            let host = std::env::var("CHRONO_API_HOST").unwrap_or_else(|_| "127.0.0.1".into());
            let port = std::env::var("CHRONO_API_PORT").unwrap_or_else(|_| "8787".into());
            format!("{host}:{port}").parse().ok()
        })
        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8787));
    let display_ip = if addr.ip().is_unspecified() {
        match addr.ip() {
            IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
        }
    } else {
        addr.ip()
    };
    format!("http://{}", SocketAddr::new(display_ip, addr.port()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli() -> Cli {
        Cli {
            host: None,
            home: None,
            webui_dist: None,
        }
    }

    #[test]
    fn bind_hint_rewrites_wildcard_addresses() {
        assert_eq!(
            bind_hint(Some("0.0.0.0:9000".parse().unwrap())),
            "http://127.0.0.1:9000"
        );
        assert_eq!(
            bind_hint(Some("[::]:9000".parse().unwrap())),
            "http://[::1]:9000"
        );
    }
}
