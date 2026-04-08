# Google Auth Setup

`inboxctl` needs a Google Cloud OAuth client before `inboxctl auth login`, Gmail sync, or live MCP operations can work.

## Recommended path

The easiest way to configure a new machine is:

```bash
inboxctl setup
```

The setup wizard can guide the Google Cloud steps and finish by launching the Gmail OAuth sign-in flow.

If you skip sign-in during setup or want to switch accounts later:

```bash
inboxctl auth login
```

If you already have the Google Cloud pieces configured and only want to save credentials locally:

```bash
inboxctl setup --skip-gcloud
```

## Console links

- Google Cloud project and APIs: [console.cloud.google.com/apis/dashboard](https://console.cloud.google.com/apis/dashboard)
- Gmail API page: [console.cloud.google.com/apis/library/gmail.googleapis.com](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- OAuth consent screen: [console.cloud.google.com/apis/credentials/consent](https://console.cloud.google.com/apis/credentials/consent)
- Credentials page: [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
- Gmail Node.js quickstart: [developers.google.com/workspace/gmail/api/quickstart/nodejs](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
- Web application OAuth guidance: [developers.google.com/identity/protocols/oauth2/web-server](https://developers.google.com/identity/protocols/oauth2/web-server)

## What to create

1. Create or select a Google Cloud project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create an OAuth client for local development.
5. Copy the client ID and client secret into local config.

## Recommended OAuth client type

Use a Web application OAuth client with a fixed localhost callback:

`http://127.0.0.1:3456/callback`

The CLI auth flow runs a local callback server, so authorizing one explicit redirect URI keeps local setup predictable.

## Required scopes

`inboxctl` uses these scopes:

- `https://www.googleapis.com/auth/gmail.modify`
- `https://www.googleapis.com/auth/gmail.labels`
- `https://www.googleapis.com/auth/gmail.settings.basic`
- `https://www.googleapis.com/auth/userinfo.email`

## Local config

The easiest setup is an `.env` file based on [`.env.example`](../../.env.example):

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Optional:

```bash
GOOGLE_REDIRECT_URI=http://127.0.0.1:3456/callback
```

You can also persist these values in `~/.config/inboxctl/config.json`.

Example:

```json
{
  "google": {
    "clientId": "your-client-id.apps.googleusercontent.com",
    "clientSecret": "your-client-secret",
    "redirectUri": "http://127.0.0.1:3456/callback"
  }
}
```

## Consent screen notes

- Use Internal if this is only for your own Google Workspace and that is allowed by your organization.
- Use External for a personal Gmail account or broader testing.
- Add yourself as a test user if the app is not published yet.
- The consent screen must be configured before the CLI auth flow will succeed.

## Redirect URI notes

- Add `http://127.0.0.1:3456/callback` to the OAuth client's authorized redirect URIs.
- Keep the same value in `GOOGLE_REDIRECT_URI` or `~/.config/inboxctl/config.json`.

## Gmail transport notes

`inboxctl` includes a Gmail transport boundary:

- `google-api` uses `@googleapis/gmail`
- `rest` uses direct Gmail REST calls with the same OAuth bearer token
- `auto` tries the Google client first and falls back to REST if authenticated Gmail requests fail locally

The recommended default is `auto`.

## Checklist

Before running live Gmail operations, confirm:

- `GOOGLE_CLIENT_ID` is available
- `GOOGLE_CLIENT_SECRET` is available
- The OAuth consent screen is configured
- The Gmail API is enabled
- `http://127.0.0.1:3456/callback` is authorized on the OAuth client
