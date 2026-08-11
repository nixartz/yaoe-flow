// `yaoe-flow sync-souls`: re-imports the SOULs shipped with this binary into
// the installed database. Needed after an upgrade that changes agent behavior —
// the first-boot seed only runs on an empty `agents` table, so an existing
// install keeps dispatching the old prompt until this runs.
//
// Always asks before writing (it replaces the ACTIVE SOUL of each role);
// --yes skips the question for scripted upgrades. The previous SOUL is kept in
// the agent's version history either way.
import { flagBool, flagStr } from "./args";

function statusLine(label: string, detail: string): string {
  return `  ${label.padEnd(14)}${detail}`;
}

function lines(n: number | null): string {
  return `${n ?? 0} line${n === 1 ? "" : "s"}`;
}

export async function cmdSyncSouls(flags: Record<string, string | boolean>): Promise<void> {
  const { planSoulSync, applySoulSync, isSyncable, parseRoleFilter } = await import("../agent/soulSync");
  const { confirm } = await import("./setup/prompt");

  let roles;
  try {
    roles = parseRoleFilter(flagStr(flags, "role"));
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const plan = planSoulSync(roles);
  const outdated = plan.filter(isSyncable);

  console.log("SOULs bundled with this binary vs. the database:\n");
  for (const entry of plan) {
    const agent = entry.agentName ? `"${entry.agentName}"` : "—";
    switch (entry.status) {
      case "outdated":
        console.log(
          statusLine(
            entry.role,
            `⚠️  outdated — ${agent} v${entry.currentVersion} (${entry.currentHash}, ${lines(entry.currentLines)}) → v${entry.nextVersion} (${entry.seedHash}, ${lines(entry.seedLines)})`
          )
        );
        break;
      case "up-to-date":
        console.log(statusLine(entry.role, `✅ up to date — ${agent} v${entry.currentVersion} (${entry.currentHash})`));
        break;
      case "no-agent":
        console.log(statusLine(entry.role, "— no active agent for this role (nothing to update)"));
        break;
      case "no-seed":
        console.log(statusLine(entry.role, `❌ agents/${entry.soulFile} is not bundled in this binary`));
        break;
    }
  }

  if (outdated.length === 0) {
    const allCurrent = plan.every((e) => e.status === "up-to-date");
    console.log(
      allCurrent
        ? "\n✅ Nothing to do — every role already runs the bundled SOUL."
        : "\n✅ Nothing to update — no active SOUL diverges from the bundled one."
    );
    return;
  }

  console.log(
    `\n${outdated.length} role(s) would get a NEW ACTIVE version from the bundled seed.` +
      "\nThe current SOUL of each one is kept in the agent's history (dashboard → Agents → versions) and can be reactivated." +
      "\nLocal edits made on the dashboard are NOT merged — the bundled text replaces the active version."
  );

  if (!flagBool(flags, "yes") && !flagBool(flags, "y")) {
    if (!process.stdin.isTTY) {
      console.error("\n❌ Not a TTY and --yes was not passed — refusing to replace the active SOULs without confirmation.");
      process.exitCode = 1;
      return;
    }
    const ok = await confirm("\nApply the bundled SOULs now?", false);
    if (!ok) {
      console.log("Aborted — nothing was written.");
      return;
    }
  }

  const applied = applySoulSync({ roles, createdBy: null, source: "CLI" });
  console.log("");
  for (const a of applied) {
    console.log(`✅ ${a.role}: "${a.agentName}" v${a.previousVersion} → v${a.newVersion} (previous version kept in history)`);
  }
  console.log(
    `\n${applied.length} SOUL(s) updated. No restart needed — the next dispatch already uses the new version.`
  );
}
