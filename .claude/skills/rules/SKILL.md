---
name: rules
description: Discover email patterns and create inboxctl YAML rules and Gmail filters for ongoing inbox automation. Use when the user wants repeatable automation, dry runs, and safe deployment of new inbox rules.
disable-model-invocation: true
allowed-tools:
  - mcp__inboxctl__query_emails
  - mcp__inboxctl__list_rules
  - mcp__inboxctl__list_filters
  - mcp__inboxctl__deploy_rule
  - mcp__inboxctl__run_rule
  - mcp__inboxctl__enable_rule
  - mcp__inboxctl__disable_rule
  - mcp__inboxctl__create_filter
  - mcp__inboxctl__delete_filter
  - mcp__inboxctl__get_labels
  - mcp__inboxctl__create_label
  - mcp__inboxctl__get_noise_senders
  - mcp__inboxctl__get_newsletter_senders
  - mcp__inboxctl__get_top_senders
  - mcp__inboxctl__get_sender_stats
  - mcp__inboxctl__sync_inbox
  - mcp__inboxctl__undo_run
  - mcp__inboxctl__undo_filters
  - mcp__inboxctl__cleanup_labels
---

# rules

Use this project skill when the user wants to discover repeatable inbox patterns and turn them into YAML rules and Gmail filters.

## Critical Rules

1. Always check `list_rules` and `list_filters` first so you do not duplicate existing automation.
2. Keep the distinction clear:
   - YAML rules are for dry-runs, historical backlog processing, complex matching, and undoable audits
   - Gmail filters are for simple always-on delivery handling inside Gmail
3. Dry-run every new YAML rule with `run_rule` before applying it.
4. Be conservative with Gmail filters:
   - Prefer domain-level filters over per-sender filters
   - Check the current filter count before adding more
   - Only create filters for stable, high-confidence patterns
5. Explain each proposal in plain language before deploying anything.

## Rule schema reference

```yaml
name: kebab-case-name
description: Human-readable description
enabled: true
priority: 100

conditions:
  operator: AND
  matchers:
    - field: from
      contains: ["keyword"]

actions:
  - type: label
    label: "Category/Subcategory"
  - type: archive
  - type: mark_read
```

## Workflow

### Step 1: Understand the current state

1. Run `sync_inbox` if the user wants fresh pattern discovery.
2. Call `list_rules` and `list_filters`.
3. Summarize:
   - Number of active YAML rules
   - Number of Gmail filters and how close they are to the 1000-filter limit
   - Patterns already covered

### Step 2: Discover patterns

Run targeted `query_emails` searches to find:

1. High-volume domains
2. High-unread domains
3. Newsletter or noise senders without automation
4. Domains that already cluster under the same user-applied label

Use `get_noise_senders`, `get_newsletter_senders`, `get_top_senders`, and `get_sender_stats` to add context where needed.

Present the findings in a table such as:

```text
Pattern                      | Emails | Unread | Automated?
@github.com notifications    | 2,340  | 67%    | No
@linkedin.com                | 890    | 91%    | Gmail filter exists
noreply@stripe.com           | 456    | 12%    | No
```

### Step 3: Propose rules

For each worthwhile pattern:

1. Explain the intended behavior in plain language.
2. Draft the YAML rule.
3. Propose a Gmail filter only when the criteria are simple and stable.
4. Ask the user to approve, adjust, or skip each proposal.

### Step 4: Deploy safely

For each approved YAML rule:

1. `deploy_rule`
2. `run_rule` with `dry_run: true`
3. Show the expected match count
4. Ask whether to apply now or leave it deployed for later
5. If approved, run the real execution and capture the undoable run ID

For each approved Gmail filter:

1. Create any missing labels first
2. Call `create_filter`

### Step 5: Summary

Report:

- Rules deployed and what they do
- Gmail filters created or reused
- Emails affected by applied rule runs and the corresponding undo run IDs
- Current filter count versus the limit
- Remaining unautomated patterns worth revisiting later
- If a rule run was undone, note that `undo_run` auto-disables the originating rule to prevent re-application, and remind the user they can use `enable_rule` after adjusting it
- Mention `undo_filters` for any Gmail filters created during the session and `cleanup_labels` for removing empty `inboxctl/*` labels
