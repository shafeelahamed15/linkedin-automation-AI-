// Tool — atomic Notion writer. Updates an existing lead page's properties.
// Any subset of allowed fields may be passed; the rest are left untouched.
// No business logic, no LLM.
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const rt = (s) => (s == null ? [] : [{ type: 'text', text: { content: String(s) } }]);

const FIELD_BUILDERS = {
  status:                  (v) => ({ select: { name: v } }),
  personalized_first_line: (v) => ({ rich_text: rt(v) }),
  campaign:                (v) => ({ rich_text: rt(v) }),
  last_channel:            (v) => ({ select: { name: v } }),
  last_action_at:          (v) => ({ date: (v && v !== '') ? { start: v } : null }),
  next_action_at:          (v) => ({ date: (v && v !== '') ? { start: v } : null }),
  messages_sent_json:      (v) => ({ rich_text: rt(v) }),
  replies_json:            (v) => ({ rich_text: rt(v) }),
  error:                   (v) => ({ rich_text: rt(v) }),
  notes:                   (v) => ({ rich_text: rt(v) }),
};

/**
 * Update a Notion lead page.
 * @param {string} pageId
 * @param {Record<keyof typeof FIELD_BUILDERS, any>} updates
 * @returns {Promise<object>} the updated page object
 */
export async function updateLead(pageId, updates) {
  const properties = {};
  for (const [k, v] of Object.entries(updates)) {
    if (!(k in FIELD_BUILDERS)) throw new Error(`updateLead: unknown field "${k}"`);
    properties[k] = FIELD_BUILDERS[k](v);
  }
  return notion.pages.update({ page_id: pageId, properties });
}

/**
 * Append a short tag onto the existing `notes` field (preserves prior content).
 * Reads first; writes second. Two round trips.
 */
export async function appendNote(pageId, tag) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const existing = page.properties.notes?.rich_text?.[0]?.plain_text ?? '';
  const next = existing ? `${existing} ${tag}` : tag;
  return updateLead(pageId, { notes: next });
}
