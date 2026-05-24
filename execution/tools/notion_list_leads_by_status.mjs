// Tool — atomic Notion read. Lists leads filtered by status, optionally also
// filtered to ones missing a given property (e.g., personalized_first_line empty).
// No business logic, no LLM.
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;

/**
 * @param {Object} opts
 * @param {string} opts.status                  - e.g. 'queued'
 * @param {string} [opts.missingProp]           - if set, only return leads whose rich_text/url field is empty
 * @param {number} [opts.pageSize=25]
 * @returns {Promise<Array<{id, props}>>}
 */
export async function listLeadsByStatus({ status, missingProp, pageSize = 25 }) {
  const filter = {
    and: [{ property: 'status', select: { equals: status } }],
  };
  if (missingProp) {
    filter.and.push({ property: missingProp, rich_text: { is_empty: true } });
  }
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter,
    page_size: pageSize,
  });
  return res.results.map((p) => ({
    id: p.id,
    props: {
      first_name: p.properties.first_name?.rich_text?.[0]?.plain_text ?? '',
      last_name:  p.properties.last_name?.rich_text?.[0]?.plain_text ?? '',
      company:    p.properties.company?.rich_text?.[0]?.plain_text ?? '',
      title:      p.properties.job_title?.rich_text?.[0]?.plain_text ?? '',
      industry:   p.properties.industry?.rich_text?.[0]?.plain_text ?? '',
      linkedin_url: p.properties.linkedin_url?.url ?? '',
      email:      p.properties.email?.email ?? null,
      notes:      p.properties.notes?.rich_text?.[0]?.plain_text ?? '',
      personalized_first_line: p.properties.personalized_first_line?.rich_text?.[0]?.plain_text ?? '',
    },
  }));
}
