# LinkedIn Automation


An automated LinkedIn outreach pipeline with safety rails, ICP filtering, Claude-personalized openers, and human-in-the-loop reply review.

Drop a CSV of leads into `./inbox/`, and the pipeline:
1. **Ingests** the CSV → upserts each row into a Notion CRM
2. **Filters** through an ICP gate (deterministic + Claude fallback)
3. **Personalizes** the connection-request opener with Claude
4. **Sends** connection requests / DMs via a Playwright LinkedIn driver — with daily caps, randomized delays, business-hours-only sending, and a kill-switch
5. **Surfaces replies** to Slack with a Claude-drafted suggested response

A localhost dashboard shows live counters, safety state, and a per-lead activity feed.

---

## Status

Working today: ingest → ICP filter → personalize → queue → LinkedIn connection requests + DMs (dry-run safe by default).
On the roadmap: end-to-end reply detection, Slack-interactive approvals, Gmail follow-up sender.

Pipeline is currently **halted** (LOCK file present + Windows scheduled tasks disabled) so it does nothing until you intentionally re-enable it.

---

## Architecture

This project follows a strict three-layer separation (A.N.T.):

| Layer | Folder | Allowed to do |
|---|---|---|
| **A**rchitecture | `architecture/` | SOPs in markdown. If you change behavior, update the SOP first. |
| **N**avigation | `execution/nav/` | LLM calls + orchestration. Decides *what* to do. |
| **T**ools | `execution/tools/` | Deterministic functions. No LLM calls in business logic. |

The full project constitution is in [CLAUDE.md](CLAUDE.md). It documents the data schema, behavioral rules, safety invariants, and trigger setup.

---

## Getting started

### 1. Prerequisites
- **Node.js 22+** and **npm 10+** (`node --version`, `npm --version`)
- **Git** (you already have it if you're reading this on GitHub)
- A Windows machine if you want the Task Scheduler triggers to "just work" (they're optional — you can run the navigators manually too)

### 2. Clone and install
```bash
git clone https://github.com/shafeelahamed15/linkedin-automation-AI-.git
cd linkedin-automation-AI-
npm install
npx playwright install chromium
```

### 3. Create your `.env`
```bash
cp .env.example .env
```
Then open `.env` and fill in your credentials. Each one has a comment pointing to where it comes from:

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ → API keys |
| `NOTION_TOKEN` | https://www.notion.so/my-integrations → New integration |
| `NOTION_DB_ID` | Run `npm run notion:create-db` after the token is in place |
| `SLACK_BOT_TOKEN` | https://api.slack.com/apps → your app → OAuth & Permissions |
| `SLACK_CHANNEL_ID` | Right-click a Slack channel → View channel details |
| `GOOGLE_*` | https://console.cloud.google.com/ → OAuth Desktop client. Then `npm run gmail:authorize` to mint a refresh token. |
| `LI_EMAIL` / `LI_PASSWORD` | A LinkedIn account you control. Then `npm run linkedin:capture` to save the session cookie. |

### 4. Verify everything is wired up
```bash
npm run probe:all
```
This script pings each integration and prints a green/red line per credential. Fix anything red before continuing.

### 5. Personalize the prompts to YOUR offer
This repo ships with example prompts targeting member-owned private clubs. Replace them with your own niche:

- **The outreach voice + offer** → [`execution/nav/run_personalize.mjs`](execution/nav/run_personalize.mjs) `SYSTEM` constant
- **The ICP gate (trigger words + target titles)** → [`execution/tools/icp_filter.mjs`](execution/tools/icp_filter.mjs)
- **The reply-drafting voice** → [`execution/nav/run_slack_notify.mjs`](execution/nav/run_slack_notify.mjs) `SYSTEM` constant
- **Daily caps** → [`execution/tools/safety_guard.mjs`](execution/tools/safety_guard.mjs) `DAILY_CAPS`. Start low (5–10/day) on a new account.

### 6. Dry-run first
`.env` ships with `DRY_RUN=true`. Drop a CSV into `./inbox/` (see [samples/sample_leads.csv](samples/sample_leads.csv) for the format) and run:

```bash
npm run ingest
npm run personalize
npm run send
```

Watch what *would have* been sent in `./.tmp/dry_run_log/<YYYY-MM-DD>.jsonl`. Spin up the dashboard to see live state:

```bash
npm run dashboard
# → http://localhost:3000
```

Only after the dry-run output looks right, flip `DRY_RUN=false` in `.env` to go live.

### 7. Optional: schedule with Windows Task Scheduler
See [`architecture/10_triggers.md`](architecture/10_triggers.md) for the exact `Register-ScheduledTask` commands. Three jobs total: ingest (every 5 min), personalize (every 15 min, business hours), send (every 10 min, business hours).

---

## Project layout

```
.
├── CLAUDE.md                  # Project constitution — rules, schema, safety
├── README.md                  # You are here
├── LICENSE                    # MIT
├── GITHUB_BASICS.md           # First-time-on-GitHub guide
├── package.json               # npm scripts + dependencies
├── .env.example               # Credential template (copy to .env)
├── .gitignore                 # What never goes to git
├── LOCK                       # Kill-switch file. If it exists, the pipeline refuses to send.
│
├── architecture/              # Markdown SOPs — update BEFORE changing code
│   ├── 00_credentials.md
│   ├── 01_ingest.md
│   ├── 02_icp_gate.md
│   ├── 03_personalize.md
│   ├── 04_send_queue.md
│   ├── 05_linkedin_driver.md
│   ├── 06_gmail_followup.md
│   ├── 07_acceptance_check.md
│   ├── 07_reply_listener.md
│   ├── 08_slack_responder.md
│   ├── 10_triggers.md
│   └── 13_dashboard.md
│
├── execution/
│   ├── probe/                 # Credential sanity-checkers (npm run probe:*)
│   ├── setup/                 # One-shot setup scripts (auth flows, DB creation)
│   ├── nav/                   # Navigators — orchestration + LLM calls
│   └── tools/                 # Deterministic tools — pure functions, no LLM
│
├── dashboard/                 # localhost:3000 status UI
├── scripts/                   # Windows Task Scheduler wrappers (PowerShell)
├── samples/                   # Sample CSVs to play with
└── inbox/                     # Watched folder — drop your CSVs here
```

---

## Safety

Every send goes through [`execution/tools/safety_guard.mjs`](execution/tools/safety_guard.mjs) which checks:
- **Lock file** — if `./LOCK` exists, refuse to send
- **Business hours** — 09:00–17:00 in `OPERATOR_TIMEZONE`, Mon–Fri only
- **Daily caps** — `connection`, `dm`, `email` separately
- **Weekly caps** — catches "max-every-day" bot-like patterns
- **Per-lead lockout** — won't re-message a lead inside the cooldown window

If LinkedIn returns 429, CAPTCHA, or a "we've restricted some account features" page, the driver immediately writes `LOCK`, posts a Slack alert, and exits. You delete `LOCK` manually after investigating.

---

## License

MIT — see [LICENSE](LICENSE). Use, modify, fork, ship as your own — just don't blame anyone here if LinkedIn bans your account. Tune caps conservatively.
