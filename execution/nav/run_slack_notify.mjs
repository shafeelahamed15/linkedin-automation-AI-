// Navigator — surfaces unsurfaced replies to Slack with a Claude-drafted suggestion.
// Implements SOP 08 §"Per-reply alert".
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import { listPendingReplies, markReplySurfaced } from '../tools/notion_pending_replies.mjs';
import { postBlocks, trimBody, notionPageUrl } from '../tools/slack_post.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ERR_DIR = './.tmp/slack_errors';

// PERSONALIZE: replace the operator framing and offer below with your own.
const OPERATOR = process.env.OPERATOR_FIRST_NAME ?? 'Operator';
const SYSTEM = `You are drafting a reply for ${OPERATOR} in his LinkedIn outreach pipeline for private-club personal-brand services (clients: owners/CEOs of tennis, country, racquet, golf, athletic, pickleball, squash clubs).

Tone: professional, concise, peer-to-peer. No emojis, no exclamation marks. Max 3 short sentences. First-name greeting. Sign "${OPERATOR}".

If the lead asked a question, answer it concretely in sentence 1, then propose a next step (a 30-second example video OR a 10-minute call).
If the lead expressed mild interest, propose a brief next step.
If the lead expressed strong interest, propose a calendar booking (placeholder "[booking link]").
Never make claims about health, finances, or legal outcomes. Never invent stats.`;

async function suggestReply(lead, reply) {
  const userMsg =
    `Lead: ${lead.first_name} ${lead.last_name}, ${lead.title} at ${lead.company}\n` +
    `Channel: ${reply.channel}\n\n` +
    `Their reply:\n"""\n${reply.body}\n"""\n\n` +
    `Draft ${OPERATOR}'s reply.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: SYSTEM,
    tools: [{
      name: 'draft_reply',
      description: 'Records the suggested reply text plus self-assessed confidence.',
      input_schema: {
        type: 'object',
        properties: {
          reply_text: { type: 'string', minLength: 10, maxLength: 800 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason:     { type: 'string', maxLength: 200 },
        },
        required: ['reply_text', 'confidence', 'reason'],
      },
    }],
    tool_choice: { type: 'tool', name: 'draft_reply' },
    messages: [{ role: 'user', content: userMsg }],
  });
  const t = res.content.find((b) => b.type === 'tool_use');
  if (!t) return null;
  return t.input;
}

function timeAgo(at) {
  const ms = Date.now() - new Date(at).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

export async function notifyPendingReplies() {
  const pending = await listPendingReplies();
  if (!pending.length) {
    console.log('💤 No unsurfaced replies — nothing to post.');
    return { ok: 0, fail: 0, total: 0 };
  }
  console.log(`📤 Surfacing ${pending.length} reply${pending.length === 1 ? '' : 's'} to Slack…\n`);

  let ok = 0, fail = 0;
  for (const item of pending) {
    const { lead_id, lead, reply, reply_index, parsed } = item;
    const label = `${lead.first_name} ${lead.last_name}`;
    try {
      const suggestion = await suggestReply(lead, reply);
      const suggestionText = suggestion?.reply_text ?? '(no suggestion produced — please reply manually)';
      const lowConf = suggestion && suggestion.confidence < 0.5;

      const header = `💬 ${label} (${lead.title}, ${lead.company}) replied`;
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: header } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `via *${reply.channel}* — ${timeAgo(reply.at)}` }] },
        { type: 'section', text: { type: 'mrkdwn', text: `*Reply:*\n> ${trimBody(reply.body, 800).replace(/\n/g, '\n> ')}` } },
        { type: 'section', text: { type: 'mrkdwn', text:
          `*Suggested response (Claude${lowConf ? ' 🟡 low-confidence' : ''}):*\n> ${trimBody(suggestionText, 800).replace(/\n/g, '\n> ')}` } },
        { type: 'actions', elements: [
            ...(lead_id ? [{ type: 'button', text: { type: 'plain_text', text: 'Open in Notion' }, url: notionPageUrl(lead_id) }] : []),
            ...(lead.linkedin_url ? [{ type: 'button', text: { type: 'plain_text', text: 'View Profile' }, url: lead.linkedin_url }] : []),
          ]
        },
      ];

      const post = await postBlocks({ text: header, blocks });
      await markReplySurfaced(lead_id, reply_index, parsed, post.ts);
      ok++;
      console.log(`   🟢 ${label} → ts=${post.ts}`);
    } catch (err) {
      fail++;
      console.error(`   🟥 ${label} — ${err?.message ?? err}`);
      await mkdir(ERR_DIR, { recursive: true });
      await writeFile(join(ERR_DIR, `${Date.now()}__${lead_id}__${reply_index}.json`),
        JSON.stringify({ lead_id, reply_index, error: err?.message ?? String(err) }, null, 2));
    }
    // light rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\n══════ SLACK NOTIFY SUMMARY ══════`);
  console.log(`🟢 posted: ${ok}`);
  console.log(`🟥 errors: ${fail}`);
  return { ok, fail, total: pending.length };
}

// Only run as a CLI when invoked directly (e.g. `node execution/nav/run_slack_notify.mjs`).
// When imported by the reply listener, this block is skipped.
import { fileURLToPath } from 'node:url';
const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  notifyPendingReplies().catch((err) => { console.error('FATAL:', err); process.exit(1); });
}
