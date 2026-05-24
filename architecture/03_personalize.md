# SOP 03 — Personalization

> **Layer A.** Generates a per-lead opening line that will be used in both
> the LinkedIn connection-request note (300 char max) and as the first
> sentence of the LinkedIn DM and follow-up email.
> If the prompt or the output schema changes, update this SOP **before** the code.

## Goal
For each Notion lead with `status = "queued"` and an empty `personalized_first_line`,
ask Claude to produce **one** opening sentence tailored to that lead, plus a
self-assessed confidence score. Write the line back to Notion. If confidence is
too low, move the lead to `manual_review` instead.

## Why just the first line?
The full DM is short (~3 sentences total) and 90% of the variance between leads
lives in the opener. After the first line, every message gets the same
templated body (pitch + soft CTA + signature). This keeps the system:
- **Cheap** — only ~150 tokens per lead, ~$0.0001 on Haiku
- **Consistent** — pitch wording never drifts
- **Auditable** — only one field per lead needs human review

The full DM is assembled at send-time by the LinkedIn / email tools using a
template (defined in SOP 05 / SOP 06).

## Inputs (per lead)
```js
{
  first_name, last_name, company, title, industry  // from Notion
}
```

## Output schema (Claude structured tool-use)
```ts
{
  first_line: string   // 1 sentence, 15–60 words, no emojis, no exclamation marks
  confidence: number   // 0..1 — Claude's self-assessment of personalization quality
  reason: string       // <= 200 chars — one line of why this opener fits this lead
}
```

## Prompt construction
**System prompt:**
```
You write LinkedIn outreach opening lines for <OPERATOR>, who runs a
personal-brand / social-media-management service for owners and CEOs of
private member-owned clubs (tennis, country, racquet, golf, athletic,
pickleball, squash). The service: edits face-videos of the club leader
and runs their full social account so the leader becomes locally famous
and drives more members through the door.

> NOTE FOR ADOPTERS: replace this paragraph with your own one-sentence
> pitch and your own target ICP. The live version of this prompt lives
> in `execution/nav/run_personalize.mjs` `SYSTEM` constant.

Tone: professional, concise, peer-to-peer. No slang. No emojis. No
exclamation marks. Reference one specific, plausible detail about the
lead's club or role — never invent statistics or make claims about the
club. If you cannot find a plausible specific reference, lower confidence.

Output exactly one sentence (15–60 words). It will be combined with a
template body and signed with the operator's first name.

NEVER:
- Make health, financial, or legal claims.
- Use the lead's photo or appearance.
- Promise specific membership-growth numbers.
- Be sycophantic ("I love what you're doing!").
```

**User prompt template:**
```
Lead:
- name:    {first_name} {last_name}
- title:   {title}
- company: {company}
- industry: {industry or "<unknown>"}

Write one opening sentence for a LinkedIn outreach message that
specifically references this lead's club or role.
```

## Decision matrix on Claude's response
| `confidence` | Action |
|---|---|
| `>= 0.6` | Write `first_line` to Notion. Keep status = `queued`. Set `last_action_at = now`. |
| `< 0.6`  | Write `first_line` to Notion (for operator visibility). Set status = `manual_review` with reason `low-personalization-confidence`. |
| missing / malformed JSON | Do **not** write. Log to `.tmp/personalize_errors/`. Set status = `manual_review` with reason `personalize-malformed`. Lead is retried on next run. |

## Behavior rules
1. **Idempotent.** Re-running personalization on a lead whose
   `personalized_first_line` is already populated → skip silently. Re-personalize
   only if the field is empty.
2. **Batch size.** Process at most 25 queued leads per invocation. Larger batches risk Claude rate limits and slow down feedback.
3. **No send-time logic here.** Personalization writes content only. Send queue
   (SOP 04) decides when/whether the line gets used.
4. **Auditability.** The reason string is appended to `notes` as
   `[personalize: <reason>]` so the operator can trace per-lead AI rationale.

## Cost / latency
- ~150 input tokens, ~80 output tokens per lead on `claude-haiku-4-5`
- ~$0.00015 per lead. 1000 leads ≈ $0.15.
- ~2 s wall-clock per lead. 25-lead batch → ~50 s.

## Failure modes (populated as encountered)
*(none yet)*

## Cross-references
- Operator pitch + tone rules: `CLAUDE.md §5 — Behavioral Rules`
- Notion field written: `personalized_first_line` (rich_text)
- Tools: `execution/tools/notion_list_leads_by_status.mjs`, `execution/tools/notion_update_lead.mjs`
- Navigator: `execution/nav/run_personalize.mjs`
- Downstream consumer: SOP 04 (send queue) + SOP 05 (LI driver) + SOP 06 (Gmail follow-up)
