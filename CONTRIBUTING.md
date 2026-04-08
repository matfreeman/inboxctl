# Contributing

Thanks for contributing to `inboxctl`.

## Development setup

```bash
npm install
npm run build
npm run lint
npm test
```

Use `npm link && inboxctl --help` after building if you want to exercise the CLI locally.

## Project structure

- `src/core/` contains the business logic.
- `src/mcp/` contains the MCP server surface.
- `src/tui/` contains the Ink-based terminal UI.
- `rules/` contains example YAML rules.

## Pull requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Run `npm run build`, `npm run lint`, and `npm test` before opening a PR.
- Update the README or CLI help text when user-facing behavior changes.
- Update `CHANGELOG.md` for user-visible, packaging, CI, or release-process changes.
- Apply PR labels that map cleanly to `.github/release.yml` categories when relevant.

## Safety expectations

- Do not add destructive email deletion behavior.
- Keep rules dry-run by default.
- Preserve audit logging and undo guarantees for reversible actions.

## Releases

This repo keeps release history in `CHANGELOG.md` and uses GitHub Releases for release notes.

- Add new changes to the `Unreleased` section in `CHANGELOG.md`.
- Before creating a release, move those entries into a versioned section.
- Create releases with `gh release create ... --generate-notes`.
- Follow the full checklist in `RELEASING.md`.
