// Gateway binary — thin entry point.
// Prefer `chrono up` (chrono-cli). Same boot path: control plane only;
// adapters attach from config DB / WebUI.

use std::path::PathBuf;

use chrono_config::ConfigStore;
use chrono_gateway::runner::run_gateway;
use chrono_gateway::{find_bun, resolve_agent_host_dir};

fn main() {
    let chrono_home = std::env::var("CHRONO_HOME").unwrap_or_else(|_| ".chrono".into());
    let chrono_home = PathBuf::from(chrono_home);
    let fake_llm = std::env::var("CHRONO_FAKE_LLM").is_ok();

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
    std::fs::create_dir_all(db_path.parent().unwrap()).expect("create state dir");
    let store = ConfigStore::open(&db_path).expect("open config DB");

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        fake_llm,
        bun_path,
        agent_host_dir,
        store,
    ))
    .expect("gateway failed");
}
