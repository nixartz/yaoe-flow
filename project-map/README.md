# PROJECT_MAP — live repository inventory

Generates a `PROJECT_MAP.md` listing what already exists in the repo (pages, components, hooks, services, etc.) with their exports. This is what backs the agents' **read-before-write** and the Orchestrator's **planning pass** — without it, agents recreate things that already exist (the classic Multica mistake).

## Usage

```bash
bun generate-project-map.ts [rootDir] [--out PROJECT_MAP.md]
# default rootDir = "src"
```

Example:

```bash
bun generate-project-map.ts src --out PROJECT_MAP.md
```

## Where to run it

Run this **inside the target repository** (the repo the agents develop), not in this project. Two ways to keep it fresh:

- **CI (recommended):** a step that runs the generator on every merge to `main` and commits `PROJECT_MAP.md`. That way it never goes stale.
- **At the start of each worker run:** the worker runs the generator right after cloning, guaranteeing a fresh map before implementing.

## Limitations (deliberate, to keep it simple)

- Export extraction by regex (not AST). Catches `function/const/class/type/interface/export {}` and `export default`. Exotic cases can slip through.
- Categorization by folder/suffix convention. If your project uses a different structure, adjust `categorize()`.
- For a more precise footprint, the Orchestrator supplements this by reading the repo directly — PROJECT_MAP is the starting point, not the only source.
