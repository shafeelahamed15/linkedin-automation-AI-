# SOP 02 — ICP Relevance Gate

> **Layer A.** Decides whether a freshly-ingested lead is in our **I**deal **C**ustomer **P**rofile (private-club owners/CEOs) and may be queued for outreach, or out-of-profile and must be skipped.
> If the trigger-word list or the Claude fallback prompt changes, update this SOP **before** the code.

## Goal
For each new lead in Notion with status = `null` (just ingested), assign one of three statuses:

| New status | Meaning | Next stage |
|---|---|---|
| `queued` | In-ICP, ready for personalization | SOP 03 picks it up |
| `manual_review` | Ambiguous — Claude `confidence < 0.7` OR title not in target-list | SOP 08 surfaces to operator in Slack |
| `irrelevant` | Off-ICP — Claude `is_icp: false` AND no club-type substring match | Never messaged. Stays in Notion for QA. |

## Two-stage filter

### Stage 1 — Cheap substring match (deterministic, no LLM)

For each lead, build a single lowercase haystack from:
```
{company} + " " + {industry}
```
Match against this trigger-word list (case-insensitive substring):

| Club type | Trigger words |
|---|---|
| Tennis | `tennis`, `racquet`, `racket`, `lawn tennis` |
| Country | `country club`, `country & golf`, `c.c.` |
| Golf | `golf`, `golf course`, `links` |
| Athletic | `athletic club`, `athletic & social`, `health club`, `fitness club` |
| Pickleball | `pickleball` |
| Racquet (general) | `squash club`, `paddle club` |

If **any** match → proceed to Stage 2 *title check*.
If **none** match → escalate to Stage 3 (Claude).

> **Exclusion overlay** for false positives in fitness/health:
> If the trigger word is `health club` OR `fitness club`, AND the haystack also contains any of `public gym`, `chain`, `franchise`, `24 hour`, `planet fitness`, `crunch`, `equinox`, `lifetime fitness` → treat as **off-ICP** (these are commercial gyms, not member-owned clubs).

### Stage 2 — Title check (deterministic, no LLM)

Target titles (case-insensitive substring on `title`):
```
# Owner / C-suite tier
owner, ceo, president, founder, co-founder, managing director,
general manager, gm, director of operations, club manager, vp operations

# Senior club staff (added 2026-05-19 — pitch-fit imperfect; reply rates
# from this tier may be lower until a tier-specific Claude prompt exists)
director of membership, membership director, membership services director,
director of racquet, racquet director, director of tennis, tennis director,
director of golf, golf director, director of athletics, athletic director,
executive director, head pro, head professional
```

- Title matches AND company matches Stage 1 → `queued`
- Title does **not** match AND company matches Stage 1 → `manual_review` (right company, wrong seniority — operator decides)

> The canonical TARGET_TITLES list lives in `execution/tools/icp_filter.mjs` as a single exported constant. The navigator (`run_ingest.mjs`) imports it for Claude-output mapping — never duplicate the list anywhere else.

### Stage 3 — Claude relevance fallback (LLM call — Navigator only)

Triggered when Stage 1 finds no match. Claude is asked one structured question:

```
System: You are an ICP relevance classifier for a service that sells
personal-brand-management to owners and CEOs of private member-owned
clubs (tennis, country, racquet, golf, athletic, pickleball, squash).

User: Is "{company}" (industry: "{industry}", lead title: "{title}")
a private member-owned club of one of the listed types?
Return strict JSON: { "is_icp": boolean, "confidence": number 0..1, "reason": short string }
```

Decision matrix on Claude's response:

| `is_icp` | `confidence` | New status |
|---|---|---|
| `true`  | `>= 0.7` | `manual_review` if title fails Stage 2, else `queued` |
| `true`  | `< 0.7`  | `manual_review` (low confidence → human decides) |
| `false` | `>= 0.7` | `irrelevant` |
| `false` | `< 0.7`  | `manual_review` (low confidence → human decides) |
| missing/malformed JSON | — | `manual_review` (don't fail-open to "queued") |

## Cost / latency
- Stage 1+2 alone covers ~80% of leads at zero LLM cost (estimated; tune after first batch).
- Stage 3 uses `claude-haiku-4-5` with ~150 input tokens / ~40 output tokens. ≈ $0.0001 per ambiguous lead.

## Behavior rules
1. The ICP gate runs **once per lead**. Re-running ingest on the same `linkedin_url` does not re-evaluate.
2. The gate writes:
   - `status` (one of the three values above)
   - `notes` (appends `[icp: <reason>]` so operator can trace why)
3. If the gate errors (Notion outage, Claude outage) → status remains `null` (untouched). The Navigator retries on the next run.

## Failure modes (populated as encountered)
*(none yet)*

## Cross-references
- North-Star ICP: `CLAUDE.md §5` (ICP Relevance Gate)
- Tool: `execution/tools/icp_filter.mjs`
- Navigator: `execution/nav/run_ingest.mjs` (calls Claude when needed)
