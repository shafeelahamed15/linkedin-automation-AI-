// Tool — deterministic ICP gate (Stages 1 + 2 only, no LLM).
// LLM fallback (Stage 3) lives in the Navigator per A.N.T. separation.
// Implements SOP 02 §"Two-stage filter" stages 1 + 2.

const CLUB_TRIGGERS = [
  // Tennis
  'tennis', 'racquet', 'racket', 'lawn tennis',
  // Country / golf
  'country club', 'country & golf', 'c.c.', 'golf', 'golf course', 'links',
  // Athletic
  'athletic club', 'athletic & social', 'health club', 'fitness club',
  // Pickleball
  'pickleball',
  // Racquet variants
  'squash club', 'paddle club',
];

const FITNESS_EXCLUSIONS = [
  'public gym', 'chain', 'franchise', '24 hour', 'planet fitness',
  'crunch', 'equinox', 'lifetime fitness',
];

// Exported so the navigator (run_ingest) can reuse this list when mapping
// Claude's Stage-3 response to a status — single source of truth.
export const TARGET_TITLES = [
  // Owner / C-suite tier
  'owner', 'ceo', 'president', 'founder', 'co-founder',
  'managing director', 'general manager', 'gm',
  'director of operations', 'club manager', 'vp operations',
  // Senior club staff (expanded 2026-05-19 per operator decision —
  // pitch fit is imperfect for these contacts, but they are valid
  // outreach targets at clubs the operator wants to work with).
  'director of membership',  'membership director', 'membership services director',
  'director of racquet',     'racquet director',    // catches "Racquet Sports" + "Racquets"
  'director of tennis',      'tennis director',
  'director of golf',        'golf director',
  'director of athletics',   'athletic director',
  'executive director',
  'head pro', 'head professional',
];

/**
 * Decision result from the deterministic filter.
 * @typedef {Object} IcpDecision
 * @property {'queued'|'manual_review'|'irrelevant'|'needs_llm'} decision
 * @property {string} reason
 */

/**
 * Classify a lead using Stages 1 + 2 only.
 *   - 'queued'        → company match + target title
 *   - 'manual_review' → company match, title not in target list
 *   - 'needs_llm'     → no company trigger word, caller must run Stage 3
 *
 * Note: this function never returns 'irrelevant' on its own; only Claude can
 * conclude a lead is off-ICP (Stage 3 in the navigator).
 *
 * @param {{company: string, industry?: string|null, title: string}} lead
 * @returns {IcpDecision}
 */
export function classify(lead) {
  const haystack = `${lead.company} ${lead.industry ?? ''}`.toLowerCase();
  const titleHay = lead.title.toLowerCase();

  const matchedTrigger = CLUB_TRIGGERS.find((t) => haystack.includes(t));
  const isCommercialGym =
    (haystack.includes('health club') || haystack.includes('fitness club')) &&
    FITNESS_EXCLUSIONS.some((e) => haystack.includes(e));

  if (!matchedTrigger || isCommercialGym) {
    return { decision: 'needs_llm', reason: matchedTrigger ? `excluded-commercial-gym` : `no-club-trigger` };
  }

  const titleOk = TARGET_TITLES.some((t) => titleHay.includes(t));
  if (titleOk) {
    return { decision: 'queued', reason: `stage1-trigger=${matchedTrigger}, stage2-title-ok` };
  }
  return { decision: 'manual_review', reason: `stage1-trigger=${matchedTrigger}, stage2-title-miss` };
}
