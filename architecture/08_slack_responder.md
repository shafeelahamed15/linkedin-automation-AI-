# SOP 08 — Slack Responder (per-reply alerts + daily digest)

> **Layer A.** Surfaces inbound replies and daily activity counters to the
> operator's Slack channel.
> If the message format or the suggestion-prompt changes, update this SOP **before** the code.

## Goals

1. **Per-reply alert** — every reply detected by SOP 07 gets posted to Slack within minutes, with the lead's identity, the reply text, and a Claude-drafted suggested response. Marks the reply as surfaced after a successful post.
2. **Daily digest** — once per day at 09:00 operator-local, posts a summary of yesterday's outbound activity, replies, queue, and errors.

## Interactivity caveat (v1)

Slack interactive actions (buttons that POST back to our server) require a publicly-reachable endpoint we currently don't have. v1 uses **link-out buttons** instead:

| Button | Action |
|---|---|
| **Open in Notion** | URL link to the lead's Notion page; operator edits status / response there |
| **View Profile** | URL link to the lead's LinkedIn profile |

If full interactivity is needed later, a Bolt-app + webhook is added in Phase T.

## Per-reply alert — message shape

Slack Block Kit JSON (delivered via `chat.postMessage`):

```json
{
  "channel": "<SLACK_CHANNEL_ID>",
  "text": "💬 <Name> (<title>, <company>) replied",
  "blocks": [
    { "type": "header",  "text": { "type": "plain_text", "text": "💬 <Name> (<title>, <company>) replied" } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "via *<linkedin|email>* — <time-ago>" }] },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Reply:*\n> <reply body, quoted, max 800 chars>" } },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Suggested response (Claude):*\n> <suggestion>" } },
    { "type": "actions", "elements": [
        { "type": "button", "text": { "type": "plain_text", "text": "Open in Notion" }, "url": "<notion_page_url>" },
        { "type": "button", "text": { "type": "plain_text", "text": "View Profile"   }, "url": "<linkedin_url>" }
    ]}
  ]
}
```

Fallback `text` field is required for notification previews.

## Suggested-response prompt (Claude tool-use)

System:
```
You are drafting a reply for <OPERATOR> in his LinkedIn outreach pipeline
for private-club personal-brand services. Tone: professional, concise,
peer-to-peer. No emojis, no exclamation marks. Maximum 3 short sentences.
First-name greeting, signed "<OPERATOR>".

If the lead opted out, the suggestion is empty (the system handles muting
elsewhere; you would not be called for opt-outs).

If the lead asked a question, answer it concretely in the first sentence,
then offer the next step (a 30-second example video OR a 10-minute call).
If the lead expressed mild interest, propose a brief next step.
If the lead expressed strong interest, propose a calendar booking link
(use placeholder "[booking link]").
```

User template:
```
Lead: {first_name} {last_name}, {title} at {company}
Channel: {linkedin|email}
Their reply:
"""
{reply_body}
"""

Draft <OPERATOR>'s reply.
```

Output (tool-use schema): `{ reply_text: string, confidence: number, reason: string }`.
Suggestions with `confidence < 0.5` are still posted, but a 🟡 caveat is added: *"low-confidence draft — please review carefully."*

## Daily digest — schedule + content

Triggered by Phase T cron at 09:00 operator-local (Mon–Fri).

Counters (all over yesterday 00:00–24:00 operator-local):

| Counter | Source |
|---|---|
| `sent_today` | sum of `messages_sent_json` entries where `kind ∈ {connection, dm, email}` and `at` was yesterday |
| `connections_accepted` | count of leads whose status is currently `connected` or later AND who have a `[connection-accepted]` note added yesterday |
| `replies` | count of `replies_json` entries where `at` was yesterday |
| `queue_remaining` | count of leads with `status = queued` |
| `errors` | count of leads with `status = error` |

Plus the **top 3 most recent replies** (lead name + snippet of first 100 chars).
Plus any **safety alerts** — if a `./LOCK` file exists, that's reported at the top with 🚨.

Digest block-kit shape (high level):
```
header   📈 Daily digest — <date>
section  *Sent yesterday:* X connections, Y DMs, Z emails
section  *Accepted:* X connection requests accepted
section  *Replies:* X (top 3 below)
context  > <Name 1>: "snippet…"
         > <Name 2>: "snippet…"
         > <Name 3>: "snippet…"
section  *Queue:* X queued, Y in manual review
context  Errors: X (none) | Lock: 🚨 active (or — clear)
```

## Behavior rules

1. **Idempotent.** Re-running the notify navigator picks up only replies whose
   `surfaced_to_slack_ts` is `null`. After a successful post, the field is
   back-filled with the Slack message `ts`.
2. **Rate-friendly.** At most one post every 1.5s between replies (Slack's
   per-channel rate limit is ~1/s).
3. **Truncation.** Reply bodies > 800 chars are truncated with `…` and a note
   "(reply truncated — see Notion for full text)".
4. **Safe failure.** If `chat.postMessage` errors for a single reply, the
   navigator logs to `.tmp/slack_errors/` and moves on; that reply remains
   `surfaced_to_slack_ts = null` for retry on next run.

## Failure modes (populated as encountered)
*(none yet)*

## Cross-references
- Upstream queue: `architecture/07_reply_listener.md` (writes `replies_json`).
- Tools: `execution/tools/slack_post.mjs`, `execution/tools/notion_list_pending_replies.mjs`,
  `execution/tools/notion_mark_reply_surfaced.mjs`
- Navigators: `execution/nav/run_slack_notify.mjs`, `execution/nav/run_daily_digest.mjs`
