# Contributing

Thanks for contributing to `inboxctl`.

## Development setup

```bash
npm install
npm run build
npm run lint
npm test
```

Use `./inboxctl --help` after building if you want to exercise the CLI locally.

## Project structure

- `src/core/` contains the business logic.
- `src/mcp/` contains the MCP server surface.
- `src/tui/` contains the Ink-based terminal UI.
- `rules/` contains example YAML rules.

## Pull requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Run `npm run build`, `npm run lint`, and `npm test` before opening a PR.
- Update docs when user-facing behavior changes.

## Safety expectations

- Do not add destructive email deletion behavior.
- Keep rules dry-run by default.
- Preserve audit logging and undo guarantees for reversible actions.
