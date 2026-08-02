# Agent Communication Protocol

Document shared by **all** agents (Orchestrator, PMO, Dev, Reviewer).
Defines how they communicate progress, ask for help, and report success/error —
with full traceability of **who** did **what** and **when**.

> The SOULs reference this protocol. If you change something here, it applies to all of them.

---

## 1. Agent identity (mandatory in every comment)

Each agent has a fixed identity:

| Agent | `AGENT_ID` | `AGENT_NAME` |
|---|---|---|
| Orchestrator | `orchestrator` | Orchestrator |
| PMO (instance) | `pmo-01`, … | PMO |
| Worker (instance) | `dev-w1`, `-w2`, … | Dev |
| Reviewer (instance) | `reviewer-01`, … | Reviewer |

> The worker/reviewer instance's `AGENT_ID` comes from an environment variable at
> the moment Hermes is dispatched (e.g. `AGENT_ID=dev-w1`), so that two
> parallel workers are distinguishable in comments.

## 2. Standard header

**Every** comment (Linear or PR) starts with this line:

```
🤖 **{AGENT_NAME}** · `{AGENT_ID}` · {YYYY-MM-DD HH:mm UTC} · {PHASE}
```

Example:

```
🤖 **Dev** · `dev-w1` · 2026-06-27 14:32 UTC · Implementação
```

`{PHASE}` ∈ `Refining` · `Planning` · `Implementação` · `Correção` · `Code Review` · `Merge`
(agents) · `Scope-check` · `Reliability` (posted by the **orchestration service**:
deterministic scope-check, and retries/circuit-breaker/stuck-seat reclaim).

> The `{PHASE}` values themselves are literal tokens written into a PT-BR comment
> (§7) — some are English loanwords already common in this team's usage
> (`Refining`, `Planning`, `Code Review`, `Merge`), others are in Portuguese
> (`Implementação`, `Correção`) because that's the actual word the team reads.
> This is output content, not an instruction — keep it exactly as listed here.

Never post an anonymous comment. Always use **UTC, ISO-like** date/time.

## 3. Message types (emoji prefix, for quick reading)

| Prefix | Type | When to use |
|---|---|---|
| ▶️ | **Start / Progress** | started; moved to a new step; partial status |
| ✅ | **Success / Done** | finished the phase successfully |
| ⚠️ | **Problem** | recoverable error, a breaking test, something you tried to resolve |
| 🛑 | **Blocker** | an error that stops you from continuing (not recoverable on your own) |
| 🙋 | **Need help** | need a human decision/information → see §5 |
| 📝 | **Decision / Note** | recorded a relevant choice (e.g. merged 2 tasks into one PR) |
| 🚧 | **Out of scope** | flags scope leakage: file(s) outside the declared footprint. Used by the service's **deterministic scope-check** and by the **Reviewer** when auditing the diff. Comes with the list of files/lines outside `## Footprint`. **Feature/module code** outside the footprint generally leads to `Reopened`. **Ancillary paths** (lockfiles, toolchain/config manifests, justified test companions — see §8.1) are **not** automatic rejection: the Reviewer judges intent; do not treat every 🚧 as a hard fail. |

## 4. Where to comment

| Situation | Linear (issue) | PR (GitHub) |
|---|---|---|
| Starting work | ✅ | — |
| PR opened / updated | ✅ (with link) | ✅ |
| Relevant progress | ✅ | optional |
| Review findings | ✅ (summary) | ✅ (detail, inline when possible) |
| Review verdict | ✅ | ✅ |
| Merge result | ✅ | ✅ |
| Help request | ✅ | ✅ if it's about the code |
| Error/blocker | ✅ | ✅ if it's about the code |

General rule: **Linear is the source of truth** — always comment there. The PR
gets whatever is code-specific.

## 5. "Need help" flow (🙋)

When information or a decision that **only a human** can give is missing, the
agent **does not guess**. It:

