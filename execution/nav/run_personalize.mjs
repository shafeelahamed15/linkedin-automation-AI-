// Navigator — orchestrates SOP 03 (Personalization).
// For each queued lead with empty personalized_first_line:
//   1. Call Claude (claude-haiku-4-5) with structured tool-use schema.
//   2. Apply decision matrix on confidence.
//   3. Write first_line + status/note updates back to Notion.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import { listLeadsByStatus } from '../tools/notion_list_leads_by_status.mjs';
import { updateLead, appendNote } from '../tools/notion_update_lead.mjs';

const ERR_DIR = './.tmp/personalize_errors';
const BATCH = 25;
const CONF_THRESHOLD = 0.6;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// PERSONALIZE THIS BLOCK — replace the operator name, offer, ICP, and voice
// examples with your own. The constants below are an EXAMPLE configuration for
// a personal-brand service targeting private member-owned clubs. Swap them out
// for your own niche before going live.
const OPERATOR = process.env.OPERATOR_FIRST_NAME ?? 'Operator';
const SYSTEM = `You write LinkedIn connection-request notes for ${OPERATOR} in HIS voice. He sells a personal-brand / social-media-management service to owners and CEOs of private member-owned clubs (tennis, country, racquet, golf, athletic, pickleball, squash). But you are NOT writing a sales pitch here. You are writing a casual connection-request — the sales conversation happens LATER, only after they accept.

VOICE: casual, lowercase, conversational. Like texting a peer, not writing a business email. Read your draft out loud. If it sounds like marketing copy or LinkedIn slop, REWRITE IT.

EXAMPLES of the operator's actual voice (these are the ground truth — match this energy):
- hey sarah, love what you do at greenwich, really impressive what you've done with the tennis program, love to connect
- hey mike loved the recent post about your new pickleball courts at hillcrest, love to connect
- hey kathleen, love the work you do leading round hill, love to connect
- hey dave, love that you run both tennis and pickleball at the citrus club, love to connect

HARD RULES:
- Always start with "hey {first_name}," lowercase. Never Hi, Hello, Dear, Greetings.
- One specific, plausible reference to their role or club. If you cannot think of a specific reference, fall back to "love what you do at {company}". Better generic than fabricated.
- End with "love to connect".
- 12-25 words MAX. Aim for under 150 characters total.
- Lowercase EVERYTHING except people's names, club names, and acronyms (PGA, CEO, HR, etc.).
- NO em-dashes (—). NO en-dashes (–). NO ellipses (…). Use commas.
- NO AI-tell words: delve, leverage, navigate, ensure, robust, instrumental, well-positioned, comprehensive, drive measurable, member-experience, pivotal, paramount, harness, unlock, elevate, foster, spearhead, in this rapidly evolving, given your expertise, responsible for, central to, shape, amplify, visibility, touchpoints.
- NO sales language: don't mention social media, video, content, branding, marketing, services, growth, retention — that comes later.
- NO compliments on photo, appearance, or anything personal.
- NO emojis. NO exclamation marks. NO question marks.
- NO promises about numbers, results, or growth.

CONFIDENCE:
- Confidence 0.9+ : you found something genuinely specific and plausible about this lead.
- Confidence 0.7-0.9 : your specific reference is plausible but not verified.
- Confidence 0.6-0.7 : you used the "love what you do at {company}" fallback because you couldn't find a specific hook.
- Confidence <0.6 : something feels wrong — flag for manual review.

OUTPUT: One sentence. This IS the entire connection-request note. Nothing will be appended after it. The recipient already sees "${OPERATOR} sent you a connection request" in LinkedIn's UI, so no signature needed.`;

