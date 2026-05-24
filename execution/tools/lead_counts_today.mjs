// Tool — derives today's connection/dm send counts from Notion's messages_sent_json.
// Per SOP 04: counters are derived, not stored, so they survive crashes and match reality.
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

/** Returns YYYY-MM-DD for `now` in the given IANA timezone. */
function todayKey(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {  // en-CA gives YYYY-MM-DD
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now);
}

/**
 * Walk every Notion lead with non-empty messages_sent_json, parse, and count
 * any entries whose `at` falls on today (operator timezone).
 *
 * Implementation note: for the current scale (< 5k leads/day) a single
 * paginated DB scan is fine. If the DB grows beyond ~50k rows, add a `sent_today`
 * tag and query by date range.
 *
 * @param {Date} now
 * @param {string} timeZone
 * @returns {Promise<{connection: number, dm: number, email: number}>}
 */
export async function countSentToday(now, timeZone) {
  const today = todayKey(now, timeZone);
  const counts = { connection: 0, dm: 0, email: 0 };

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
        if (!msg?.at) continue;
        const day = todayKey(new Date(msg.at), timeZone);
        if (day !== today) continue;
        const kind = msg.kind;
        if (kind === 'connection' || kind === 'dm' || kind === 'email') counts[kind]++;
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return counts;
}
