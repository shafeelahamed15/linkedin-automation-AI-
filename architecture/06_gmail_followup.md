# SOP 06 — Gmail Follow-up Sender

> **Layer A.** Sends a polite email follow-up to leads who were reached on
> LinkedIn N days ago and have not replied. Uses the same safety gate as SOP 04.
> If template, threshold, or daily cap changes, update this SOP **before** the code.

## Goal
Identify eligible leads, compose an email from a template (reusing
`personalized_first_line` from SOP 03), call the Gmail API to send,
record the send in `messages_sent_json`. Apply the same safety gate as
LinkedIn sends so we don't blast the inbox during quiet hours, weekends,
or after the lock-file kill-switch fires.

## Eligibility (all must be true)

- Lead has a non-empty `email`.
- Lead's `status` is `connecting` or `messaged` (still active; not replied / won / muted / irrelevant).
- `personalized_first_line` is non-empty.
- The lead's `messages_sent_json` contains at least one `linkedin` entry **and** the most recent one is `>= 5 days ago` (configurable via `EMAIL_FOLLOWUP_DELAY_DAYS`, default 5).
- The lead's `messages_sent_json` does **not** already contain an `email` entry.

## Safety gate (reuses SOP 04)

Same five checks as LinkedIn sends — quiet hours (09:00–17:00 ET),
no weekends, daily caps, LOCK file, jitter. Email cap default: **30/day**
(added to `DAILY_CAPS` in `safety_guard.mjs`).

## Email template

Subject:
```
Quick follow-up — {company}
```

Body (plain text):
```
Hi {first_name},

{personalized_first_line}

I reached out on LinkedIn a few days back and wanted to land in your inbox
in case it's easier. Happy to share a 30-second example of what this looks
like for a club leader. Worth a brief chat?

Best,
<OPERATOR_FIRST_NAME>
```

The body uses LinkedIn's `personalized_first_line` verbatim. We do not re-call
Claude — the line was vetted at the SOP-03 confidence threshold.

## Send path

`gmail.users.messages.send` with a base64url-encoded RFC 5322 payload:
```
From: <OPERATOR_FIRST_NAME> <GMAIL_USER>
To: <lead.email>
Subject: Quick follow-up — <company>
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: 7bit

<body>
```

Gmail returns a `Message-Id`. We persist it in the `messages_sent_json` entry's
`body` field along with the email subject and the plain body, so future replies
can be threaded if Gmail polling SOP-07 finds the response.

## Behavior rules

1. **DRY_RUN=true** logs the planned send to `.tmp/dry_run_log/YYYY-MM-DD.jsonl`
   and does not call Gmail.
2. **One email per lead, ever.** No second follow-up automated. If a third
   touch is desired, it's manual.
3. **Atomic write back to Notion.** On success: append `{ channel: 'email',
   kind: 'email', at: now, body: <body|message_id> }` and update
   `last_action_at`, `last_channel: email`. Do **not** change `status` —
   we still want to receive a reply on either channel.
4. **No status escalation on failure.** If Gmail returns an error, log to
   `.tmp/email_errors/` and leave the lead eligible for retry on next sweep
   (Gmail outage shouldn't burn the lead).

## Failure modes (populated as encountered)

### Notion date-clear quirk (2026-05-18)
- **Symptom:** `validation_error: body.properties.last_action_at.date.start should be a valid ISO 8601 date string, instead was ""`
- **Root cause:** Notion's date-typed property rejects empty-string for `date.start`. To **clear** a date field, the property body must be `{ date: null }`, not `{ date: { start: "" } }`.
- **Fix:** `execution/tools/notion_update_lead.mjs` field-builder for `last_action_at` and `next_action_at` now coerces empty / nullish values to `null`. Pattern:
  ```js
  (v) => ({ date: (v && v !== '') ? { start: v } : null })
  ```
- **Generalization:** any future Notion property of a non-string type (`date`, `select`, `url`, `email`, `number`) that needs clearing must use `null` for the type's outer object — *not* an empty inner value.

## Cross-references
- Personalization source: `architecture/03_personalize.md`
- Safety gate: `architecture/04_send_queue.md`
- Reply detection on email channel: `architecture/07_reply_listener.md`
- Tools: `execution/tools/gmail_send.mjs`
- Navigator: `execution/nav/run_email_followup.mjs`
