// Tool — finds leads whose replies_json contains at least one entry with
// surfaced_to_slack_ts === null. Returns flat list of (lead, reply) pairs
// for the Slack notifier to iterate, ordered oldest-first.
import { Client } from '@notionhq/client';
import { updateLead } from './notion_update_lead.mjs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

/**
 * @returns {Promise<Array<{lead_id: string, lead: object, reply: object, reply_index: number, parsed: Array}>>}
 */
export async function listPendingReplies() {
  const out = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: 'replies_json', rich_text: { is_not_empty: true } },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      const raw = page.properties.replies_json?.rich_text?.[0]?.plain_text ?? '';
      if (!raw) continue;
      let arr;
      try { arr = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i];
        if (r && r.surfaced_to_slack_ts == null) {
          out.push({
            lead_id: page.id,
            lead: {
              first_name: page.properties.first_name?.rich_text?.[0]?.plain_text ?? '',
              last_name:  page.properties.last_name?.rich_text?.[0]?.plain_text ?? '',
              company:    page.properties.company?.rich_text?.[0]?.plain_text ?? '',
              title:      page.properties.job_title?.rich_text?.[0]?.plain_text ?? '',
              linkedin_url: page.properties.linkedin_url?.url ?? '',
              status:     page.properties.status?.select?.name ?? '',
            },
            reply: r,
            reply_index: i,
            parsed: arr,
          });
        }
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  out.sort((a, b) => (a.reply.at ?? '').localeCompare(b.reply.at ?? ''));
  return out;
}

/**
 * Mark a specific reply (by index within the lead's replies_json) as surfaced.
 * Writes back the entire array.
 *
 * NOTE (2026-05-21): mutates `fullArray` in place by design. When a single
 * lead has multiple pending replies in one Slack-notifier batch, the caller
 * shares the same `fullArray` reference across iterations — if we used an
 * immutable copy, each call would overwrite the slack_ts written by prior
 * iterations (the rest of the array would still hold the snapshot's nulls).
 * In-place mutation lets the array carry forward the running state.
 */
export async function markReplySurfaced(lead_id, replyIndex, fullArray, slackTs) {
  if (!fullArray[replyIndex]) throw new Error(`markReplySurfaced: index ${replyIndex} missing`);
  fullArray[replyIndex] = { ...fullArray[replyIndex], surfaced_to_slack_ts: slackTs };
  await updateLead(lead_id, { replies_json: JSON.stringify(fullArray) });
}