async function claudePersonalize(lead) {
  const userMsg =
    `Lead:\n` +
    `- name:     ${lead.first_name} ${lead.last_name}\n` +
    `- title:    ${lead.title}\n` +
    `- company:  ${lead.company}\n` +
    `- industry: ${lead.industry || '<unknown>'}\n\n` +
    `Write one opening sentence for a LinkedIn outreach message that ` +
    `specifically references this lead's club or role.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: SYSTEM,
    tools: [{
      name: 'write_opening_line',
      description: 'Records the one-sentence opener plus self-assessed confidence.',
      input_schema: {
        type: 'object',
        properties: {
          first_line: { type: 'string', minLength: 20, maxLength: 500 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason:     { type: 'string', maxLength: 200 },
        },
        required: ['first_line', 'confidence', 'reason'],
      },
    }],
    tool_choice: { type: 'tool', name: 'write_opening_line' },
    messages: [{ role: 'user', content: userMsg }],
  });
  const t = res.content.find((b) => b.type === 'tool_use');
  if (!t) return null;
  const { first_line, confidence, reason } = t.input;
  if (typeof first_line !== 'string' || typeof confidence !== 'number') return null;
  return { first_line: first_line.trim(), confidence, reason: (reason ?? '').trim(), usage: res.usage };
}

async function main() {
  const leads = await listLeadsByStatus({
    status: 'queued',
    missingProp: 'personalized_first_line',
    pageSize: BATCH,
  });
  if (!leads.length) {
    console.log('✅ Nothing to personalize — no queued leads with empty personalized_first_line.');
    return;
  }

  console.log(`✍️  Personalizing ${leads.length} lead${leads.length > 1 ? 's' : ''} (model=claude-haiku-4-5, threshold=${CONF_THRESHOLD})…\n`);
  let okCount = 0, lowConfCount = 0, errCount = 0, tokensIn = 0, tokensOut = 0;
  const now = new Date().toISOString();

  for (const lead of leads) {
    const label = `${lead.props.first_name} ${lead.props.last_name} @ ${lead.props.company}`;
    try {
      const out = await claudePersonalize(lead.props);
      if (!out) {
        errCount++;
        await mkdir(ERR_DIR, { recursive: true });
        await writeFile(join(ERR_DIR, `${Date.now()}__${lead.id}.json`),
          JSON.stringify({ lead_id: lead.id, label, error: 'malformed' }, null, 2));
        await updateLead(lead.id, { status: 'manual_review' });
        await appendNote(lead.id, '[personalize: malformed]');
        console.log(`   ❌ ${label} — malformed response, → manual_review`);
        continue;
      }
      tokensIn  += out.usage?.input_tokens  ?? 0;
      tokensOut += out.usage?.output_tokens ?? 0;

      if (out.confidence < CONF_THRESHOLD) {
        lowConfCount++;
        await updateLead(lead.id, {
          personalized_first_line: out.first_line,
          status: 'manual_review',
          last_action_at: now,
        });
        await appendNote(lead.id, `[personalize: low-conf ${out.confidence.toFixed(2)} | ${out.reason}]`);
        console.log(`   ⚠️  ${label} — conf=${out.confidence.toFixed(2)} → manual_review`);
      } else {
        okCount++;
        await updateLead(lead.id, {
          personalized_first_line: out.first_line,
          last_action_at: now,
        });
        await appendNote(lead.id, `[personalize: ok ${out.confidence.toFixed(2)} | ${out.reason}]`);
        console.log(`   🟢 ${label} — conf=${out.confidence.toFixed(2)}`);
        console.log(`        "${out.first_line}"`);
      }
    } catch (err) {
      errCount++;
      console.log(`   ❌ ${label} — ${err.message}`);
      await mkdir(ERR_DIR, { recursive: true });
      await writeFile(join(ERR_DIR, `${Date.now()}__${lead.id}.json`),
        JSON.stringify({ lead_id: lead.id, label, error: err.message }, null, 2));
    }
  }

  console.log(`\n══════ PERSONALIZE SUMMARY ══════`);
  console.log(`🟢 ok=${okCount} (still queued)`);
  console.log(`⚠️  low-conf=${lowConfCount} (→ manual_review)`);
  console.log(`❌ errors=${errCount}`);
  console.log(`📈 tokens: in=${tokensIn} out=${tokensOut}  (~$${((tokensIn * 1 + tokensOut * 5) / 1_000_000).toFixed(5)} on Haiku list price)`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
