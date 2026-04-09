# Changelog

All notable changes to `inboxctl` are documented in this file.

The format follows Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

### Changed

### Fixed

### Security

## [0.7.0] - 2026-04-09

### Added

- Added browser handoff from the TUI so the selected inbox, search, or detail-view message can be opened directly in Gmail with `O`.

### Changed

- Hardened TUI email rendering for HTML-heavy mail with explicit body-source tracking, cleaned HTML-to-terminal formatting, and render-quality hints in the email detail view.

### Fixed

- Fixed Gmail message parsing so HTML-only bodies no longer leak raw HTML/CSS into the `textPlain` path before terminal rendering.

## [0.6.1] - 2026-04-09

### Fixed

- Fixed confidence scoring so high-volume transactional/service senders no longer get misclassified as `personal_sender_address`, including new automated-address markers and a volume safeguard.
- Fixed `get_uncategorized_emails` and `get_uncategorized_senders` so messages in `SPAM` or `TRASH` no longer appear in uncategorized results.
- Fixed `get_noise_senders` category inference so newsletter-like senders do not fall back to `Other` when `isNewsletter` is already known.

## [0.6.0] - 2026-04-09

### Added

- Added an `include_email_ids` opt-in to `get_uncategorized_senders` so callers can request sender email IDs only when they are ready to mutate a small batch.

### Changed

- Updated the categorization prompt and Claude Code categorise skill to use the new two-step sender workflow: compact sender discovery first, targeted ID fetch second.

### Fixed

- Fixed `get_uncategorized_senders` MCP payload overflow by omitting `emailIds` and `emailIdsTruncated` from the default response shape.

## [0.5.0] - 2026-04-09

### Added

- Added filter event tracking plus the `undo_filters` MCP tool so inboxctl-created Gmail filters can be removed by run or session after the fact.
- Added `cleanup_labels` for removing empty `inboxctl/*` Gmail labels left behind after undoing categorisation work.

### Changed

- Updated `undo_run` to auto-disable the originating YAML rule after a rule-backed run is reversed, and now return the affected rule metadata in the response.
- Updated the Claude Code skills and MCP categorisation prompt to point agents at the new reversibility workflow for filters, labels, and rule runs.

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
