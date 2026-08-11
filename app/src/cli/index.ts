// `yaoe-flow` CLI: a single binary with subcommands. Called from
// app/src/index.ts when process.argv has args (see comment there) — without
// args, index.ts boots the server directly (compat with Docker's
// `bun src/index.ts`, which never passes argv).
import { parseArgs } from "./args";

const COMMANDS = [
  "setup",
  "daemon",
  "status",
  "doctor",
  "stop",
  "update",
  "version",
  "install-local",
  "sync-souls",
] as const;
type Command = (typeof COMMANDS)[number];

function isKnownCommand(c: string | undefined): c is Command {
  return (COMMANDS as readonly string[]).includes(c ?? "");
}

function printHelp(): void {
  console.log(`yaoe-flow — YAOE-FLOW (Yet Another Orchestration Engine-Flow)

Usage: yaoe-flow <command> [flags]

Commands:
  setup [--systemd|--launchd] [--install-local] [--install-harness] [--non-interactive --config <file>]
      First run: guided setup wizard. After that: navigable configuration menu
      (view current settings, edit sections). --non-interactive reads answers
      from a KEY=VALUE file instead of prompting.
  daemon [-d]
      Starts the service (API + scheduler + dashboard). -d = detach (fork + PID
      file). Refuses to start until "yaoe-flow setup" has completed once.
  status
      Quick health summary: daemon, API, Valkey, scheduler, Linear, GitHub,
      webhook, harnesses.
  doctor [--offline]
      Deep diagnosis with a fix instruction per item. --offline skips network
      calls (Valkey/Linear/GitHub).
  stop [--force]
      Stops the daemon (graceful by default; --force kills immediately).
  update
      Checks the latest release and prints the update path.
  sync-souls [--role <role[,role]>] [--yes]
      Re-imports the SOULs bundled with this binary into the database, creating
      a new ACTIVE version for each role whose SOUL changed (the previous one
      stays in the agent's history). Shows the plan and asks before writing —
      run it after an upgrade that changes agent behavior.
  install-local [--skip-dashboard] [--dir <path>] [--yes]
      Compiles the binary for this machine from source and installs it into
      ~/.local/bin (only works inside a clone of the repo).
  version
      Version + commit + platform.
`);
}

export async function runCli(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (!isKnownCommand(command)) {
    console.error(`yaoe-flow: unknown command "${command}"\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "setup":
      return (await import("./setup")).cmdSetup(flags);
    case "daemon":
      return (await import("./daemon")).cmdDaemon(flags);
    case "status":
      return (await import("./status")).cmdStatus();
    case "doctor":
      return (await import("./doctor")).cmdDoctor(flags);
    case "stop":
      return (await import("./stop")).cmdStop(flags);
    case "update":
      return (await import("./update")).cmdUpdate();
    case "version":
      return (await import("./version")).cmdVersion();
    case "install-local":
      return (await import("./install-local")).cmdInstallLocal(flags);
    case "sync-souls":
      return (await import("./sync-souls")).cmdSyncSouls(flags);
  }
}