1. Posts a 🙋 comment on Linear (and on the PR, if it's about code) containing:
   - The **context** (what you were doing).
   - The **specific question**, ideally with options (A/B) so the human just picks one.
   - What is **blocking** progress.
2. Moves the issue to **`Blocked`**.
3. **Stops.** Does not implement assumptions.

When the human answers in the comments and moves the issue back to
**`Reopened`**, the pipeline reabsorbs the task (re-dispatched in fix mode, with
the branch and context already in place).

## 6. Comment body (structure)

```
🤖 **{AGENT_NAME}** · `{AGENT_ID}` · {UTC date} · {PHASE}

{PREFIX} {one-line summary}

{details: what was done / what's left / findings}

— Task: {IDENTIFIER}  ·  PR: {full url}  ·  Branch: {branch}  ·  Commit: {short sha}
```

The last line (metadata) is **mandatory** whenever there's a PR/branch/commit —
it's what guarantees end-to-end traceability.

> **The PR URL goes in full** (`https://github.com/{owner}/{repo}/pull/{n}`), not
> just `#{n}`. Besides attaching the link to the issue, this is what lets the
> service discover the PR from the comment if the attachment hasn't propagated yet
> (scope-check fallback).

> **Bidirectional linking (Issue ↔ PR) — MANDATORY when opening or updating a PR.**
> Always put the **full** Linear issue URL in the PR body (near the top), taken
> from the issue's `url` field via Linear MCP — never invent the workspace slug:
> `Linear: https://linear.app/{workspace}/issue/{IDENTIFIER}`
> (list every issue URL if several tasks share the PR). Identifier-only shortcuts
> (`Closes ENG-123`, `ENG-123`) are **not** enough — GitHub cannot resolve Linear
> ids. This is the inverse of attaching the PR URL on Linear: Issue→PR already
> works via attachment/comment; PR→Issue back-tracking needs the URL in the PR
> description.

## 7. Language

Comments aimed at the team (Linear comments, PR descriptions, review verdicts)
are written in **{{OUTPUT_LANGUAGE}}** — configured by the operator via the
AGENT_OUTPUT_LANGUAGE setting. (The SOULs themselves are in English by prompt
convention; only the human-facing output follows the configured language.)

## 8. Context and scope isolation (anti-contamination) — INVIOLABLE

Each agent works on **ONE** issue at a time, within **its own context**: the
team, the project, and what is **explicit** in that issue's description/metadata.
It is **forbidden** to pull information from other teams, projects, issues, or
systems.

1. **The source of truth is the issue itself.** Use only what is explicit in the
   description, in the metadata (team, project, labels, priority), and in the
   **relations declared on this** issue. **Never** import repositories, paths,
   requirements, or decisions from other issues/projects/teams, nor from external
   systems (Asana, Notion, another workspace) — unless **this** issue explicitly
   references them (a `blockedBy`/`blocks`/`relatedTo` relation, or an inline
   `<issue>` reference **in this** issue).
2. **Respect `TBD` / empty fields.** A field marked `TBD`, `?`, empty, or ambiguous
   (e.g. `## Onde`, `## Footprint`, an acceptance criterion) is **not an invitation
   to guess**. Don't fill it in by speculation or by analogy with other projects —
   leave it as is and flag `🙋` (→ `Blocked`). Guessing here is worse than asking.
3. **A relation ≠ importing scope.** Reading a related issue (via a relation
   declared on this issue) is only for establishing **dependency/direction** —
   never for copying its repos, paths, or requirements into this task.
4. **No "similarity" searches.** Don't sweep the workspace for tasks that "look
   similar" and assume relevance. Textual similarity is not a link.
5. **When unsure whether something belongs, ask.** If you can't determine
   something from **this** issue's own context, it's `🙋` + `Blocked` — don't
   infer from outside.
6. **An off-topic comment is noise, not context.** If a comment on the issue talks
   about something clearly different from its own title/description (e.g. the
   issue is about a CRM and a comment discusses a different system/project), it
   **probably isn't related** — don't fold it into your work on your own. If
   you're not sure whether it's noise or a legitimate scope update, **don't decide
   alone**: flag the divergence in a comment (what you read, why it stood out) and
   **abort the change in progress**, going to `🙋` + `Blocked` until a human
   clarifies.
7. **When something looks off, abort — always.** Any sign that the context
   doesn't match what's expected (a disconnected comment, a footprint/repository
   that doesn't make sense, a contradictory requirement, a change that's "too big"
   for what the task asks) is reason to **stop** and go to `Blocked` — never push
   forward hoping it works out. Asking is free; undoing bad code or a wrong
   analysis is not.

> Leaking context between projects mixes subjects, produces a wrong footprint, and
> can make the worker implement something that doesn't make sense. **Restricted
> scope is a rule, not a suggestion.**

### 8.1 Ancillary paths — footprint exceptions (not automatic rejection)

The footprint is the privilege ceiling for **feature / module code**. Some paths
are expected collateral of almost any real change. Touching them **outside** the
declared footprint is **not**, by itself, scope leakage:

| Kind | Examples | Guidance |
|---|---|---|
| **Lockfiles** | `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` / `bun.lockb`, `Cargo.lock`, `go.sum`, `poetry.lock`, `composer.lock`, `Gemfile.lock`, … | Safe to regenerate / discard and re-resolve. A simple diff usually shows whether the change is incidental (dep resolution) vs. a real conflict — fix the conflict, don't Block. |
| **Toolchain / project config** | `tsconfig.json` (+ `tsconfig.*.json`), `jsconfig.json`, `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`, ESLint/Prettier/Biome/Vitest/Jest configs, `.editorconfig`, `.nvmrc`, `.npmrc`, … | Allowed when the change is needed for the app to **build, typecheck, lint, or run** (flags, path aliases, peer deps, fix warnings that block CI). Not a license to redesign the toolchain. |
| **Test companions** | `*.test.*` / `*.spec.*`, `__tests__/**`, `test(s)/**`, fixtures/mocks tied to the feature | Adjusting or adding tests because the feature adds a field, connector, mock, or assertion is **expected**. Reject only when the test change is unrelated feature work smuggled in. |

**Rules for every role:**

1. **Do not** move to `Blocked` / raise `🙋` solely because an ancillary path sits
   outside `## Footprint`. Prefer `📝` noting why the touch was necessary, then proceed.
2. **Do not** list ancillary-only paths as footprint entries just to "cover" them —
   that falsely serializes unrelated tasks (collision on lock/config).
3. **Do** still reject (or self-stop) when **non-ancillary** module/feature code
   lands outside the footprint — that remains real scope leakage.
4. The deterministic scope-check **skips** ancillary paths; the **Reviewer** still
   judges whether a config/test change is justified for this task. When in doubt
   on intent: approve if it clearly enables the acceptance criteria / green CI;
   reject only when it is unrelated scope creep.

## 9. Content formatting (Markdown) — preserve the format — INVIOLABLE

Issue descriptions and comments on Linear (and on GitHub) are **Markdown**.
Editing this field wrong is one of the easiest ways to destroy a human's work —
treat any write to it as a risky operation, with **mandatory checks before and
after**.

1. **Confirm the format before changing anything.** Read the field's **current,
   full** value and treat it as Markdown (that's Linear's standard). Preserve
   headings, lists, checkboxes (`- [ ]`), code blocks, and links exactly as they
   are. **Keep that original copy** (in your own working memory) before editing —
   that's what lets you restore it if the write goes wrong.
2. **The argument you send is ONE STRING — never a list/array/tuple.** Build the
   complete final text (the whole description, already with the new/changed
   section) as a single plain Markdown string, and call the tool **once** with
   that string. **Never** pass something like `[title, body]` or
   `[description, prompt]` — if what you're about to send looks like it starts
   with `[` and contains several comma-separated, quoted chunks (a serialized
   list), **that's a bug on your part**: stop, rebuild it as a single string
   before calling the tool.
3. **Send real Markdown — never escaped.** Use **actual** line breaks in the
   text; **NEVER** write literal `\n`, `\t`, or escaped quotes (`\'`, `\"`). The
   MCP tool receives the raw string — don't manually JSON-escape the content.
   > Symptom of the bug: the description comes back with **visible** `\n` and
   > everything on a single line, or with brackets/quotes wrapping the whole
   > text. If you see that on re-read, it was bad escaping/serialization — it's
   > not Markdown, it's a bug in the tool call.
4. **Edit the minimum.** Change only the sections that need it and **preserve the
   rest verbatim** — don't rewrite/reformat the human's text. Add/adjust specific
   sections instead of re-serializing the whole description.
5. **Mandatory double/triple-check after ANY write:**
   1. **Re-read** the field immediately after saving (a fresh read call — don't
      trust what you just built).
   2. **Check for corruption signs:** no literal `\n`/`\t` visible; the text
      doesn't start with `[` followed by a quote (the signature of a serialized
      array); the sections that already existed before (e.g. `## Contexto`,
      `## Checklist`) are still there, with their original content intact;
      nothing was duplicated or truncated.
   3. **If any check fails:** the field is corrupted. **Do not move on.** Try to
      restore it immediately from the original copy you kept in step 1 (rewrite
      the correct text). After restoring (or if you couldn't restore it with
      confidence), post `🛑` explaining what happened and move the issue to
      `Blocked` — never leave an issue with a broken description without flagging
      it.

