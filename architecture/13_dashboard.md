# SOP 13 — Pipeline Dashboard (localhost:3000)

> **Layer A.** Operator-facing visualization. Read-only — the dashboard never
> writes to Notion, never triggers sends, never modifies the pipeline. If you
> want to act on what you see, use the existing CLI scripts.

## Goal
A single browser-based view that answers, at a glance: *what's the pipeline doing right now, what has it done, and is anything wrong?*

## Architecture

```
┌────────────────────┐    GET /api/snapshot     ┌──────────────────────┐
│ public/index.html  │ ───────────────────────► │  dashboard/server.mjs│
│ public/styles.css  │                          │  (Express @ :3000)   │
│ public/app.js      │ ◄──────── JSON ───────── │                      │
└────────────────────┘                          └──────────┬───────────┘
                                                            │
                                            ┌───────────────┼──────────────┐
                                            ▼               ▼              ▼
                                       Notion API      Local files    PowerShell
                                     (leads, opens,   (LOCK, session, (Get-ScheduledTask
                                      messages,        heartbeat logs)  for task state)
                                      replies)
```

- Static front-end (no build step, no framework). Single HTML file, single CSS file, single JS file.
- One Express server (`dashboard/server.mjs`) on `127.0.0.1:3000` — localhost-only by design.
- One API endpoint: `GET /api/snapshot`. Returns the full state needed for every panel.
- Server-side cache (15s TTL) on the snapshot so the auto-refresh doesn't hammer Notion or spawn excess PowerShell processes.
- Client polls `/api/snapshot` on load and every 30 seconds; manual refresh button forces a fresh fetch.

## Why a single fat snapshot endpoint
Multiple small endpoints would race each other and surface inconsistent state (e.g. funnel says "6 queued" while the activity feed shows a send that just happened). One endpoint = one consistent view of the world at a single point in time.

## Data sources

| Panel | Source |
|---|---|
| Pipeline status pill | LOCK file + safety gate state (`evaluateSafety` semantics replicated) |
| Today's send counters | `countSentInWindow(now, TZ, 1)` (same tool the safety gate uses) |
| 7-day send counters | `countSentInWindow(now, TZ, 7)` |
| Acceptance rate | `evaluateAcceptanceHealth(now, TZ)` |
| Lead funnel | Notion query → group by `status` |
| Lead table | Notion query → full property set |
| Activity feed | Notion `messages_sent_json` + `replies_json` arrays, merged + sorted desc |
| Safety state list | `safety_guard.mjs` re-exports (`localParts`, `isWithinHours`, `isWeekend`, `checkLock`) |
| Scheduled tasks | `Get-ScheduledTask` + `Get-ScheduledTaskInfo` shelled out via `execFile('powershell.exe', …)` |
| Heartbeats | `.tmp/triggers/*.last.log` mtime + content |
| Session file | `fs.statSync('linkedin_storage_state.json')` |

The dashboard imports the **same** safety / counter / acceptance tools the pipeline uses. There is one source of truth — if the safety gate says "in window", the dashboard says the same thing.

## Running it

```powershell
npm run dashboard
```

Then open <http://localhost:3000>. The server logs `Dashboard ready → http://localhost:3000` when it's up.

Per the operator's global rule ("always run on localhost 3000") this is the only port used. If port 3000 is in use, the script will error — stop the conflicting process first.

## What each panel shows

- **Top bar status pills:**
  - `OPERATIONAL` (green) / `IDLE — out of window` (grey) / `HALTED — LOCK active` (red)
  - `DRY-RUN MODE` (yellow) or `LIVE` (blue)
  - "Send window open" or "Next window in 7h"
- **Stat cards (row 1):** Today connections, Today DMs, 7-day connections, Acceptance rate.  Each shows used / cap, a fill bar (green → yellow → red as you approach cap), and slots remaining.
- **Lead pipeline (row 2 left):** Horizontal bar funnel — queued, connecting, connected, messaged, replied, won, manual_review, muted, irrelevant, error.
- **Safety state (row 2 right):** Send window status, weekend status, LOCK state, operator-local time, DRY_RUN flag, LinkedIn session file size, acceptance health, and (when closed) next-window countdown.
- **Scheduled tasks (row 3 left):** Each LinkedinLeads-* task with State (Ready/Disabled/Running), LastTaskResult (✓ 0 / ✗ N / running), and relative LastRunTime. Footer shows heartbeat timestamps for each job.
- **Recent activity (row 3 right):** Newest-first feed of sends + replies, with relative timestamps and message-body previews. Max 20 events.
- **Leads table (row 4):** All leads, filterable by status chip. Click a row to expand — shows the full LinkedIn URL, email, the personalized opener verbatim, and any error message.

## What it does NOT do
- No write operations. Cannot start sends, cannot mark leads as muted, cannot edit Notion. (Adding write operations would require auth + CSRF + audit logging, which is out of scope for this read-only tool.)
- No login screen. Bound to `127.0.0.1` — accessible from this machine only. Do not expose to the network.
- No alerts. If something goes red, the operator sees it next time they look. Real alerts go through Slack via the existing pipeline.

## Failure modes (populated as encountered)

### How to diagnose "Connection lost" pill in the UI
The pill turns red and says "CONNECTION LOST" if `/api/snapshot` returns non-2xx or fails to parse. Check:
1. Is the server still running? `Get-Process node` should show it.
2. Tail the dashboard output: the server prints `snapshot error:` lines to stdout when Notion or PowerShell calls fail.
3. Hit `/api/health` — returns `{ok:true}` if Express is alive but Notion is broken.

## Cross-references
- Safety logic: `architecture/04_send_queue.md`, `execution/tools/safety_guard.mjs`
- Lead status states: `architecture/04_send_queue.md` §"Lead state machine"
- Triggers (what the scheduled task panel reflects): `architecture/10_triggers.md`
- Pre-flight before live runs: `architecture/12_live_run_playbook.md` §A
