# SOP 07 — Connection Acceptance Detection

> **Layer A.** Detects when a lead has accepted our sent connection request,
> updates their Notion status from `connecting` → `connected`, and pings Slack.
>
> Replies (DMs) and opt-out detection are out of scope for this SOP — see
> SOP 08 (future) for those. This SOP is **only** about the
> Pending → Accepted transition.

## Goal
For every Notion lead with `status = 'connecting'`, periodically:
1. Open their LinkedIn profile via the stealth-equipped Playwright driver.
2. Inspect the action button in the profile card.
3. If the button says "Message" → the lead has **accepted** us.
4. If the button says "Pending" → still waiting; do nothing.
5. If the button says "Connect" again → the request was withdrawn, declined, or expired; mark as `error` (operator can re-evaluate).

When a lead transitions to `accepted`, write to Notion + post a Slack alert.

## Inputs (per polling run)

```js
{
  // From Notion: every lead currently in `connecting` status
  leads: [{ id, linkedin_url, first_name, last_name, company, title, ... }],
  // From .env: Slack credentials, LinkedIn session
  // From .tmp/.acceptance_last_poll.json: per-lead last-checked timestamps (optional optimization)
}
```

## Polling cadence
- Every 30 minutes during operator business hours (09:00–17:00 America/New_York, Mon–Fri).
- Skipped on weekends, off-hours, or when `./LOCK` exists.
- One scheduled task: `LinkedinLeads-AcceptanceCheck`.

## Per-lead button-state interpretation

| Button visible in profile card | Meaning | New status |
|---|---|---|
| `Message` (no Connect, no Pending) | Lead accepted us — we are now 1st-degree | `connected` ✅ Slack alert |
| `Pending` | Lead has not yet acted on our invite | unchanged |
| `Connect` again | Withdrawn/declined/expired | `error`, reason = `invitation-no-longer-pending` |
| Profile not found | Lead deleted their account | `error`, reason = `profile-not-found` |
| Anti-bot challenge / CAPTCHA | Kill-switch fires | global halt, write `./LOCK` |

Button detection uses the same name-anchored selector logic as
`li_send_connection.mjs` (find buttons in `<main>` whose aria-label contains
the lead's displayed name) to avoid matching sidebar suggestions.

## Slack message format (Block Kit)

On `accepted`:

```
🤝 Karen Lang accepted your connection request

Round Hill Country Club · Membership Services Director

Sent:     2026-05-22 09:15 ET
Accepted: 2026-05-22 14:42 ET (5h 27m after send)

[View in Notion]  [Open LinkedIn profile]
```

The Slack message includes "ts" so we can later edit/thread on it if we add
reply detection (SOP 08).

## Notion writes on acceptance

```js
updateLead(lead.id, {
  status: 'connected',
  last_action_at: <now ISO>,
  last_channel: 'linkedin',
})
appendMessageSent(lead.id, {
  channel: 'linkedin',
  kind: 'acceptance',   // distinct from 'connection' (which is the send) and 'dm'
  at: <now ISO>,
  body: '',             // no message text on acceptance
})
appendNote(lead.id, `[acceptance: detected by run_acceptance_check at <now>]`)
```

The `kind: 'acceptance'` entry in `messages_sent_json` lets the daily digest
count accepts separately from sends.

## Behavior rules
1. **Idempotent.** A lead that has already transitioned to `connected` is never re-checked (the navigator filters `status=connecting` only).
2. **Pacing.** 30-60s randomized sleep between profile loads. Read-only operations can be faster than sends, but still not bot-cadence.
3. **One browser per run.** The navigator opens a single Chromium context, processes all `connecting` leads, closes the browser at the end.
4. **Read-only.** This navigator NEVER clicks anything. It just observes.
5. **Kill-switch identical to send-queue.** Any CAPTCHA/429/security challenge → write `./LOCK` + halt.

## Failure modes (populated as encountered)
*(none yet — first real run will populate this)*

## Cross-references
- Lead state machine + send-queue rules: `architecture/04_send_queue.md`
- LinkedIn driver selectors + kill-switch: `architecture/05_linkedin_driver.md`
- Trigger registration: `architecture/10_triggers.md` (will add the new scheduled task)
- Tool: `execution/tools/li_check_invitations.mjs`
- Tool: `execution/tools/slack_post.mjs`
- Navigator: `execution/nav/run_acceptance_check.mjs`