## 10. Repositories and Git — INVIOLABLE

Rules for **any** agent that clones, creates a branch, commits/pushes, or merges
(Dev always; Orchestrator in `merge` mode). They exist because the
wrong repository is not a recoverable scope mistake — it's an action on a system
that isn't yours.

1. **The repository ALWAYS comes from the issue itself.** Use exactly the
   repository(ies) declared in **this** issue's `## Footprint` / `## Onde`
   (format `<owner>/<repo>` or an already-qualified `<repo>`). **Never** search
   GitHub for a repository that "looks similar" or "makes sense" — that's exactly
   the kind of invention protocol §8 forbids.
2. **No declared repository = stop, don't guess.** If the issue doesn't specify a
   repository (no `## Footprint`/`## Onde` filled in), **do not proceed**: post
   `🛑` explaining the repository is missing and move the issue to `Blocked`.
   Don't pick a "candidate" repository on your own, even if one seems obvious.
3. **`AGENT_AUTHORIZED_ORGS` is an additional hard boundary, not a suggestion.**
   If that list is provided in your dispatch message, the issue's repository
   **must** belong to one of those organizations/accounts — even if the issue
   names it explicitly. Outside the list → `🛑` + `Blocked` (it's a human safety
   net; if the issue points outside it, the problem is in the issue, not
   something you route around).
