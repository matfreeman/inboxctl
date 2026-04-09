# inboxctl

**An MCP server that gives AI agents structured, safe access to your Gmail inbox, with a CLI and TUI for when you want to inspect or drive the same workflows yourself.**

![inboxctl demo](https://raw.githubusercontent.com/matfreeman/inboxctl/main/demo.gif)

## Why MCP-native?

Most email tools put the intelligence inside the app. `inboxctl` does the opposite: it is the infrastructure layer, and your AI agent is the brain.

Connect any MCP client, including Claude Desktop, Claude Code, or another MCP-compatible agent, and it gets structured access to search your inbox, review sender patterns, analyze uncategorized mail at sender-level, detect newsletter noise, rank unsubscribe opportunities, review categorization anomalies, run structured inbox queries, apply labels, archive, create Gmail filters, and manage rules. `inboxctl` handles the Gmail plumbing, audit trail, and undo path.

The CLI and TUI ship alongside MCP so you can always inspect what an agent did, undo it, or run the same work manually.

Emails are never deleted. The tool can label, archive, mark read, and forward, but it does not destroy data.

## What the MCP server exposes

| | Count | Examples |
|---|---|---|
| **Tools** | 34 | `search_emails`, `get_uncategorized_senders`, `batch_apply_actions`, `query_emails`, `get_noise_senders`, `get_unsubscribe_suggestions`, `deploy_rule`, `create_filter`, `undo_run`, `undo_filters`, `cleanup_labels`, `review_categorized` |
| **Resources** | 8 | `inbox://recent`, `inbox://summary`, `inbox://action-log`, `schema://query-fields`, `rules://deployed`, `rules://history`, `stats://senders`, `stats://overview` |
| **Prompts** | 6 | `summarize-inbox`, `review-senders`, `find-newsletters`, `suggest-rules`, `triage-inbox`, `categorize-emails` |

An agent can read your inbox summary, review your noisiest senders, suggest a YAML rule to handle them, deploy it in dry-run, show you the results, and apply it, all through MCP calls.

## Quick start

### Published package

```bash
npx inboxctl@latest setup
npx inboxctl@latest sync
npx inboxctl@latest
```

### Development checkout

```bash
npm install
npm run build
npm link
inboxctl setup
inboxctl sync
inboxctl
```

## Connect your AI agent

### Claude Desktop

```json
{
  "mcpServers": {
    "inboxctl": {
      "command": "npx",
      "args": ["-y", "inboxctl@latest", "mcp"]
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "inboxctl": {
      "command": "npx",
      "args": ["-y", "inboxctl@latest", "mcp"]
    }
  }
}
```

For a local checkout, replace the command with `node` and point the args at `dist/cli.js`:

```json
{
  "mcpServers": {
    "inboxctl": {
      "command": "node",
      "args": ["/absolute/path/to/inboxctl/dist/cli.js", "mcp"]
    }
  }
}
```

Then ask your agent things like:

- "What are my noisiest unread senders?"
- "Find all emails that look like receipts and label them Receipts."
- "Create a Gmail filter to auto-archive future mail from noreply@example.com."
- "Show me what the label-receipts rule would match, then apply it."

## Use the CLI or TUI directly

```bash
inboxctl                    # launch the TUI
inboxctl mcp                # start MCP server on stdio
inboxctl demo               # launch the seeded demo mailbox
```

## Features

- **MCP server** with the full feature set exposed as tools, resources, and prompts.
- **Context-efficient sender workflows** with `get_uncategorized_senders`, which returns compact sender-level results by default and only includes email IDs when explicitly requested for a mutation batch.
- **Rules as code** in YAML, with deploy, dry-run, apply, drift detection, audit logging, and undo.
- **Local-first analytics** on top senders, unread rates, newsletter detection, uncategorized senders, noise scoring, unsubscribe impact, anomaly review, labels, and volume trends.
- **Structured inbox queries** for fixed filters, aggregations, and grouping across the local cache.
- **Gmail filter management** for always-on server-side rules on future incoming mail.
- **Full audit trail** with before/after state snapshots for reversible actions, tracked Gmail filter creation/deletion, and empty-label cleanup after session undo.
- **Safer rule undo** that auto-disables the originating YAML rule after `undo_run` so the same rule does not immediately re-apply.
- **Interactive TUI** for inbox triage, email detail, expanded stats dashboards, rules, and search.
- **Guided setup wizard** for Google Cloud and local OAuth configuration.
- **Demo mode** with realistic seeded data for screenshots, recordings, and safe exploration.

## Rules as code

Rules live in a `rules/` directory. Deploy them, run them against your synced inbox, and undo them if needed.

```yaml
name: label-receipts
description: Label emails that look like receipts
enabled: true
priority: 30

conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - "receipts@stripe.com"
        - "no-reply@paypal.com"
    - field: subject
      contains:
        - "receipt"
        - "order confirmation"
        - "invoice"

actions:
  - type: label
    label: "Receipts"
```

Rules default to dry-run. Pass `--apply` to execute them.

## CLI reference

```bash
# sync and read
inboxctl sync
inboxctl sync --full
inboxctl inbox -n 20
inboxctl search "from:github.com"
inboxctl email <id>
inboxctl thread <thread-id>

# actions
inboxctl archive <id>
inboxctl archive --query "label:newsletters"
inboxctl label <id> Receipts
inboxctl read <id>
inboxctl forward <id> you@example.com
inboxctl undo <run-id>
inboxctl history

# analytics
inboxctl stats
inboxctl stats senders --top 20
inboxctl stats noise --top 20
inboxctl stats newsletters
inboxctl stats uncategorized --confidence high
inboxctl stats unsubscribe --top 20
inboxctl stats anomalies --since 2026-04-01
inboxctl stats volume --period week
inboxctl query --group-by domain --aggregate count unread_rate --sort "count desc"
inboxctl unsubscribe newsletter@example.com --no-archive

# rules
inboxctl rules deploy
inboxctl rules run label-receipts
inboxctl rules run label-receipts --apply
inboxctl rules diff
inboxctl rules undo <run-id>

# filters
inboxctl filters list
inboxctl filters create --from newsletter@example.com --label Newsletters --archive
inboxctl filters delete <id>

# labels
inboxctl labels list
inboxctl labels create Receipts
```

## Configuration

`inboxctl` reads from environment variables in `.env` and persistent settings in `~/.config/inboxctl/config.json`.

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Optional:

```bash
GOOGLE_REDIRECT_URI=http://127.0.0.1:3456/callback
INBOXCTL_GMAIL_TRANSPORT=auto
```

Run `inboxctl setup` for a guided walkthrough.

If you want to configure Google manually:

1. Create or select a Google Cloud project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create a Web application OAuth client.
5. Add `http://127.0.0.1:3456/callback` as an authorized redirect URI.
6. Copy the client ID and client secret into `.env` or `~/.config/inboxctl/config.json`.

Required scopes:

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.labels`
- `https://www.googleapis.com/auth/gmail.settings.basic`
- `https://www.googleapis.com/auth/userinfo.email`

Helpful console links:

- [Google Cloud APIs dashboard](https://console.cloud.google.com/apis/dashboard)
- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
- [Credentials page](https://console.cloud.google.com/apis/credentials)

| Path | Purpose |
|------|---------|
| `~/.config/inboxctl/config.json` | Persistent settings |
| `~/.config/inboxctl/emails.db` | SQLite cache |
| `~/.config/inboxctl/tokens.json` | OAuth tokens |
| `./rules/` | YAML rule definitions |

## Requirements

- Node.js 20 or newer
- A Google Cloud project with OAuth credentials and the Gmail API enabled
- A Gmail or Google Workspace account
- Build tooling for `better-sqlite3`

Native dependency note:

- macOS: install Xcode Command Line Tools with `xcode-select --install`
- Debian or Ubuntu: install `build-essential`
- Windows: install Visual Studio Build Tools with C++ support

## Safety

- No deletion. There is no code path that calls `messages.delete` or `messages.trash`.
- Minimal OAuth scopes: `gmail.modify`, `gmail.labels`, `gmail.settings.basic`, and `userinfo.email`.
- `undo_run` restores recorded label snapshots and auto-disables the originating rule when the run came from a YAML rule.
- `undo_filters` removes inboxctl-created Gmail filters for a run or session, and `cleanup_labels` removes empty `inboxctl/*` labels left behind after undo.
- Dry-run by default for rules.
- Audit trail for every reversible mutation.
- Undo support for reversible actions.

## Development

```bash
npm install
npm run build
npm run lint
npm test
npm run test:coverage
```

### Regenerating the demo recording

```bash
npm run build
vhs demo.tape
```

This writes `demo.gif` at the repo root. It requires [VHS](https://github.com/charmbracelet/vhs).

## License

MIT
