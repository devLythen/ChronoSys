use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono_config::ConfigStore;
use chrono_gateway::runner::run_gateway;
use chrono_gateway::{find_bun, resolve_agent_host_dir};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "chrono",
    version,
    about = "Agent-centric chat integration framework"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Print the chrono version
    Version,
    /// Start the control plane + agent-host (adapters attach from WebUI config)
    Up {
        /// Use the canned fake LLM (no API key required)
        #[arg(long)]
        fake_llm: bool,
    },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Version => {
            println!("chrono {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Commands::Up { fake_llm } => run_up(fake_llm),
    }
}

/// Start the gateway control plane.
///
/// Does **not** resolve platform tokens or start adapters itself. Secrets and
/// accounts are managed via WebUI → config DB; the gateway syncs adapters from DB
/// on boot and on every config reload.
fn run_up(fake_llm: bool) -> Result<()> {
    let chrono_home = std::env::var("CHRONO_HOME").unwrap_or_else(|_| ".chrono".into());
    let chrono_home = PathBuf::from(chrono_home);

    std::fs::create_dir_all(chrono_home.join("state")).context("create state dir")?;
    let chrono_home = chrono_home.canonicalize().unwrap_or_else(|_| chrono_home.clone());

    let bun_path = find_bun().context("bun is required on PATH for agent-host")?;
    let agent_host_dir = resolve_agent_host_dir().context("agent-host dir")?;

    let db_path = chrono_home.join("state/chrono.db");

    let store = ConfigStore::open(&db_path).context("open config DB")?;

    eprintln!(
        "[chrono] starting control plane (CHRONO_HOME={})",
        chrono_home.display()
    );
    eprintln!("[chrono] configure accounts/bots/bindings in WebUI — no env tokens required to boot");

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        fake_llm,
        bun_path,
        agent_host_dir,
        store,
    ))
}
