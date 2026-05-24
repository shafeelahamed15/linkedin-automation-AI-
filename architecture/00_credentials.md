# SOP 00 — Credential Lifecycle

> **Layer A (Architecture).** Governs how credentials are created, stored, rotated, and probed.
> If anything about credential handling changes, update this SOP **before** the code.

## Goal
Every external service this pipeline talks to has exactly one **named credential** in `.env`. Every credential has a **probe script** in `/execution/probe/`. Phase L is complete only when `npm run probe:all` exits 0.

## Inventory

| # | Service | `.env` keys | Probe | Created via |
|---|---|---|---|---|
| 1 | Claude API | `ANTHROPIC_API_KEY` | `npm run probe:anthropic` | console.anthropic.com |
| 2 | Notion | `NOTION_TOKEN`, `NOTION_DB_ID` | `npm run probe:notion` | notion.so/my-integrations |
| 3 | Slack | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` | `npm run probe:slack` | api.slack.com/apps |
| 4 | Gmail | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `npm run probe:gmail` | console.cloud.google.com → run `npm run gmail:authorize` |
| 5 | LinkedIn (storage state) | `LI_EMAIL`, `LI_PASSWORD` + `linkedin_storage_state.json` | `npm run probe:linkedin` | Run `npm run linkedin:capture`, log in manually |

## Rules
1. **No inline secrets.** Every credential lives in `.env` (gitignored). Code reads them via `dotenv/config`.
2. **`.env.example`** mirrors `.env` with empty values; this is the only file committed to git.
3. **Probes are read-only / minimal-write.** Slack probe is the only one that writes externally (posts one test message) — that's intentional so the user knows it works.
4. **Probe scripts MUST exit non-zero on failure.** `probe:all` aggregates and gates Phase A.
5. **Rotation:** any credential rotated → re-run its probe → update `progress.md` with new green timestamp.
6. **LinkedIn session expires** (typically 30–90 days). When `probe:linkedin` fails with redirect to `/login`, run `npm run linkedin:capture` again.

## Order of acquisition (recommended for new operators)
1. **Anthropic** — instant. Get the API key, paste, probe.
2. **Notion** — 5 min. Create integration → create Leads DB → share DB with integration → probe.
3. **Slack** — 10 min. Create app → add scopes (`chat:write`, `channels:read`) → install to workspace → invite bot to channel → probe.
4. **Gmail OAuth** — 15 min. Google Cloud project → enable Gmail API → OAuth consent screen → OAuth client → run `gmail:authorize` → paste refresh token → probe.
5. **LinkedIn** — 5 min. `linkedin:capture` opens browser, log in manually, probe.

## Failure modes that we have already seen

### Anthropic
| Error | Root cause | Fix |
|---|---|---|
| `400 invalid_request_error: "Your credit balance is too low..."` | Account has $0 balance even though the key is valid. Auth layer passes, billing layer rejects. | Add credits at console.anthropic.com/settings/billing. Wait 1–5 min for propagation. |
| `401 authentication_error: "invalid x-api-key"` after funding | Multi-org account: API key was created in org A, credits were added to org B. Anthropic isolates billing per-org. | In the console, switch to the funded org via the workspace switcher (top-left), create a new key there, paste into `.env`. |
| Anthropic only shows the full key **once** at creation. Dashboard masks to `sk-ant-api03-xxx...yyy` afterward. | Security by design. | If you didn't copy the key at creation, the value is permanently unrecoverable — create a new one, copy immediately. |

### Slack
| Error | Root cause | Fix |
|---|---|---|
| Got a `xoxp-` (User OAuth) token instead of `xoxb-` (Bot User OAuth) | OAuth scopes were added under the "User Token Scopes" table on Slack's OAuth & Permissions page instead of the "Bot Token Scopes" table. | Either: (a) accept the `xoxp-` token — messages will be posted as the user, fine for internal alerts; or (b) delete the user-scope, add scopes under Bot Token Scopes, click "Reinstall to Workspace" to get a `xoxb-` token. |

### Gmail / Google
| Error | Root cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` during OAuth flow | The redirect URI in Google Cloud Console doesn't match `http://localhost:3000/oauth2callback` exactly — usually a typo, wrong protocol, trailing slash, or pasted into "Authorized JavaScript origins" instead. | Open Cloud Console → Credentials → click OAuth client → confirm `http://localhost:3000/oauth2callback` is in **Authorized redirect URIs** (not origins). Save. Wait 30–60s. |
| `EADDRINUSE: address already in use :::3000` | Previous `gmail:authorize` script crashed without releasing port 3000. | `netstat -ano \| grep :3000` to find PID → `taskkill /PID <pid> /F` to kill it. Then rerun. |
| `Delegation denied for <other-email>` from `gmail.users.getProfile` | OAuth was authorized as account A, but `GMAIL_USER` in `.env` points at account B. Google won't let user A access user B's mailbox without domain-wide delegation. | Either update `GMAIL_USER` to match the account that authorized, or redo `npm run gmail:authorize` while signed into the intended account. |
