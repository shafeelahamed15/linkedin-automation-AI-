# SOP 04 — Send Queue (Outbound Scheduler & Safety Gate)

> **Layer A.** The single chokepoint through which every outbound LinkedIn or
> email action must pass. Implements every safety invariant from `CLAUDE.md §2`.
> If the safety rules change, update this SOP **before** the code.

## Goal
Pick eligible leads, decide the next outbound action per lead, run them through
a **deterministic safety gate**, and either dry-run (log only) or execute (call
SOP 05 / SOP 06 tools). Persist results to Notion. Never exceed the daily caps.
Halt the entire system on a safety alert.

## Lead state machine (relevant transitions)

```
queued ── send connection request ──▶ connecting
connecting ── (out of scope for A.3, handled in A.4) ──▶ connected
connected ── send DM ──▶ messaged
messaged   ── (reply detection in A.4) ──▶ replied | (timeout) ──▶ email_followup
replied | muted | won | irrelevant | error | manual_review ── terminal for sender ──
```

A.3 implements only the bold transitions:
- `queued → connecting` (one connection request)
- `connected → messaged` (one DM, requires connection already accepted)

## Eligibility query (deterministic)

A lead is "eligible to send" iff **all** are true:
- `status` is one of `queued` or `connected`
- `personalized_first_line` is non-empty (from SOP 03)
- `next_action_at` is `null` OR `<= now`
- For `queued`: lead has not previously been sent a `connection`
- For `connected`: lead has not previously been sent a `dm`

