# CLAUDE.md — Project Constitution: LinkedIn Leads

> Architectural reference for an automated LinkedIn outreach pipeline.
> Operator-personal details (real names, emails, pitches, channel IDs)
> live in `.env` (gitignored) and are not committed to this repo.

---

## 1. North Star
**Automated outreach pipeline.** Filtered LinkedIn leads are contacted automatically (connection requests, DMs, and/or email handoff), and replies are routed back to the operator for review.

*Success metric:* N personalized touches sent per day, replies surfaced within X minutes, zero account safety incidents. Tune N and X to your own operational ceiling.

## 2. Integrations & Credentials

| Layer | Choice | Credential needed |
|---|---|---|
| LinkedIn outreach engine | Custom **Playwright/Puppeteer** driver | `LI_AT` session cookie + `LI_EMAIL` + `LI_PASSWORD` |
| Email follow-up | **Gmail** OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GMAIL_USER` |
| CRM / lead state | **Notion** integration | `NOTION_TOKEN`, `NOTION_DB_ID` |
| Reply notifications | **Slack** bot | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` |
| Personalization AI | **Claude API** | `ANTHROPIC_API_KEY` |

See [`.env.example`](.env.example) for where each value comes from and [README.md](README.md) for the end-to-end setup walkthrough.

### Safety invariant
Automated outreach against LinkedIn carries account-restriction risk. The pipeline enforces:

- **Daily caps** — connection requests and DMs are capped per day (see `execution/tools/safety_guard.mjs` `DAILY_CAPS`, the single source of truth). Tune conservatively for your account's trust level.
- **Human-like delays** — 60–180s randomized jitter between actions.
- **One browser context per session**, persistent cookies, realistic user agent + viewport.
- **Kill-switch** — any 429 / CAPTCHA / "we've restricted some account features" page → immediately halt, alert Slack, write `LOCK` file. Pipeline refuses to send while `LOCK` exists.
- **Manual review queue** for the first batch of any new campaign — personalized openers wasted on poorly-fit leads are a hard-to-recover learning loss.

## 3. Source of Truth

**CSV files** dropped into `./inbox/` (watched folder). Each file is parsed once, leads upserted into Notion (the working-state CRM), then the file is moved to `./inbox/.processed/` with a timestamp.

### Required CSV columns (minimum)
| Column | Required | Notes |
|---|---|---|
| `linkedin_url` | ✅ | The unique key. Outreach is impossible without this. |
| `first_name` | ✅ | Personalization placeholder. |
| `last_name` | ✅ | Personalization + dedup. |
| `company` | ✅ | Personalization + ICP filtering. |
| `title` | ✅ | Personalization + ICP filtering. |
| `email` | optional | Enables Gmail follow-up; if missing, lead is LinkedIn-only. |
| `industry` | optional | Used by the Claude personalization layer. |
| `notes` | optional | Free-text appended to the lead's Notion row. |

Duplicate-handling rule: if `linkedin_url` already exists in Notion, **skip** (do not overwrite status/history).

## 4. Delivery Payload

Three operator-facing surfaces (push-based):

1. **Slack per-reply message** — fires the moment a lead replies on LinkedIn or via email.
   - Lead identity (name, title, company, LI profile link)
   - The reply text verbatim
   - Claude-drafted suggested response (operator approves or edits)
   - Buttons: `Approve & Send` / `Edit` / `Mark as won` / `Mute lead`

2. **Slack daily digest** — posted at 09:00 operator-local time to the same channel.
   - Counters: `sent_today`, `connections_accepted`, `replies`, `queue_remaining`, `errors`
   - Top 3 hottest replies of the last 24h
   - Any safety alerts (rate-limit hits, login challenges, lock-file state)

3. **Notion CRM row updates** — every state change persists here (background; system of record).

## 5. Behavioral Rules

### Tone
- **Casual, lowercase, conversational** — like texting a peer, not corporate/LinkedIn slop.
- Connection-request notes: **one sentence, 12–25 words, under 150 chars target / 200 chars hard cap**. LinkedIn throttles longer notes.
- Lowercase everything except names, club names, and acronyms.
- **Banned characters in notes:** em-dash, en-dash, ellipsis (AI tells).
- **Banned words in connection notes:** delve, leverage, navigate, ensure, robust, instrumental, well-positioned, comprehensive, drive measurable, member-experience, pivotal, paramount, harness, unlock, elevate, foster, spearhead, "in this rapidly evolving", "given your expertise", responsible for, central to, shape, amplify, visibility, touchpoints. *(Append patterns as new AI-slop surfaces.)*
- **Banned topics in connection notes:** the sales offer itself — services, content, marketing, growth, retention belong in the follow-up DM AFTER acceptance, not the cold opener.
- No emojis, exclamation marks, or question marks in connection notes.
- No claims about results, numbers, or growth metrics.

### Offer (operator-specific — set via env)
- Claude weaves the operator's one-sentence pitch into a personalized first line per lead, using their `title`, `company`, and `industry` for context.
- **Operator pitch:** set in your local copy of [`execution/nav/run_personalize.mjs`](execution/nav/run_personalize.mjs) `SYSTEM` constant.
- **Operator first name:** `OPERATOR_FIRST_NAME` in `.env`.
- **Operator timezone:** `OPERATOR_TIMEZONE` in `.env` (defaults to America/New_York).

### Must-NOT (hard rules — output is blocked if violated)
- Never make health, financial, or legal claims.
- Never message anyone at a company on your Competitor Blocklist.
- Never send on Saturdays or Sundays.
- Never send outside **09:00–17:00 operator local time**.

