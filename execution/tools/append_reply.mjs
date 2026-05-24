// Tool — atomic append to a Notion lead's replies_json. Dedup by message_id.
import { Client } from '@notionhq/client';
import { updateLead } from './notion_update_lead.mjs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

/**
 * Append a reply record. Caller provides the full shape:
 *   { channel: 'linkedin'|'email', at: ISO-8601, body: string,
 *     message_id: string, surfaced_to_slack_ts: null }
 * If message_id already exists in the array, the call is a no-op and returns false.
 *
 * @returns {Promise<{appended: boolean, replies: Array}>}
 */
export async function appendReply(pageId, reply) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const raw = page.properties.replies_json?.rich_text?.[0]?.plain_text ?? '';
  let arr = [];
  if (raw) { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) arr = [];

  if (reply.message_id && arr.some((r) => r.message_id === reply.message_id)) {
    return { appended: false, replies: arr };
  }
  arr.push(reply);
  await updateLead(pageId, { replies_json: JSON.stringify(arr) });
  return { appended: true, replies: arr };
}
