# Sandbox — real-harness smoke test

> Requirement: tests AGAINST the real CLI/binary, one per harness, outside CI (needs credentials and CLIs installed on the operator's machine). The contract suite (`bun test`, mock ACP) already covers client/normalization/liveness logic at no LLM cost — this is the human confidence step before activating a new harness in production.

## Prerequisites

1. **A sandbox repository** on GitHub — a small, disposable repo (not a real product repo) where agents can clone, branch and open a PR risk-free. Create an empty `sandbox-orchestrator` in your test account/org.
2. **A sandbox team in Linear** with the standard workflow (`To Do`, `Refining`, `Planned`, `In Progress`, `Code Review`, `In Review`, `Pending Merge`, `Reopened`, `Completed`, `Blocked` — see `STATE_*` in `.env.example`) and the `ready-to-refine`/`ready-to-implement`/`ready-to-merge` labels.
3. **A test issue** in that team, describing a trivial, safe task (e.g. "add a comment to the README explaining the repo's purpose").
4. The harness under test **installed and logged in / with an API key** on the operator's machine (see the Harness screen → detection/instructions per harness).
5. `app/`'s `.env` pointing at the sandbox team/repo (`LINEAR_TEAM_ID`, `AGENT_AUTHORIZED_ORGS` including the sandbox repo's org).

## Minimal script per harness

With the service running (`bun run dev` in `app/`) and the sandbox issue carrying the `ready-to-refine` label:

1. **detect** — the Harness screen confirms the harness under test is installed + logged in.
2. **planning** — move/wait for the issue to enter `Refining`; confirm the footprint was estimated (dashboard → History → the PMO run).
3. **implement** — with `ready-to-implement` on the `Planned` issue, wait for the dev dispatch (or use **manual dispatch** on the Live screen); confirm the PR was opened in the sandbox repo and its link attached to the issue.
4. **review + merge** — follow the cycle through to `Completed`; check `costSource`/tokens/external refs in the RunDetailSheet.
5. **kill mid-run on a second run** — trigger a new dispatch (`fix` mode, reopening the issue) and use the "Stop" button on the RunDetailSheet while the run is `running`; confirm the process dies (harness with `capabilities.kill`) and that reclaim/circuit-breaker react on the next tick.

Record the result (CLI version tested, quirks observed) in the dashboard or your own notes — the old `docs/harness-notes.md` reference was pre-extraction; port it back if you need a durable log.

## Why this does not run in CI

It needs: an installed and authenticated CLI (personal accounts), real Linear/GitHub credentials, and it produces real effects on a repository (branch, PR) — exactly what CI is meant to avoid. The contract suite (`bun test`) is the safe CI substitute; this script is the manual complement before promoting a new harness to production.
