// Phase L probe — Notion
// Verifies NOTION_TOKEN can read the target Leads database.
import 'dotenv/config';
import { Client } from '@notionhq/client';

const token = process.env.NOTION_TOKEN;
const dbId = process.env.NOTION_DB_ID;
if (!token) { console.error('❌ NOTION_TOKEN missing in .env'); process.exit(1); }
if (!dbId)  { console.error('❌ NOTION_DB_ID missing in .env');  process.exit(1); }

const notion = new Client({ auth: token });

try {
  const db = await notion.databases.retrieve({ database_id: dbId });
  const title = db.title?.[0]?.plain_text ?? '(untitled)';
  const propNames = Object.keys(db.properties);
  console.log(`✅ Notion reachable. Database: "${title}"`);
  console.log(`   Properties (${propNames.length}): ${propNames.join(', ')}`);
  process.exit(0);
} catch (err) {
  console.error('❌ Notion probe failed:', err?.message ?? err);
  if (err?.code === 'object_not_found') {
    console.error('   → Did you share the database with the integration?');
    console.error('   → In Notion: open DB → ⋯ menu → Add connections → pick your integration.');
  }
  process.exit(2);
}
