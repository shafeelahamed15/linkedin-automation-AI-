// Navigator — posts the 09:00 daily digest to Slack per SOP 08.
// Run via cron in Phase T; today we trigger manually with `npm run digest`.
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@notionhq/client';
import { postBlocks } from '../tools/slack_post.mjs';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DB_ID;
const TIME_ZONE = process.env.OPERATOR_TIMEZONE || 'America/New_York';

function dayKey(d, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function ymd(d, tz) { return dayKey(d, tz); }

async function listAll(filter) {
  const all = [];
  let cursor;
  do {
    const res = await notion.databases.query({ database_id: DB_ID, filter, start_cursor: cursor, page_size: 100 });
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function main() {
  const now = new Date();
  const todayDay = dayKey(now, TIME_ZONE);
  const yesterdayDay = dayKey(new Date(now.getTime() - 24*3600*1000), TIME_ZONE);

  // Pull leads with non-empty messages_sent_json and replies_json (separately).
  const sentPages   = await listAll({ property: 'messages_sent_json', rich_text: { is_not_empty: true } });
  const repliedPages = await listAll({ property: 'replies_json', rich_text: { is_not_empty: true } });

  let sent = { connection: 0, dm: 0, email: 0 };
  let acceptedToday = 0;
  for (const page of sentPages) {
    const raw = page.properties.messages_sent_json?.rich_text?.[0]?.plain_text;
    if (!raw) continue;
    let arr; try { arr = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      if (!m?.at) continue;
      if (dayKey(new Date(m.at), TIME_ZONE) !== yesterdayDay) continue;
      if (m.kind in sent) sent[m.kind]++;
    }
  }

  const replyTotals = [];
  for (const page of repliedPages) {
    const raw = page.properties.replies_json?.rich_text?.[0]?.plain_text;
    if (!raw) continue;
    let arr; try { arr = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const name = `${page.properties.first_name?.rich_text?.[0]?.plain_text ?? ''} ${page.properties.last_name?.rich_text?.[0]?.plain_text ?? ''}`.trim();
    for (const r of arr) {
      if (!r?.at) continue;
      if (dayKey(new Date(r.at), TIME_ZONE) !== yesterdayDay) continue;
      replyTotals.push({ name, snippet: (r.body ?? '').slice(0, 120).replace(/\s+/g, ' ').trim(), at: r.at });
    }
  }
  replyTotals.sort((a, b) => b.at.localeCompare(a.at));
  const top3 = replyTotals.slice(0, 3);

  // Status-tally counts (cheap with separate queries).
  const queueRem = (await listAll({ property: 'status', select: { equals: 'queued' } })).length;
  const errorCount = (await listAll({ property: 'status', select: { equals: 'error' } })).length;
  const manualReview = (await listAll({ property: 'status', select: { equals: 'manual_review' } })).length;

  const lockActive = existsSync('./LOCK');
  let lockInfo = '';
  if (lockActive) {
    try { lockInfo = JSON.parse(readFileSync('./LOCK', 'utf8')).reason ?? 'unknown'; }
    catch { lockInfo = 'unknown'; }
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📈 Daily digest — ${todayDay} (${TIME_ZONE})` } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `*Sent yesterday:* ${sent.connection} connections, ${sent.dm} DMs, ${sent.email} emails` } },
    { type: 'section', text: { type: 'mrkdwn', text:
      `*Replies yesterday:* ${replyTotals.length}` } },
    ...(top3.length ? [
      { type: 'context', elements: top3.map((r) => ({ type: 'mrkdwn', text: `> *${r.name}:* "${r.snippet}"` })) },
    ] : []),
    { type: 'section', text: { type: 'mrkdwn', text:
      `*Queue:* ${queueRem} queued, ${manualReview} in manual review` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text:
      `${lockActive ? `🚨 *LOCK active*: ${lockInfo}` : '— LOCK clear'} | errors: ${errorCount}` }] },
  ];

  await postBlocks({ text: `Daily digest — ${todayDay}`, blocks });
  console.log(`✅ Posted digest for ${todayDay}.`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
