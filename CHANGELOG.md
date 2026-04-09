# Changelog

All notable changes to `inboxctl` are documented in this file.

The format follows Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

### Changed

### Fixed

### Security

## [0.4.0] - 2026-04-09

### Added

- Added `get_uncategorized_senders`, a sender-level MCP workflow for categorizing large uncategorized inboxes without pulling every email into agent context.
- Added CLI coverage for the newer analytics workflows with `stats noise`, `stats uncategorized`, `stats unsubscribe`, `stats anomalies`, `query`, `thread`, and `unsubscribe`.
- Added TUI stats tabs for noise senders, uncategorized senders, and unsubscribe candidates.

### Changed

- Updated MCP prompts so `categorize-emails` uses sender-level uncategorized grouping first and `suggest-rules` points agents at `query_emails` for pattern discovery.
- Updated the published README to reflect the current MCP contract and the expanded CLI/TUI surface.

## [0.3.0] - 2026-04-08

### Added

- Added confidence scoring and signal reporting to `get_uncategorized_emails` so AI clients can distinguish safe bulk mail from rare or personal senders.
- Added the read-only `review_categorized` anomaly scanner to catch suspicious categorization runs after the fact.
- Added the read-only `query_emails` analytics tool and `schema://query-fields` resource for structured aggregation over the local email cache.

### Changed

- Updated the `categorize-emails`, `review-senders`, and `triage-inbox` prompts with confidence gating and post-categorization review guidance.
- Aligned the CLI and MCP server reported versions with the package release version.

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
