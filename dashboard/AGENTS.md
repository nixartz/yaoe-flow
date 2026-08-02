## Frontend UI/UX Rules

> **Scope:** Apply every rule in this section whenever creating, modifying,
> refactoring, reviewing, or styling frontend code and user-facing interfaces.
>
> **Do not apply these rules to backend code**, including APIs, services,
> domain logic, database code, background jobs, infrastructure, integrations,
> or server-side implementation details that do not render a user interface.

When working on frontend code, prioritize user comprehension, predictable
interaction patterns, accessibility, and efficient task completion over
developer-centric layouts or purely decorative visuals.

### General Principles

- Prefer clear information hierarchy, purposeful spacing, consistent alignment,
  and progressive disclosure over dense, unstructured screens.
- Reuse the existing design system, design tokens, and shared UI components
  before creating custom variants or one-off styles.
- Do not introduce visual effects, gradients, glassmorphism, animations,
  unusual fonts, or decorative cards unless they have a clear product purpose.
- Prefer familiar SaaS and enterprise UI patterns over experimental layouts.
- Use color only as a supporting semantic signal; never make color the sole
  indicator of status, priority, validation, or meaning.
- Preserve responsive behavior, keyboard navigation, visible focus states,
  semantic HTML, accessible labels, and sufficient color contrast.
- Always implement relevant loading, empty, error, disabled, success, and
  permission-denied states for user-facing flows.

### Administrative Interfaces

- Optimize administrative screens for clarity, scanability, speed of operation,
  and predictable workflows.
- Avoid developer-centric UIs that expose raw IDs, technical labels, JSON,
  internal enum values, implementation details, or API-shaped data unless the
  target user explicitly needs them.
- Use concise, user-oriented labels and helpful descriptions for concepts that
  may be ambiguous, irreversible, sensitive, or have side effects.
- Prefer contextual help near the related field or action instead of large,
  generic explanatory blocks.
- Avoid unnecessary cards, nested containers, excessive borders, and large
  empty areas that reduce information density without improving comprehension.

### Forms and Settings

- Make simple settings directly editable in the appropriate form control.
  Do not use a "view value -> click Edit -> reveal input" interaction for
  fields that can safely be edited inline.
- Group settings into meaningful categories. Use side navigation for numerous
  persistent categories, and tabs only when the number of categories is small
  and their content is closely related.
- Select controls based on the data and interaction model:
  - Text input for short text values
  - Textarea for longer free-form content
  - Number input with units, ranges, and validation for numeric values
  - Date or date-time picker for temporal values
  - Select or combobox for one value from a known set
  - Multi-select or checkbox group for multiple independent selections
  - Radio group for a small set of mutually exclusive, visible options
  - Switch for a binary setting with an immediate, easily understood effect
  - Checkbox for an explicit selection within a form or a group of options
- Clearly distinguish required, optional, inherited/default, read-only, and
  sensitive settings.
- Validate input close to the field, provide actionable error messages, and
  preserve user input whenever validation or requests fail.
- When a form has pending changes, provide a clear save area with save and
  discard actions, indicate unsaved changes, and prevent accidental loss.
- Isolate destructive or high-impact settings in a dedicated danger zone with
  explicit impact descriptions and appropriate confirmation flows.

### Tables and Data-Dense Views

- Treat tables as scanning and decision-making surfaces, not as containers for
  every property returned by the API.
- Show the columns users need to identify, compare, filter, and act on items;
  move secondary details to a detail page, expandable area, or side drawer.
- Provide search, filtering, sorting, pagination or virtualization, and column
  visibility controls when the dataset and user workflow justify them.
- Use badges, icons, and semantic colors to communicate status, type, priority,
  environment, warnings, or permissions, always with readable text or another
  non-color cue.
- Make row actions discoverable but avoid filling every row with unnecessary
  buttons. Prefer row click, a contextual menu, or a detail drawer when
  appropriate.
- Use a side drawer or dedicated detail page for progressive disclosure when an
  item has substantial metadata, history, relations, or actions.
- Format dates, numbers, currency, identifiers, and statuses for the target
  user instead of exposing raw API values.

### Implementation Workflow

Before implementing a non-trivial frontend screen or redesign:

1. Inspect the existing UI, shared components, design tokens, routes, types,
   API contracts, and established interaction patterns.
2. Identify UX issues involving hierarchy, navigation, density, labeling,
   form controls, feedback states, responsiveness, and accessibility.
3. Propose the screen structure and component mapping before making broad UI
   changes when the task is a redesign or affects a complex user flow.
4. Implement using existing primitives and reusable components.
5. Review the final interface for visual consistency, keyboard access, focus
   management, responsive behavior, empty/loading/error states, and realistic
   content density.

Do not apply this workflow or these UI/UX rules when the task is exclusively
backend code and does not modify a user-facing interface.