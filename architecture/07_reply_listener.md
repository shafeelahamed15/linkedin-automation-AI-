# SOP 07 — Reply Listener

> **Layer A.** Polls LinkedIn messaging and Gmail for incoming responses from leads we have outreached, detects connection acceptances, applies opt-out rules, and records replies into Notion for downstream Slack delivery (SOP 08).
> If a polling interval, opt-out keyword, or DOM selector changes, update this SOP **before** the code.

## Goal
Run on a schedule (Phase T cron). On each invocation:
1. Poll LinkedIn `/messaging/` for new activity in any conversation matching a lead whose `status` is `connecting` or `messaged`.
2. Poll Gmail for messages received from email addresses matching a lead whose `status` is `messaged` (sent via email) or any lead with email + status in (`connecting`, `messaged`).
3. Apply the **opt-out detector** to every detected reply.
4. Update Notion:
   - Append reply to `replies_json`
   - Transition `status` (`connecting → connected` on connection-acceptance; `connecting|messaged → replied` on first textual reply; any → `muted` on opt-out keyword)
   - Leave `surfaced_to_slack_ts` empty per reply → Slack notifier (SOP 08) will populate it.
5. Persist new "last polled" timestamps to `./.tmp/last_reply_poll.json`.

## Inputs / state

- **Notion DB** — read leads in status (`connecting`, `messaged`); read existing `replies_json` to dedupe.
- **`./.tmp/last_reply_poll.json`** — per-channel high-water marks. First run defaults to `now - 24h`. Updated only after a successful sweep on that channel.
- **`linkedin_storage_state.json`** — Playwright session.
- **Gmail OAuth refresh token** — already verified Phase L.

## Opt-out keyword list

Case-insensitive substring on the reply body:

```
unsubscribe, stop, remove me, not interested, do not contact, take me off,
no thanks, please remove
```

Any match → status flips to `muted`, `last_action_at` set, note appended `[opt-out: <keyword>]`. The reply is **still recorded** in `replies_json` (we want the operator to see what was said), but no further outbound action will ever fire for this lead.

## State transitions resolved by this SOP

| From            | Trigger                                                                 | To           |
|---|---|---|
| `connecting`    | LI inbox shows an existing conversation OR a known thread (proves connection was accepted) | `connected` |
| `connecting`    | LI inbox shows the above AND the latest message is from the lead       | `replied`   |
| `messaged`      | LI new inbound message from the lead                                    | `replied`   |
| `messaged`      | Gmail new inbound from the lead's email                                 | `replied`   |
| any (above)     | The new reply body contains an opt-out keyword                          | `muted`     |

## LinkedIn polling (selectors — current 2026-05)

Navigate: `https://www.linkedin.com/messaging/?filter=unread` (also try without filter as fallback).

| Step | Primary selector | Notes |
|---|---|---|
| Conversation list rows | `li.msg-conversation-listitem` | Each row has the partner name + preview |
| Partner name on row | `.msg-conversation-listitem__participant-names` | Plain text, may include "•" separators for multi-party |
| Most recent message snippet | `.msg-conversation-card__message-snippet` | First 60 chars of the latest message |
| Time-since stamp | `time.msg-conversation-listitem__time-stamp` | Relative; we re-fetch `datetime` attr if present |
| Click into thread | (entire `li`) | Opens `/messaging/thread/<id>/` |
| Thread messages | `.msg-s-event-listitem` | Repeats; each has sender + body |
| Sender of a message | `.msg-s-message-group__name` | Persistent group header by sender |
| Body of a message | `.msg-s-event-listitem__body` | Inner text; preserve line breaks |
| Timestamp of a message | `time.msg-s-message-group__timestamp` | `datetime` attribute is ISO-8601 |

The driver only opens threads matching a known lead (name + LI URL match — name is checked first as a cheap filter, URL match via the link inside the thread header is the authoritative confirmation).

## Gmail polling (Gmail API)

Query (Gmail search syntax):
```
in:inbox -from:me newer_than:7d
```
Then for each message returned:
- Read `From` header → extract email address
- Lookup in Notion: any lead whose `email` matches (case-insensitive)
- If match, fetch the full message body via `gmail.users.messages.get(format='full')`
- Extract plaintext body (parse multipart; prefer `text/plain` over `text/html`)
- Apply opt-out detector
- Append to `replies_json` if its `Message-Id` is not already recorded

## Idempotency / dedup

Each `replies_json` entry stores `{ channel, at, body, message_id, surfaced_to_slack_ts: null }`. Before appending a new reply, check whether the `message_id` already exists in the array.

`message_id` is:
- LinkedIn: `${thread_id}__${message_index}` (best-effort; LI doesn't expose stable per-message IDs in DOM. Combined with `at` ISO it's unique enough.)
- Gmail: the `Message-Id` MIME header.

## Output for Slack (SOP 08 reads this)

Each new reply with `surfaced_to_slack_ts == null` is the queue for the Slack notifier. SOP 08 (next sub-phase) will pick these up, post to the channel, and back-fill the `surfaced_to_slack_ts` timestamp.

## Failure modes (populated as encountered)
*(none yet)*

## Cross-references
- LI kill-switch: SOP 05 §"Action 3" — same triggers apply to the messaging-inbox navigation.
- Slack delivery: `architecture/08_slack_responder.md` (next sub-phase).
- Tools: `execution/tools/li_check_inbox.mjs`, `execution/tools/gmail_check_inbox.mjs`,
  `execution/tools/detect_opt_out.mjs`, `execution/tools/append_reply.mjs`
- Navigator: `execution/nav/run_reply_listener.mjs`