### Refusal triggers (auto-route to manual review, do not auto-send)
| Trigger | Action |
|---|---|
| Claude personalization returns `confidence < 0.6` or the field is missing | Status → `manual_review` |
| Lead's `company` / `industry` doesn't match ICP gate AND `is_icp` returns `false` | Status → `irrelevant`. Never messaged. Logged in Notion. |
| LinkedIn returns 429 / CAPTCHA / "we've restricted some account features" | **Full stop.** Write `./LOCK`. Slack alert. No LI actions until operator deletes `LOCK`. |
| Reply contains: `unsubscribe`, `stop`, `remove me`, `not interested`, `do not contact` (case-insensitive) | Lead status → `muted`. Never messaged again. |

### ICP Relevance Gate

Every CSV row passes a relevance check **before** being queued. The default gate is configured for member-owned private clubs (tennis, country, golf, athletic, pickleball, racquet) — tune [`execution/tools/icp_filter.mjs`](execution/tools/icp_filter.mjs) `TRIGGER_WORDS` and target titles for your own ICP.

Fallback for ambiguous companies (no trigger word match): a Claude relevance call returns `is_icp: bool` with `confidence: 0–1`. If `confidence < 0.7` → `manual_review` status; if `is_icp: false` → `irrelevant`, never messaged.

---

## 6. Data Schema *(LOCKED — change with caution)*

### 6.1 Input — one row from a CSV in `./inbox/`
```json
{
  "linkedin_url": "https://www.linkedin.com/in/jane-doe-1234/",
  "first_name": "Jane",
  "last_name": "Doe",
  "company": "Acme Co.",
  "title": "VP of Operations",
  "email": "jane@acme.com",
  "industry": "Industrial Equipment",
  "notes": "Met at NAM 2026"
}
```
Required: `linkedin_url`, `first_name`, `last_name`, `company`, `title`. Other fields nullable.

### 6.2 Internal — the Notion `Lead` record (system of record)
```json
{
  "id": "uuid-v4",
  "linkedin_url": "https://www.linkedin.com/in/jane-doe-1234/",
  "first_name": "Jane",
  "last_name": "Doe",
  "company": "Acme Co.",
  "title": "VP of Operations",
  "email": "jane@acme.com",
  "industry": "Industrial Equipment",
  "status": "queued | connecting | connected | messaged | replied | won | muted | error",
  "campaign": "string (campaign name)",
  "personalized_first_line": "string (Claude-generated)",
  "messages_sent": [
    { "channel": "linkedin|email", "at": "ISO-8601", "body": "...", "kind": "connection|dm|email" }
  ],
  "replies": [
    { "channel": "linkedin|email", "at": "ISO-8601", "body": "...", "surfaced_to_slack_ts": "1700000000.000100" }
  ],
  "last_action_at": "ISO-8601",
  "next_action_at": "ISO-8601",
  "error": "string|null"
}
```

### 6.3 Output A — Slack per-reply message
```json
{
  "channel": "C0XXXXXX",
  "lead_id": "uuid-v4",
  "blocks": [
    { "type": "header", "text": "Jane Doe (VP Ops, Acme Co.) replied" },
    { "type": "section", "text": "*Reply:* …verbatim…" },
    { "type": "section", "text": "*Suggested response (Claude):* …draft…" },
    { "type": "actions", "elements": ["Approve & Send", "Edit", "Mark won", "Mute"] }
  ]
}
```

### 6.4 Output B — Slack daily digest (09:00 operator-local)
```json
{
  "channel": "C0XXXXXX",
  "date": "2026-05-18",
  "counters": {
    "sent_today": 0,
    "connections_accepted": 0,
    "replies": 0,
    "queue_remaining": 0,
    "errors": 0
  },
  "top_replies": [{ "lead_id": "uuid", "snippet": "..." }],
  "safety_alerts": ["string"]
}
```

### 6.5 Output C — outbound LinkedIn / Email action
```json
{
  "lead_id": "uuid-v4",
  "channel": "linkedin|email",
  "kind": "connection|dm|email",
  "body": "string (final text after Claude personalization)",
  "send_at": "ISO-8601 (jittered)",
  "dry_run": true
}
```
`dry_run` defaults to `true`. Flip to `false` in `.env` only after you've validated outputs in the dashboard.

---

## 7. Architectural Invariants (A.N.T.)
- **Architecture (`/architecture/`)** — SOPs in markdown. If logic changes, update the SOP **before** the code.
- **Navigation (`/execution/nav/`)** — routing/decision layer only. Allowed to call LLMs.
- **Tools (`/execution/tools/`)** — deterministic, atomic scripts. No LLM calls inside business logic.
- All intermediate files route through `/.tmp/` (gitignored).
- Credentials live in `.env` (gitignored). Never inline secrets.

## 8. Triggers (firing mechanism)

Three Windows Task Scheduler jobs, all routed through [`scripts/run_job.ps1`](scripts/run_job.ps1):

| Job | Cadence | Job-side safety |
|---|---|---|
| `LinkedinLeads-Ingest` | every 5 min, 24/7 | none needed — no outreach |
| `LinkedinLeads-Personalize` | every 15 min, 09:00–17:00 Mon–Fri | none needed — LLM-only |
| `LinkedinLeads-Send` | every 10 min, 09:00–17:00 Mon–Fri | full SOP 04 safety gate runs *inside* the job too |

Registration command, monitoring, and stop conditions: see [`architecture/10_triggers.md`](architecture/10_triggers.md).

> Reply detection and Slack-interactive approvals are scaffolded but not yet wired end-to-end. The pipeline as-shipped can ingest leads, classify them via the ICP gate, personalize openers with Claude, and queue LinkedIn outreach.

---

## License
MIT — see [LICENSE](LICENSE).
