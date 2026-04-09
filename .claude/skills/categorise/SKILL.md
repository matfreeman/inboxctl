---
name: categorise
description: Categorise uncategorized emails in your Gmail inbox using sender-level analysis. Use when the user wants to bulk organise backlog mail, apply consistent labels, or turn sender patterns into ongoing rules.
disable-model-invocation: true
allowed-tools:
  - mcp__inboxctl__sync_inbox
  - mcp__inboxctl__get_uncategorized_senders
  - mcp__inboxctl__get_uncategorized_emails
  - mcp__inboxctl__get_labels
  - mcp__inboxctl__create_label
  - mcp__inboxctl__batch_apply_actions
  - mcp__inboxctl__review_categorized
  - mcp__inboxctl__query_emails
  - mcp__inboxctl__deploy_rule
  - mcp__inboxctl__create_filter
  - mcp__inboxctl__list_filters
  - mcp__inboxctl__list_rules
  - mcp__inboxctl__get_noise_senders
  - mcp__inboxctl__undo_run
  - mcp__inboxctl__undo_filters
  - mcp__inboxctl__cleanup_labels
---

# categorise

Use this project skill when the user wants a guided sender-level inbox categorisation workflow.

## Critical Rules

1. Never load individual emails in bulk. Use `get_uncategorized_senders` as the primary data source with its default compact payload. Only fetch email IDs for the specific senders you are about to mutate.
2. Decisions are per-sender, not per-email. Once you decide `noreply@uber.com` is `Receipts`, apply that mapping consistently across pages.
3. Respect confidence gating:
   - HIGH -> full actions for the chosen category
   - MEDIUM -> label only, no archive, no mark_read
   - LOW -> present individually for user review, defaulting to `inboxctl/Review`
4. Present a plan before applying anything. Wait for explicit user approval before calling `batch_apply_actions`.
5. Batch efficiently. Group emails by category, create missing labels first, and minimize follow-up calls.
6. If a sender has `emailIdsTruncated: true`, process the included IDs first, then fetch the remainder with `get_uncategorized_emails`.
7. Never archive LOW-confidence senders without explicit approval.

## Default categories

| Category | Gmail label | HIGH confidence actions | MEDIUM confidence actions |
| --- | --- | --- | --- |
| Receipts | `inboxctl/Receipts` | label + mark_read | label only |
| Shipping | `inboxctl/Shipping` | label only | label only |
| Newsletters | `inboxctl/Newsletters` | label + mark_read + archive | label only |
| Promotions | `inboxctl/Promotions` | label + mark_read + archive | label only |
| Social | `inboxctl/Social` | label + mark_read | label only |
| Notifications | `inboxctl/Notifications` | label + mark_read | label only |
| Finance | `inboxctl/Finance` | label only | label only |
| Travel | `inboxctl/Travel` | label only | label only |
| Important | `inboxctl/Important` | label only, never archive | label only |
| Review | `inboxctl/Review` | none | none |

## Workflow

### Step 1: Sync and assess

1. Run `sync_inbox` incrementally so the cache is current.
2. Call `get_uncategorized_senders` with `limit: 100` and `sort_by: "email_count"`.
3. Present:
   - Total uncategorized emails and senders
   - Confidence breakdown from `summary.byConfidence`
   - Top 10 senders by volume with confidence and signals
   - Top domains from `summary.topDomains`
4. Ask whether to:
   - Proceed with full categorisation
   - Scope down, such as only HIGH confidence or only senders with a minimum email count
   - Customise the default categories

### Step 2: Categorise senders

For each sender page:

1. Assign each sender to a category using:
   - `domain`
   - `newestSubject` and `secondSubject`
   - `isNewsletter` and `detectionReason`
   - `signals`
   - `name`
   - `hasUnsubscribe`
2. Group senders by category and confidence.
3. Present a summary table like:

```text
Category       | Senders | Emails | Confidence | Actions
Newsletters    | 12      | 3,400  | HIGH       | label + mark_read + archive
Promotions     | 8       | 1,200  | HIGH       | label + mark_read + archive
Receipts       | 15      | 890    | HIGH       | label + mark_read
Notifications  | 6       | 340    | MEDIUM     | label only
Review         | 3       | 12     | LOW        | needs your decision
```

4. Present LOW-confidence senders individually with recent subject context and ask for direction.
5. Let the user approve, move senders between categories, skip senders, or reduce the action level for a category.
6. On approval:
   - Create any missing labels with `create_label`
   - Re-fetch only the approved senders with `include_email_ids: true` before preparing `batch_apply_actions` groups
   - Prepare `batch_apply_actions` groups by category and action set
   - Process HIGH confidence first, then MEDIUM, then user-approved LOW
7. If `hasMore` is true, continue with the next sender page.

### Step 3: Audit

1. Call `review_categorized` after each applied batch or at the end of the session.
2. If anomalies are found:
   - Present each anomaly with its severity and context
   - Offer `undo_run` for the relevant run when appropriate
3. If no anomalies are found, report a clean audit result.

### Step 4: Suggest automation

1. Use `query_emails` to find labeled patterns worth automating. Start with grouped domain queries and only propose clear, repeated patterns.
2. Check `list_filters` and `list_rules` before proposing anything new.
3. For strong patterns, propose:
   - A YAML rule for backlog processing or complex matching
   - A Gmail filter for future incoming mail when the match is simple and stable
4. Be conservative with filters:
   - Prefer domain-level filters over per-sender filters
   - Check the current filter count before adding more
   - Only create filters for HIGH-confidence patterns
5. Apply `deploy_rule` and `create_filter` only after user approval.

### Step 5: Summary

Report:

- Total emails categorised by category
- Total senders processed
- Anomalies found and whether they were resolved
- Rules deployed and filters created
- Remaining uncategorized count, if any
- Run IDs for undoable batches
- If the user wants to fully unwind the session, point them at `undo_run` for the recorded batch run IDs, `undo_filters` for any Gmail filters created during the session, and `cleanup_labels` to remove empty `inboxctl/*` labels afterwards
