use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use chrono_config::ConfigStore;
use chrono_gateway::adapter::PlatformAdapter;
use chrono_gateway::runner::run_gateway;
use chrono_gateway::{find_bun, resolve_agent_host_dir};
use chrono_adapter_telegram::TelegramAdapter;
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
    /// Start the full gateway (spawn agent-host + adapters)
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

fn run_up(fake_llm: bool) -> Result<()> {
    let chrono_home = std::env::var("CHRONO_HOME").unwrap_or_else(|_| ".chrono".into());
    let chrono_home = PathBuf::from(chrono_home);

    let bun_path = find_bun().context("bun is required on PATH for agent-host")?;
    let agent_host_dir = resolve_agent_host_dir().context("agent-host dir")?;

    // Open config DB, load accounts + bindings + bot profiles
    let db_path = chrono_home.join("state/chrono.db");
    std::fs::create_dir_all(db_path.parent().unwrap()).context("create state dir")?;
    let store = ConfigStore::open(&db_path).context("open config DB")?;

    let accounts = store
        .accounts()
        .list_enabled_accounts()
        .context("list enabled accounts")?;
    if accounts.is_empty() {
        eprintln!("[chrono] No enabled accounts. Seed the DB and retry.");
        eprintln!("[chrono] Gateway will start but has no adapters to poll.");
    }

    let mut bindings_by_account: HashMap<String, Vec<chrono_config::Binding>> = HashMap::new();
    let mut bot_profiles: HashMap<String, chrono_config::BotProfile> = HashMap::new();

    for account in &accounts {
        let bindings = store
            .bots()
            .list_bindings_for_account(&account.id)
            .context("list bindings")?;
        bindings_by_account.insert(account.id.clone(), bindings);
    }
    for bindings in bindings_by_account.values() {
        for b in bindings {
            if !bot_profiles.contains_key(&b.bot_profile_id) {
                if let Ok(bp) = store.bots().get_bot(&b.bot_profile_id) {
                    bot_profiles.insert(b.bot_profile_id.clone(), bp);
                }
            }
        }
    }

    // Build adapters
    let mut adapters: HashMap<String, Arc<dyn PlatformAdapter>> = HashMap::new();
    for account in &accounts {
        match account.platform.as_str() {
            "telegram" => {
                let token = resolve_secret(&account.secret_ref)
                    .with_context(|| format!("resolve secret for account {}", account.id))?;
                let bot_username = account
                    .adapter_config_json
                    .get("bot_username")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown_bot")
                    .to_string();
                adapters.insert(
                    account.id.clone(),
                    Arc::new(TelegramAdapter::new(token, account.id.clone(), bot_username)),
                );
            }
            other => {
                eprintln!(
                    "[chrono] skipping unsupported platform '{other}' for account {}",
                    account.id
                );
            }
        }
    }

    eprintln!("[chrono] loaded {} account(s), {} adapter(s)", accounts.len(), adapters.len());

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        fake_llm,
        bun_path,
        agent_host_dir,
        adapters,
        bindings_by_account,
        bot_profiles,
    ))
}

fn resolve_secret(secret_ref: &str) -> Result<String> {
    if let Some(env_var) = secret_ref.strip_prefix("env:") {
        std::env::var(env_var).with_context(|| format!("environment variable {env_var} not set"))
    } else if let Some(path) = secret_ref.strip_prefix("file:") {
        Ok(std::fs::read_to_string(path)
            .with_context(|| format!("read secret file {path}"))?
            .trim()
            .to_string())
    } else {
        Ok(secret_ref.to_string())
    }
}
