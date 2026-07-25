// ChronoSys control plane — single binary entry point.
// Start with: cargo run -p chrono-gateway

use std::path::PathBuf;

use chrono_config::ConfigStore;
use chrono_gateway::runner::run_gateway;
use chrono_gateway::{find_bun, resolve_agent_host_dir};

fn main() {
    let chrono_home = std::env::var("CHRONO_HOME").unwrap_or_else(|_| ".chrono".into());
    let chrono_home = PathBuf::from(chrono_home);

    // Create state dir early so we can canonicalize. Agent-host runs with
    // a different CWD, so CHRONO_HOME must be an absolute path.
    std::fs::create_dir_all(chrono_home.join("state")).expect("create state dir");
    let chrono_home = chrono_home.canonicalize().unwrap_or_else(|_| {
        eprintln!("[gateway] warning: cannot canonicalize CHRONO_HOME, using as-is");
        chrono_home.clone()
    });


    let bun_path = match find_bun() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[gateway] {e:#}");
            std::process::exit(1);
        }
    };
    let agent_host_dir = match resolve_agent_host_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[gateway] {e:#}");
            std::process::exit(1);
        }
    };

    let db_path = chrono_home.join("state/chrono.db");
    let store = ConfigStore::open(&db_path).expect("open config DB");

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        bun_path,
        agent_host_dir,
        store,
    ))
    .expect("gateway failed");
}
