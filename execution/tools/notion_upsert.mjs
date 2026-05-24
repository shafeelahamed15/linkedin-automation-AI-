// Tool — atomic Notion write helpers. No business logic, no LLM calls.
// Implements SOP 01 rules 1, 6, 7.
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

const rt = (s) => (s == null ? [] : [{ type: 'text', text: { content: String(s) } }]);

/**
 * Look up a Notion lead by linkedin_url. Returns the page object or null.
 * (Notion query is case-sensitive on rich_text equals; URL property uses `url.equals`.)
 */
export async function findLeadByUrl(linkedin_url) {
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: { property: 'linkedin_url', url: { equals: linkedin_url } },
    page_size: 1,
  });
  return res.results[0] ?? null;
}

/**
 * Create a new Notion lead. `lead` is an ingest_csv normalized row.
 * `status` is one of: 'queued' | 'manual_review' | 'irrelevant'.
 * `icp_reason` is appended to the notes field for traceability.
 */
export async function createLead(lead, status, icp_reason) {
  const properties = {
    'Name':         { title: rt(`${lead.last_name}, ${lead.first_name}`) },
    'first_name':   { rich_text: rt(lead.first_name) },
    'last_name':    { rich_text: rt(lead.last_name) },
    'linkedin_url': { url: lead.linkedin_url },
    'company':      { rich_text: rt(lead.company) },
    'job_title':    { rich_text: rt(lead.title) },
    'status':       { select: { name: status } },
  };
  if (lead.email)    properties.email    = { email: lead.email };
  if (lead.industry) properties.industry = { rich_text: rt(lead.industry) };

  const notesParts = [];
  if (lead.notes)  notesParts.push(lead.notes);
  if (icp_reason)  notesParts.push(`[icp: ${icp_reason}]`);
  if (notesParts.length) properties.notes = { rich_text: rt(notesParts.join(' ')) };

  return notion.pages.create({ parent: { database_id: DB_ID }, properties });
}
