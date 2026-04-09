---
name: unsubscribe
description: Review and unsubscribe from noisy email senders. Use when the user wants ranked unsubscribe candidates, bulk cleanup, or auto-archive filters for recurring noise.
disable-model-invocation: true
allowed-tools:
  - mcp__inboxctl__get_unsubscribe_suggestions
  - mcp__inboxctl__get_noise_senders
  - mcp__inboxctl__unsubscribe
  - mcp__inboxctl__create_filter
  - mcp__inboxctl__list_filters
  - mcp__inboxctl__get_sender_stats
  - mcp__inboxctl__query_emails
  - mcp__inboxctl__sync_inbox
  - mcp__inboxctl__undo_run
  - mcp__inboxctl__undo_filters
  - mcp__inboxctl__cleanup_labels
---

# unsubscribe

Use this project skill when the user wants a review-and-approve unsubscribe workflow for noisy senders.

## Critical Rules

1. Never unsubscribe without explicit user approval. Unsubscribing is irreversible.
2. `unsubscribe` does not complete the remote unsubscribe for the user. It archives and labels existing mail, then returns the unsubscribe link or mailto target.
3. Always check `list_filters` before creating filters, and avoid duplicates.
4. After a user-approved unsubscribe, create a Gmail filter so future mail is archived immediately unless the user asks otherwise.
5. If multiple approved senders share a domain, suggest one domain-level filter instead of multiple sender-level filters.
6. Record every run ID from `unsubscribe` so the user can undo inbox cleanup if needed.
7. Collect unsubscribe links and present them together at the end.

## Workflow

### Step 1: Gather candidates

1. Run `sync_inbox` if the user wants fresh data or the cache may be stale.
2. Call `get_unsubscribe_suggestions`.
3. Call `get_noise_senders` as a complementary ranked view.
4. Call `list_filters` to see what automation already exists.
5. Present a ranked table such as:

```text
#  | Sender                         | Emails | Unread | Impact | Has Filter?
1  | noreply@marketing.example.com  | 892    | 98%    | HIGH   | No
2  | newsletter@techblog.io         | 234    | 95%    | HIGH   | No
3  | deals@store.com                | 156    | 88%    | MEDIUM | No
```

6. Ask the user which senders to process. Accept broad instructions like "all", explicit row numbers, thresholds, or "auto-archive only".

### Step 2: Execute approved actions

For each approved sender:

- Unsubscribe:
  1. Call `unsubscribe` with `alsoArchive: true`
  2. Record the returned link, run ID, and archived count
  3. Create a Gmail filter unless an equivalent one already exists
- Auto-archive only:
  1. Create a Gmail filter
  2. Do not call `unsubscribe`

Before creating individual filters, look for shared domains and offer consolidation.

### Step 3: Present results

Report:

- Unsubscribe links to open, grouped by sender or domain
- Emails archived and the run IDs available for `undo_run`
- Filters created or reused
- Estimated noise reduction, preferably via `query_emails` over a recent period
- Remind the user that Gmail filters created during this session can be removed with `undo_filters`, and any empty cleanup labels can be removed with `cleanup_labels`

Make it clear that the user must open the unsubscribe links in their browser or mail client to finish the unsubscribe itself.
