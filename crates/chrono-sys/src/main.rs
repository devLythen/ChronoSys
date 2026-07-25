// ChronoSys — single entry point.
// Start with: cargo run -p chrono-sys
// Or after install: chrono

use std::path::PathBuf;

use anyhow::Context;
use chrono_config::ConfigStore;
use chrono_gateway::runner::run_gateway;
use chrono_gateway::{find_bun, resolve_agent_host_dir};

fn main() {
    if let Err(err) = run() {
        eprintln!("chrono: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let chrono_home = std::env::var("CHRONO_HOME").unwrap_or_else(|_| ".chrono".into());
    let chrono_home = PathBuf::from(chrono_home);

    std::fs::create_dir_all(chrono_home.join("state")).context("create state dir")?;
    let chrono_home = chrono_home
        .canonicalize()
        .unwrap_or_else(|_| chrono_home.clone());

    let bun_path = find_bun().context("bun is required on PATH for agent-host")?;
    let agent_host_dir = resolve_agent_host_dir().context("agent-host dir")?;

    let db_path = chrono_home.join("state/chrono.db");
    let store = ConfigStore::open(&db_path).context("open config DB")?;

    eprintln!(
        "[chrono] starting (CHRONO_HOME={})",
        chrono_home.display()
    );
    eprintln!("[chrono] configure via WebUI → http://127.0.0.1:8787");

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        bun_path,
        agent_host_dir,
        store,
    ))
    .context("gateway failed")
}
