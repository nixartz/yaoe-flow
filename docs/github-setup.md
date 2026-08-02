# GitHub setup

How to give YAOE-FLOW access to the repositories it will work on.

## Summary

- [What the token is used for](#what-the-token-is-used-for)
- [Option A — Fine-grained PAT (recommended)](#option-a--fine-grained-pat-recommended)
- [Option B — Classic PAT](#option-b--classic-pat)
- [Option C — GitHub App](#option-c--github-app)
- [Authorized orgs (anti-fork fail-safe)](#authorized-orgs-anti-fork-fail-safe)
- [How agents authenticate git](#how-agents-authenticate-git)

## What the token is used for

- The **service** reads PR file lists (deterministic scope-check) and comments
  rejections.
- The **agents** clone, branch, push and open/merge PRs (the token is injected
  into each run's environment and git credential helper, and forwarded to the
  GitHub MCP as `GITHUB_PERSONAL_ACCESS_TOKEN`).

## Option A — Fine-grained PAT (recommended)

Create at https://github.com/settings/personal-access-tokens/new

- **Resource owner**: the org/user that owns the target repos.
- **Repository access**: *Only select repositories* — pick the repos the
  agents will work on.
- **Repository permissions** (the only ones actually needed):
  - **Contents: Read and write** (clone, branch, push, merge)
  - **Pull requests: Read and write** (open, review-comment, merge PRs)
  - **Metadata: Read-only** (added automatically)

Everything else can stay "No access". Set an expiration you are comfortable
rotating.

## Option B — Classic PAT

Create at https://github.com/settings/tokens/new with the **`repo`** scope.
Note a classic PAT grants access to **all** repos the user can reach — prefer
Option A.

## Option C — GitHub App

For org-wide installs with short-lived installation tokens, configure a GitHub
App connection on the dashboard (Linear Connections / GitHub auth section):
App ID + private key + installation. The service then mints installation
tokens per run and commits are attributed to the bot identity. Required App
permissions mirror Option A (Contents RW, Pull requests RW, Metadata R).

## Authorized orgs (anti-fork fail-safe)

`AGENT_AUTHORIZED_ORGS` (comma-separated owners) is a hard allowlist: when
set, no PR from an owner outside the list passes the scope-check, even if a
(possibly manipulated) issue points elsewhere. Recommended for any real
deployment.

## How agents authenticate git

Per run, the harness environment receives the token via
`url.https://x-access-token:<token>@github.com/.insteadOf` git config — the
agent never sees a long-lived credential file, `~/.git-credentials` of the
host is never exposed, and each run's HOME is isolated (see
[harnesses.md](harnesses.md)).
