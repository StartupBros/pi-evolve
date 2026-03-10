# Contributing

## Development

```bash
pnpm install
pnpm check
```

## Design principles

- Keep the package narrow and deterministic
- Prefer compatibility notes and explicit tools over broad prompt magic
- Avoid repo-specific assumptions
- Add or update tests for every migrated-skill regression

## Release checklist

- `pnpm check` passes
- local `pi -e .` smoke test passes
- install from local path or git works
- README documents the behavior and limits clearly
