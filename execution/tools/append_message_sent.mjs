// Tool — atomic append to a lead's messages_sent_json. Reads, mutates, writes.
// No business logic; the navigator decides what to record.
import { Client } from '@notionhq/client';
import { updateLead } from './notion_update_lead.mjs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

/**
 * Append a message record to a lead's history. Caller passes the full record
 * (matches CLAUDE.md §6.2 inner shape):
 *   { channel: 'linkedin'|'email', at: ISO-8601, body: string, kind: 'connection'|'dm'|'email' }
 *
 * @param {string} pageId
 * @param {Object} msg
 * @returns {Promise<Array>} the new history array (post-append)
 */
export async function appendMessageSent(pageId, msg) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const raw = page.properties.messages_sent_json?.rich_text?.[0]?.plain_text ?? '';
  let arr = [];
  if (raw) { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) arr = [];
  arr.push(msg);
  await updateLead(pageId, { messages_sent_json: JSON.stringify(arr) });
  return arr;
}
