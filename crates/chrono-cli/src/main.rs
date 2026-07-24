use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use chrono_gateway::GatewayMock;
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
    /// Run the M1 vertical-slice demo (spawn agent-host + mock gateway)
    Dev {
        /// Inbound message text injected into the agent
        #[arg(short, long, default_value = "Hello, send a greeting!")]
        message: String,
        /// Session key for the injected message
        #[arg(long, default_value = "dm_test")]
        session: String,
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
        Commands::Dev {
            message,
            session,
            fake_llm,
        } => run_dev(message, session, fake_llm),
    }
}

fn run_dev(message: String, session: String, fake_llm: bool) -> Result<()> {
    let chrono_home = std::env::var("CHRONO_HOME").unwrap_or_else(|_| ".chrono".into());
    let chrono_home = PathBuf::from(chrono_home);
    std::fs::create_dir_all(chrono_home.join("sessions"))
        .with_context(|| format!("create sessions dir under {}", chrono_home.display()))?;

    let bun_path = find_bun().context("bun is required on PATH for agent-host")?;
    let agent_host_dir = resolve_agent_host_dir()?;

    let mut gw = GatewayMock::spawn(&bun_path, &agent_host_dir, &chrono_home, fake_llm)
        .with_context(|| {
            format!(
                "spawn agent-host from {}",
                agent_host_dir.display()
            )
        })?;

    gw.inject_message(&message, &session)
        .context("inject inbound message")?;
    gw.run_loop().context("gateway run loop")?;

    println!(
        "Demo complete. Fake LLM: {}. Message: {:?}",
        if fake_llm { "yes" } else { "no" },
        message
    );
    Ok(())
}

fn find_bun() -> Result<String> {
    // Prefer explicit env override, then PATH lookup via `which`-style spawn.
    if let Ok(path) = std::env::var("CHRONO_BUN") {
        return Ok(path);
    }
    // Command::new will resolve via PATH on spawn; verify it exists first.
    let output = Command::new("bun")
        .arg("--version")
        .output()
        .context("failed to execute `bun --version`")?;
    if !output.status.success() {
        bail!("`bun --version` failed");
    }
    Ok("bun".to_string())
}

fn resolve_agent_host_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("CHRONO_AGENT_HOST_DIR") {
        let p = PathBuf::from(dir);
        if p.join("src/main.ts").exists() {
            return Ok(p);
        }
        bail!(
            "CHRONO_AGENT_HOST_DIR does not contain src/main.ts: {}",
            p.display()
        );
    }

    // Dev layout: crates/chrono-cli -> ../../agent-host
    let from_manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../agent-host");
    let canonical = from_manifest
        .canonicalize()
        .with_context(|| format!("resolve agent-host at {}", from_manifest.display()))?;
    if !canonical.join("src/main.ts").exists() {
        bail!(
            "agent-host main.ts not found at {}",
            canonical.join("src/main.ts").display()
        );
    }
    Ok(canonical)
}
