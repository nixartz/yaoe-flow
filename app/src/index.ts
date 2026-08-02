// Entrypoint. Deliberately THIN — only argv parsing and two dynamic imports,
// with NO static import of any application module. Reason: scheduler.ts reads
// `config.states` at module TOP-level (outside any function), which requires a
// valid database + APP_ENCRYPTION_KEY just from scheduler.ts being IMPORTED —
// and ./server imports scheduler.ts. If this file imported ./server
// statically, light CLI commands such as `yaoe-flow version` (which must run
// BEFORE `yaoe-flow setup` ever happened) would break on binary invocation.
//
// Without argv (Docker: `CMD ["bun", "src/index.ts"]`) → imports ./server and
// boots the service directly. With a recognized argv (compiled binary invoked
// as `yaoe-flow <command>`, or dev via `bun src/index.ts <command>`) →
// delegates to the CLI dispatcher.
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const { bootServer } = await import("./server");
    bootServer();
  } else {
    const { runCli } = await import("./cli");
    await runCli(args);
  }
}