4. **Never fork.** Clone and work directly in the declared repository, on your
   own branch. Lacking push access there is a sign that something is wrong (wrong
   repo, wrong credential, or you shouldn't be here) — not a reason to create a
   fork or look for a "similar" alternative repository. Stop, post `🛑` with what
   you found, and move to `Blocked`.
5. **Never commit/push directly to the default branch** (`main`, `master`,
   `develop`, `trunk`, or whatever the repo's default is). Always create a new
   branch off the up-to-date default and open a PR against it. If the repository
   has a PR template (`.github/PULL_REQUEST_TEMPLATE.md` or
   `.github/PULL_REQUEST_TEMPLATE/*`), use it as the base of the PR description.
6. **Name the repository explicitly in your first ▶️ comment** (before cloning) —
   traceability: any human reading the issue knows, without opening any code,
   where the agent is about to operate.
7. **GitHub MCP search must be scoped** — see §12. Unscoped
   `search_repositories` / `search_code` across all of GitHub is noise and looks
   like the "guess a repo" antipattern above. Prefer direct tools
   (`get_file_contents`, PR tools) with explicit `owner` + `repo` when you
   already know them from the issue.

## 11. Comment triage — what counts as INPUT vs. pipeline traffic

Issues accumulate two kinds of comments; every agent must tell them apart before
treating a comment as requirements:

1. **Agent/pipeline comments always start with `🤖`** (the §2 header). They are
   pipeline traffic (progress, audits, reliability notices) — **never**
   requirements input. Skip them when hunting for scope/context, EXCEPT where
   your SOUL explicitly tells you to read a specific agent's comments (e.g. the
   Dev in `fix` mode reads the Reviewer's rejection comments; any
   agent resuming after `Blocked` reads the human's answer to a `🙋`).
2. **Human comments are potential input.** Humans often add context, constraints,
   payloads, or corrections in the comments after writing the description. The
   **PMO** is the agent responsible for absorbing them into the description
   (see its SOUL); every other agent treats the **description** as the
   consolidated truth.
3. **The `✅`-cutoff rule (already-absorbed marker).** When the PMO finishes a
   refinement, it posts its `🤖 … ✅` summary comment. Any HUMAN comment posted
   **before** the latest PMO `✅` has already been considered (absorbed into the
   description, or deliberately judged noise) — do not re-absorb it. Human
   comments **after** the latest PMO `✅` (or all of them, when no `✅` exists
   yet) are NEW input:
   - **PMO**: absorb them on the next refinement pass, per its SOUL.
   - **Dev / Reviewer**: read them as context; if such a comment
     changes scope or contradicts the description, that is NOT a license to
     exceed the footprint — raise `🙋` (→ `Blocked`) per §8.
4. **Reactions are an optional extra layer, never the mechanism.** If your
   Linear tool exposes emoji reactions, a `✅` reaction on a comment also means
   "absorbed", and you may add one to each comment you absorb. But never DEPEND
   on reactions — not every Linear tool exposes them (the current MCP doesn't
   read or write reactions); the `✅`-cutoff rule above is what always works.

## 12. GitHub MCP — scoped search (repos, code, commits)

Applies whenever you use GitHub MCP search tools (`search_repositories`,
`search_code`, `search_commits`). These tools take a GitHub **search syntax**
`query` string — bare keywords search the whole of GitHub and return noise.
Always scope. This does **not** authorize inventing a repository (§10): you
search only to inspect what the issue already named (or, when validating
membership, within `authorizedOrgs`).

**Prefer direct tools when you already know `owner/repo`:**
- Read a file/dir → `get_file_contents` with `owner`, `repo`, `path` (and
  optional `branch`). Do not `search_code` just to open a known path.
- Read/comment on a PR → the PR tools with `owner`, `repo`, `pullNumber`.

**When you must search, scope the `query`:**

| Tool | Required scope | Useful qualifiers | Examples |
|---|---|---|---|
| `search_repositories` | `repo:owner/repo` **or** `org:<org>` **or** `user:<owner>` (when looking inside authorized orgs) | `in:name`, `in:description`, `topic:`, `language:` | `org:acme payments in:name` · `org:acme topic:backend` |
| `search_code` | `repo:owner/repo` **or** `org:<org>` / `user:<owner>` | `path:dir`, `filename:exact.ext`, `extension:`, `language:`, `in:file`, `in:path` | `PROJECT_MAP repo:acme/payments` · `Footprint language:ts path:docs repo:acme/payments` · `"export function" extension:ts org:acme` |
| `search_commits` | `repo:owner/repo` **or** `org:<org>` / `user:<owner>` (unscoped = all of GitHub — almost never what you want) | `author:`, `committer-date:>=YYYY-MM-DD`, `hash:` | `repo:acme/payments fix panic` · `org:acme author:alice committer-date:>=2024-01-01` |

**Hard rules for search:**
1. **Never** call `search_repositories` / `search_code` / `search_commits` with
   only free-text keywords and no `org:` / `user:` / `repo:` qualifier.
2. If `authorizedOrgs` is in your dispatch input, every `org:` / `user:` /
   `repo:` owner you use **must** be in that list — same boundary as §10.
3. Finding "a similar repo" via search when the issue has no `## Onde` /
   `## Footprint` is still forbidden (§10). Missing repo → `🛑` + `Blocked`,
   not a broader search.
4. Queries are max ~256 characters for code search; keep them short and
   scoped. Implicit AND between terms; use `"quoted phrase"` for exact match,
   `OR` / `NOT` when needed.

## 13. Shell via RTK — token hygiene

Whenever you run a **shell** command (Goose `developer` → `shell`, Hermes
terminal, etc.), route it through [RTK](https://github.com/rtk-ai/rtk) so noisy
stdout is filtered **before** it re-enters the model context. This applies to
**every** role that shells out (PMO, Dev, Reviewer, Orchestrator).

1. **Default — prefix with `rtk`:**  
   `rtk git status` · `rtk git log --oneline -20` · `rtk git diff` ·
   `rtk rg 'pattern' path` · `rtk find . -name '*.ts'` · `rtk bun test` ·
   `rtk bun run lint` · `rtk npm test` · …
2. **No dedicated filter:** use `rtk proxy <command>` (passthrough + tracking).
   Do not invent flags; passthrough is fine.
3. **Never double-wrap** (`rtk rtk …`). If the command is already `rtk …`, leave it.
4. **`rtk` missing:** if `command -v rtk` fails, run the **raw** command — do not
   fail the task over RTK. Optimization, not a gate.
5. **Does not apply to:** MCP tool calls (Linear / GitHub / Hindsight), or
   single-file editor tools (`text_editor` view/edit). Only shell stdout.
6. **`git clone` / `git push` / `git fetch`:** raw or `rtk proxy …` is fine
   (progress noise; not the main token sink). Prefer `rtk` for **inspect**
   commands (`status`, `log`, `diff`, `show`, ripgrep/find, test/lint output).
7. **Hermes:** if the RTK plugin is installed (`rtk init --agent hermes`),
   transparent rewrite may already run — still write `rtk …` explicitly so
   Goose (no hook today) and Hermes stay consistent.

## 15. Tool-call budget & local-first repo inspection

Keep tool traffic small — every call costs tokens and latency.

1. **Prefer few tool calls; batch when possible.** One well-scoped call beats
   several narrow ones.
2. **Local-first when `owner/repo` is known.** Clone shallow into the ephemeral
   workspace (`git clone --depth 1` or `rtk proxy git clone`), then inspect with
   `rtk rg`, `rtk find`, and `text_editor` — **not** repeated GitHub MCP
   `get_file_contents` / `search_code` loops.
3. **GitHub MCP** — only when clone is impossible **or** for PR-specific tools
   (diff, review comments, merge). Always pass `minimal_output: true` when the
   tool supports it. Cap **exploratory** file reads via MCP at **3** per run.
4. **Linear — read this issue only.** Call `getIssueById` (or equivalent) first.
   On **Fetch failed**, retry **once**, then `searchIssues` scoped to **that**
   issue's id/identifier **only** — never bare `getIssues` or unscoped search
   that pulls other teams' issues into context.
5. **Linear — status changes.** If dispatch input includes `teamId` and
   `stateIds` (JSON map name → id), use those ids for workflow transitions —
   do **not** call `getTeams` / `getWorkflowStates` or guess state ids from
   another team.
6. **Linear — writes.** When both description and state must change, prefer one
   `updateIssue` that sets them together.
7. **Linear — comments (anti-duplicate / anti-split).** Post comments **only**
   via Linear MCP (`linear_createComment` / equivalent). **Never** use shell
   (`curl`, `python`, `fetch`) against `api.linear.app` / GraphQL
   (`commentCreate`, `issueUpdate`, …) — that path duplicates and truncates
   comments. Rules per phase:
   - At most **one** `▶️` start comment and **one** `✅`/`🛑`/`🙋` closing
     comment (plus optional `📝` when the protocol requires a note).
   - Draft the **full** Markdown body before calling the tool. Never post a
     stub / partial comment and then a "complete" rewrite of the same update.
   - Never combine start (`▶️`) and done (`✅`) into one comment, and never
     fire two tool calls with near-identical bodies.
   - If MCP `createComment` fails: retry **once** with the same complete body.
     If it still fails, post `🛑` (via MCP if possible), move to `Blocked`,
     and **STOP** — do not fall back to shell/GraphQL.
8. **Stop when done.** After the final Linear comment and status move for your
   phase: **STOP**. No verification re-fetch of the issue, no English chat
   essay summarizing the run.
9. **Linear Fetch failed (full path):** retry once → scoped `searchIssues`
   fallback → if still failing, post `🛑`, move to `Blocked`, stop.

## 16. Examples

**Progress (worker, Linear):**
```
🤖 **Dev** · `dev-w1` · 2026-06-27 14:32 UTC · Implementação

▶️ Iniciei a ENG-123. Reutilizando o componente `AuthForm` existente em vez de
criar um novo (encontrei via PROJECT_MAP). Branch criada a partir da main atualizada.

— Task: ENG-123 · Branch: eng-123-login-sso
```

**Help request (worker, Linear + PR):**
```
🤖 **Dev** · `dev-w1` · 2026-06-27 15:10 UTC · Implementação

🙋 Preciso de uma decisão antes de seguir.

A task pede "integrar com o provedor de SSO", mas há dois configurados no projeto
(Auth0 e Cognito). Qual devo usar?
  A) Auth0   B) Cognito

Movi a task para Blocked aguardando resposta.

— Task: ENG-123 · PR: https://github.com/<owner>/<repo>/pull/482 · Branch: eng-123-login-sso
```

**Review verdict (reviewer, PR + Linear):**
```
🤖 **Reviewer** · `reviewer-01` · 2026-06-27 16:05 UTC · Code Review

🛑 Reprovado — 2 pontos a corrigir:
1. `auth.service.ts:88` — token logado em texto puro (risco de segurança).
2. Falta tratamento do caso de e-mail já cadastrado (pedido no critério 3 da task).

Movendo para Reopened.

— Task: ENG-123 · PR: https://github.com/<owner>/<repo>/pull/482
```

> The comment bodies above are shown in Brazilian Portuguese on purpose — that's
> the required output language for team-facing comments (§7). Everything else in
> this document (the rules themselves) is in English so it reads consistently
> alongside the English-language SOULs.
