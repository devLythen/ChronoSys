// Gateway binary — thin entry point.
// For real adapter-driven operation, use `chrono up` (chrono-cli).
// This binary exists for direct `cargo run -p chrono-gateway` testing.
//
// Running without adapters: the gateway starts but has nothing to poll.
// Use chrono-cli (`chrono up`) for full Telegram adapter support.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono_gateway::adapter::PlatformAdapter;
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

    let adapters: HashMap<String, Arc<dyn PlatformAdapter>> = HashMap::new();
    let bindings: HashMap<String, Vec<chrono_config::Binding>> = HashMap::new();
    let bot_profiles: HashMap<String, chrono_config::BotProfile> = HashMap::new();

    let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
    rt.block_on(run_gateway(
        chrono_home,
        fake_llm,
        bun_path,
        agent_host_dir,
        adapters,
        bindings,
        bot_profiles,
    ))
    .expect("gateway failed");
}
