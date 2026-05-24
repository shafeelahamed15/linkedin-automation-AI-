// Phase L setup — create the Leads database in Notion programmatically.
// Reads NOTION_TOKEN + NOTION_PARENT_PAGE_ID from .env, creates the DB with
// the exact schema defined in CLAUDE.md §6.2, prints the new database ID to paste
// back into .env as NOTION_DB_ID.
import 'dotenv/config';
import { Client } from '@notionhq/client';

const token = process.env.NOTION_TOKEN;
const parent = process.env.NOTION_PARENT_PAGE_ID;
if (!token)  { console.error('❌ NOTION_TOKEN missing in .env'); process.exit(1); }
if (!parent) {
  console.error('❌ NOTION_PARENT_PAGE_ID missing in .env');
  console.error('   → Create a page in Notion called "LinkedIn Leads"');
  console.error('   → Share it with your integration (⋯ menu → Add connections)');
  console.error('   → Copy the 32-char ID from the page URL (after the last dash)');
  console.error('   → Paste as NOTION_PARENT_PAGE_ID in .env');
  process.exit(1);
}

const notion = new Client({ auth: token });

const STATUS_OPTIONS = [
  { name: 'queued',         color: 'gray'   },
  { name: 'manual_review',  color: 'yellow' },
  { name: 'irrelevant',     color: 'default'},
  { name: 'connecting',     color: 'blue'   },
  { name: 'connected',      color: 'purple' },
  { name: 'messaged',       color: 'pink'   },
  { name: 'replied',        color: 'orange' },
  { name: 'won',            color: 'green'  },
  { name: 'muted',          color: 'red'    },
  { name: 'error',          color: 'brown'  },
];

const CHANNEL_OPTIONS = [
  { name: 'linkedin', color: 'blue' },
  { name: 'email',    color: 'green' },
];

try {
  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: parent },
    icon: { type: 'emoji', emoji: '🎯' },
    title: [{ type: 'text', text: { content: 'LinkedIn Leads' } }],
    properties: {
      // Notion requires exactly one "title" property — use the lead's full name
      'Name':                     { title: {} },
      'first_name':               { rich_text: {} },
      'last_name':                { rich_text: {} },
      'linkedin_url':             { url: {} },
      'company':                  { rich_text: {} },
      'job_title':                { rich_text: {} },
      'email':                    { email: {} },
      'industry':                 { rich_text: {} },
      'status':                   { select: { options: STATUS_OPTIONS } },
      'campaign':                 { rich_text: {} },
      'personalized_first_line':  { rich_text: {} },
      'last_channel':             { select: { options: CHANNEL_OPTIONS } },
      'last_action_at':           { date: {} },
      'next_action_at':           { date: {} },
      'messages_sent_json':       { rich_text: {} },  // JSON-blob array
      'replies_json':             { rich_text: {} },  // JSON-blob array
      'error':                    { rich_text: {} },
      'notes':                    { rich_text: {} },
    },
  });

  console.log('\n✅ Leads database created.');
  console.log('   id:    ' + db.id);
  console.log('   url:   ' + db.url);
  console.log('\n👉 Paste this line into .env:\n');
  console.log('   NOTION_DB_ID=' + db.id + '\n');
  console.log('Then run: npm run probe:notion');
  process.exit(0);
} catch (err) {
  console.error('❌ Database creation failed:', err?.message ?? err);
  if (err?.code === 'object_not_found') {
    console.error('   → The parent page is not shared with the integration.');
    console.error('   → In Notion: open the page → ⋯ menu → Add connections → pick your integration.');
  }
  if (err?.code === 'unauthorized') {
    console.error('   → NOTION_TOKEN is invalid. Re-copy from notion.so/my-integrations.');
  }
  process.exit(2);
}
