// Tool — derive sent counts (by kind) for an ARBITRARY rolling window from
// Notion's messages_sent_json. Generalizes lead_counts_today.mjs for week-long
// or N-day analyses.
//
// Per SOP 04: counters are DERIVED (not stored separately) so they always match
// reality even after crashes or restarts.
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

/**
 * Count sent items per kind within [now - windowDays, now] in the operator's tz.
 *
 * @param {Date} now
 * @param {string} timeZone           IANA tz (e.g., "America/New_York")
 * @param {number} windowDays         e.g., 7 for "last week"
 * @returns {Promise<{connection: number, dm: number, email: number, acceptance: number}>}
 */
export async function countSentInWindow(now, timeZone, windowDays) {
  const counts = { connection: 0, dm: 0, email: 0, acceptance: 0 };
  const cutoffMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;

  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: 'messages_sent_json', rich_text: { is_not_empty: true } },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      const raw = page.properties.messages_sent_json?.rich_text?.[0]?.plain_text;
      if (!raw) continue;
      let arr;
      try { arr = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const msg of arr) {
        if (!msg?.at || !msg?.kind) continue;
        const tsMs = new Date(msg.at).getTime();
        if (isNaN(tsMs) || tsMs < cutoffMs) continue;
        if (counts[msg.kind] !== undefined) counts[msg.kind]++;
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return counts;
}
