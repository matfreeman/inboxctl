# Changelog

All notable changes to `inboxctl` are documented in this file.

The format follows Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

### Changed

### Fixed

### Security

## [0.2.0] - 2026-04-08

### Added

- Added Phase 10 inbox-management capabilities: paginated uncategorized email review, ranked unsubscribe suggestions, and an `unsubscribe` action that can clean up existing mail in one undoable run.

### Changed

- Expanded `get_noise_senders` with all-time message context, all-time noise scoring, direct unsubscribe links, and configurable sorting for AI clients.
- Updated the `categorize-emails`, `review-senders`, and `triage-inbox` MCP prompts to use pagination and unsubscribe-aware cleanup flows.

## [0.1.2] - 2026-04-08

### Fixed

- Required release tags to match `package.json` before publishing.
- Blocked publishes when the npm version already exists, with a clear workflow error.
- Updated GitHub Actions `checkout` and `setup-node` to the current major release.

## [0.1.0] - 2026-04-08

### Added

- Initial public release of the `inboxctl` CLI, TUI, and MCP server.
