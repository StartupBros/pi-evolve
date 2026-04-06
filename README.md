# pi-evolve

Cross-harness migrated skill interoperability for [Pi](https://github.com/badlogic/pi-mono).

This package helps Pi behave more predictably when you use skills, prompts, or workflows that were originally written for another coding harness such as Claude Code, Codex, or Compound Engineering.

## Why this exists

Shared skills often assume workflow semantics that do not map cleanly to Pi:

- `AskUserQuestion`
- `Task agent(args)`
- "load the `some-skill` skill"
- exploratory workflows that start with broad repo thrash before clarifying the task

`pi-evolve` adds a narrow compatibility layer so Pi can interpret these patterns more deterministically instead of improvising.

## What it does

### `load_skill_reference`
Resolves a loaded skill by name and returns its `SKILL.md` content.

Use it when a migrated skill says to load another skill. This avoids broad filesystem hunting and keeps resolution inside Pi's loaded skill set.

### Native Compound review bridge
`pi-evolve` no longer owns the public Compound review slash commands.

Canonical review entrypoints now live in the global review extension:

- `/workflows-review`
- `/ce-review`

Legacy aliases like `/ce:review` and `/workflows:review` are handled there as deprecated forwards so the environment has a single review pipeline.

`pi-evolve` still provides the interoperability layer that makes migrated Compound workflows behave correctly inside Pi by:

- helping migrated prompts resolve Pi-native tools and skills deterministically
- reinforcing that `Task(...)` maps to the global `subagent` runtime
- supporting migrated agent aliases such as `Explore`, `Plan`, `general-purpose`, and namespaced `compound-engineering:*:*` reviewers through the global agent-wrapper setup
- keeping reusable CE parsing and todo-file helpers available for the canonical review pipeline

### Prompt-time interop guidance
On `before_agent_start`, the extension inspects the prompt for common migrated patterns and injects compact guidance such as:

- `AskUserQuestion` means `ask_user_question`
- `Task agent(args)` means `subagent`
- when another skill is referenced, prefer `load_skill_reference`
- for brainstorm-style flows, ask one clarifying question before repo research unless requirements are already explicit

## Install

### Install from GitHub

```bash
pi install git:github.com/StartupBros/pi-evolve
```

### Try without installing

```bash
pi -e git:github.com/StartupBros/pi-evolve
```

### Install from a local checkout

```bash
pi install /absolute/path/to/pi-evolve
```

## Scope

This package is intentionally narrow.

It does **not** attempt to rewrite every foreign workflow into Pi-native behavior. Instead, it covers a small set of high-value interoperability gaps that repeatedly show up in migrated skills.

## Example problems it helps with

- A skill says "Load the `brainstorming` skill" and Pi would otherwise start searching the filesystem broadly.
- A migrated workflow refers to `AskUserQuestion` instead of `ask_user_question`.
- A migrated workflow contains `Task repo-research-analyst(...)` and Pi needs a clear delegation hint.
- A brainstorm flow starts doing repo research before understanding the user request.

## Development

```bash
pnpm install
pnpm check
pi -e .
```

## Project hygiene

- CI runs `pnpm check`
- Unit tests cover reference extraction and note generation
- Changes are tracked in [`CHANGELOG.md`](./CHANGELOG.md)

## Relationship to `pi-research-fabric`

- `pi-research-fabric` handles migrated **research capability** names like `WebSearch` and `WebFetch`
- `pi-evolve` handles migrated **workflow and skill semantics** like `AskUserQuestion`, `Task(...)`, and skill references

They are complementary packages.

## License

MIT
