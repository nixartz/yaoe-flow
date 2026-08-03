---
name: souls-recipes-single-line
description: agents/*.SOUL.md and recipes/*.yaml prose must use one line per paragraph/list item, always
metadata:
  type: rule
---

# One line per paragraph/list item — SOULs and recipes only

Every paragraph and list item in `agents/*.SOUL.md` and in the prose/prompt blocks of `recipes/*.yaml` must be written as a single, unbroken source line — no matter how long. Do not manually wrap them at 80/100 columns the way you would in ordinary prose.

**Why:** these files are read raw and concatenated directly into what gets sent to the model (`communicationProtocol()` + `readSoulFile()` in `app/src/agent/recipe/defaults.ts`, and the YAML block scalars in `recipes/*.yaml`). A hard line break in the middle of a sentence survives that concatenation as a literal newline, which can read as a paragraph break to the model and to markdown renderers inside harness chat UIs — splitting one instruction into what looks like two. It also produces noisy, hard-to-review diffs: editing one word in a wrapped paragraph reflows every line after it, instead of changing exactly one line.

**Scope:** this rule applies ONLY to `agents/*.SOUL.md` and `recipes/*.yaml`. Every other file, document or text in the project (README, CHANGELOG, docs/, knowledge/product, code comments, etc.) is not bound by it — normal prose wrapping there is fine and expected.

