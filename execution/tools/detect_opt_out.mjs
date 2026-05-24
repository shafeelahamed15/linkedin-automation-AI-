// Tool — pure opt-out detector. No I/O.
// Implements SOP 07 §"Opt-out keyword list".

const OPT_OUT_KEYWORDS = [
  'unsubscribe', 'stop', 'remove me', 'not interested',
  'do not contact', 'take me off', 'no thanks', 'please remove',
];

/**
 * @param {string} body  reply text (any case, any whitespace)
 * @returns {{matched: boolean, keyword: string|null}}
 */
export function detectOptOut(body) {
  if (!body) return { matched: false, keyword: null };
  const hay = ` ${body.toLowerCase()} `;  // pad so "stop" matches as a word boundary check below
  for (const kw of OPT_OUT_KEYWORDS) {
    // "stop" is too generic on its own; require true word edges (not hyphens, e.g., "non-stop").
    if (kw === 'stop') {
      if (/(?<![\w-])stop(?![\w-])/i.test(body)) return { matched: true, keyword: kw };
      continue;
    }
    if (hay.includes(kw)) return { matched: true, keyword: kw };
  }
  return { matched: false, keyword: null };
}

export { OPT_OUT_KEYWORDS };
