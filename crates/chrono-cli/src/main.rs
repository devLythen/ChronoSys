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
}

fn main() {
    // Keep chrono-ipc linked so the workspace dep stays intentional in M0.
    let _ = chrono_ipc::MAX_FRAME_BYTES;

    let cli = Cli::parse();
    match cli.command {
        Commands::Version => {
            println!("chrono {}", env!("CARGO_PKG_VERSION"));
        }
    }
}
