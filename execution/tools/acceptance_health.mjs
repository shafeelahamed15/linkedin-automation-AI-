// Tool — analyze the acceptance health of recent connection sends.
// Reads Notion's messages_sent_json across leads, counts connections sent
// vs acceptances detected in the last N days, returns a health verdict.
//
// The send-queue navigator uses this to self-halt if the burner's reply rate
// drops below an acceptable threshold — a strong signal that LinkedIn has
// throttled/shadow-restricted the account.
import { countSentInWindow } from './lead_counts_window.mjs';

const WINDOW_DAYS = 7;
const MIN_SENDS_BEFORE_HALT = 20;   // don't fail-halt on tiny sample sizes
const MIN_ACCEPT_RATE = 0.10;       // 10% — LinkedIn-restricted accounts often drop below this

/**
 * Returns the 7-day acceptance health for the burner.
 *
 * @param {Date} now
 * @param {string} timeZone
 * @returns {Promise<{
 *   ok: boolean,
 *   sent7d: number,
 *   accepted7d: number,
 *   rate: number,
 *   reason: string|null
 * }>}
 */
export async function evaluateAcceptanceHealth(now, timeZone) {
  const counts = await countSentInWindow(now, timeZone, WINDOW_DAYS);
  const sent7d = counts.connection ?? 0;
  const accepted7d = counts.acceptance ?? 0;

  // Below the minimum sample size, abstain from halting (insufficient data).
  if (sent7d < MIN_SENDS_BEFORE_HALT) {
    return {
      ok: true, sent7d, accepted7d,
      rate: sent7d > 0 ? accepted7d / sent7d : 0,
      reason: `insufficient sample (sent7d=${sent7d} < ${MIN_SENDS_BEFORE_HALT})`,
    };
  }

  const rate = accepted7d / sent7d;
  if (rate < MIN_ACCEPT_RATE) {
    return {
      ok: false, sent7d, accepted7d, rate,
      reason: `acceptance rate ${(rate * 100).toFixed(1)}% < ${(MIN_ACCEPT_RATE * 100).toFixed(0)}% threshold over last ${WINDOW_DAYS} days`,
    };
  }

  return { ok: true, sent7d, accepted7d, rate, reason: null };
}