(Eligibility is computed in the navigator; tools just write what they're told.)

## Safety gate (ALL must pass before send)

| Check | Rule | Source |
|---|---|---|
| **A. Quiet hours**  | now's `HH:mm` in `OPERATOR_TIMEZONE` is between `09:00` and `17:00` | CLAUDE.md §5 |
| **B. Weekend**      | now's day-of-week in `OPERATOR_TIMEZONE` is **not** Sat or Sun | CLAUDE.md §5 |
| **C. Daily caps**   | today's `connection` sends < **50** (burner); today's `dm` sends < **80** | `safety_guard.mjs` `DAILY_CAPS` |
| **D. Weekly caps** *(added 2026-05-20)* | last-7-days `connection` sends < **150**; `dm` sends < **240**. Catches sustained-volume failure modes that daily caps miss. | `safety_guard.mjs` `WEEKLY_CAPS` |
| **E. LOCK file**    | `./LOCK` does **not** exist | CLAUDE.md §2 + SOP 05 |
| **F. Acceptance health** *(added 2026-05-20)* | If `sent_last_7_days >= 20` AND `acceptance_rate < 10%` → halt + write LOCK + Slack alert. Below the 20-send sample threshold the check abstains. | `acceptance_health.mjs` |
| **G. Jitter**       | last successful send was `>= 60s` ago (the navigator sleeps `60–180s` between sends; this check guards reruns) | CLAUDE.md §2 |

Any failure → no send in this run. Log the reason; do not write any state to
Notion (so the lead remains eligible on the next sweep).

### Why acceptance-rate auto-halt (Check F)
A sudden drop in acceptance rate is the **earliest detectable signal** that LinkedIn has shadow-throttled the burner. By the time you notice manually that fewer leads are accepting, you've already burned weeks of warmup. The 10% / 20-sample threshold balances false positives (small sample noise) against catch-early-enough-to-recover.

### Behavioral evasion (added 2026-05-20)
Before any lead is processed, the navigator runs `warmSession()` (`execution/tools/li_warm_session.mjs`) which:
1. Loads the LinkedIn feed
2. Scrolls 2-4 times with random pauses
3. Visits the notifications page
4. Returns to feed and scrolls once more

Total wall-clock: ~20-40 seconds at the start of each batch. The purpose is to make the session look like a normal LinkedIn visit (that happens to include some outreach) rather than a bot run that opens browser → fires connect → closes.

## Counters — daily reset

Day boundary = midnight in `OPERATOR_TIMEZONE`. The counter is **derived**
from `messages_sent_json` in Notion (filter by today + kind), not stored
separately. This way the counter survives crashes and matches reality.

## Dry-run vs live

`DRY_RUN=true` (default in `.env`):
- No browser is launched. No HTTP requests to LinkedIn. No Notion writes
  related to the action (counters do not advance).
- The intended action is printed to stdout AND appended to
  `.tmp/dry_run_log/YYYY-MM-DD.jsonl` for review.
- The safety gate **still runs** so we know whether the action *would* have
  passed.

`DRY_RUN=false`:
- Tool calls execute for real.
- Each successful send writes:
  - `messages_sent_json` (append `{ channel, at, body, kind }`)
  - `status` (`connecting` or `messaged`)
  - `last_action_at` = now
  - `next_action_at` = (for `connecting`) null; (for `messaged`) null
  - `last_channel` = `linkedin`
- On send failure: log to `.tmp/send_errors/`, set `status=error`, `error=<msg>`.

## Pacing

Between two successful sends, the navigator sleeps a random `60–180s` to
simulate human cadence. This makes the longest plausible batch = `25 * 180s ≈
75 min`, well within the 8-hour 09:00–17:00 window.

## Order of operations per invocation

```
1. Refresh `today_counts` from Notion.
2. If LOCK exists OR weekend OR out-of-hours → log + exit.
3. List eligible leads (capped at min(remaining_connection, remaining_dm)).
4. For each lead:
   a. Re-check counts (might have changed mid-batch).
   b. Decide action: connection-request OR dm.
   c. Build body:
      - connection: connection_note = personalized_first_line truncated to 280 chars
        (LinkedIn caps notes at 300; we leave headroom).
      - dm: { line1: personalized_first_line, body: SOP_05_TEMPLATE }
   d. Call the relevant tool (dry-run or live).
   e. On success: write Notion updates.
   f. Sleep 60–180s random jitter.
5. Print summary.
```

## What this SOP does **not** cover
- The Playwright selectors / page interactions — see SOP 05.
- Reply detection — SOP 07.
- Email follow-up — SOP 06.
- Connection-accept detection (queued → connected transition) — SOP 07.

## Failure modes (populated as encountered)

### 2026-05-20 — Failures bypassed jitter; 8 rapid attempts looked bot-like
- **Symptom:** First live `DRY_RUN=false` run processed 8 leads in ~3 minutes (screenshots at 18:30:25, 18:30:51, 18:31:18, … all under 30s apart). All 8 failed. After the 8th the npm process hung indefinitely, freezing the scheduler.
- **Root causes (two):**
  1. **Jitter skipped on failures.** The per-lead loop used `continue` after `!res.ok` and after caught exceptions, jumping past the `jitterMs() + sleep()` block. Successes hit jitter; failures did not. So a queue of leads where most fail (e.g., 5 fake test URLs + Bruce's no-Connect profile) drives back-to-back requests at LinkedIn's anti-bot radar's most sensitive cadence.
  2. **Process hang after last lead.** A dangling Playwright handle kept the Node process alive after `main()` returned. The PS wrapper's `Out-String | Add-Content` waits on the pipe to close — which never happened — so heartbeat/log writes never fired and the next scheduled runs queued behind a still-running process.
- **Fix:**
  1. In `execution/nav/run_send_queue.mjs`, removed both `continue` statements after failure branches. Jitter now runs for **successes, failures, and exceptions** — only `KillSwitchTriggered` bypasses it (via `break`).
  2. Added explicit `process.exit(0)` to the success path of `main()` to prevent dangling handles from blocking process exit.
- **Phase-T hardening for next time:** the PS wrapper should bound the total npm runtime (e.g., `-Timeout 600`) and force-kill on overrun. Not done yet — tracked in `progress.md`.
- **Damage from the incident:** none real. All 8 sends failed at the find-Connect step, so no connection requests went out to anyone (correct or incorrect). 5 fake test leads (Jane Doe, Bob Smith, Carol Green, Dan Pickle, Inga Patel) were dropped to `irrelevant`. 6 real leads (Bruce + 5 club staff) were reset to `queued`.

## Cross-references
- Safety invariants: `CLAUDE.md §2`
- Driver: `architecture/05_linkedin_driver.md`
- Tools: `execution/tools/safety_guard.mjs`, `execution/tools/lead_counts_today.mjs`,
  `execution/tools/li_send_connection.mjs`, `execution/tools/li_send_dm.mjs`,
  `execution/tools/append_message_sent.mjs`
- Navigator: `execution/nav/run_send_queue.mjs`
