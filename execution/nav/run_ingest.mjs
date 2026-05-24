// Navigator — orchestrates SOP 01 (ingest) + SOP 02 (ICP gate).
// Reads every .csv in ./inbox/, upserts new leads to Notion, classifies via
// deterministic filter (Stages 1+2). Falls back to Claude (Stage 3) only when
// the deterministic filter returns 'needs_llm'.
import 'dotenv/config';
import { readdir, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

import { ingestCsv } from '../tools/ingest_csv.mjs';
import { classify, TARGET_TITLES } from '../tools/icp_filter.mjs';
import { findLeadByUrl, createLead } from '../tools/notion_upsert.mjs';

const INBOX     = './inbox';
const PROCESSED = './inbox/.processed';
const REJECTED  = './inbox/.rejected';
const ERR_DIR   = './.tmp/ingest_errors';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ────────────────────────────────────────────────────────────────────────────
// Stage 3 — Claude relevance fallback
// ────────────────────────────────────────────────────────────────────────────
async function claudeIcpClassify(lead) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    tools: [{
      name: 'classify_lead',
      description: 'Classifies whether a lead is in our ICP',
      input_schema: {
        type: 'object',
        properties: {
          is_icp:     { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason:     { type: 'string', maxLength: 200 },
        },
        required: ['is_icp', 'confidence', 'reason'],
      },
    }],
    tool_choice: { type: 'tool', name: 'classify_lead' },
    system:
      'You are an ICP relevance classifier for a service that sells personal-brand-management ' +
      'to owners and CEOs of private member-owned clubs (tennis, country, racquet, golf, ' +
      'athletic, pickleball, squash). Public gyms, commercial fitness chains, and franchises ' +
      'are NOT in profile. Be strict.',
    messages: [{
      role: 'user',
      content: `Is "${lead.company}" (industry: "${lead.industry ?? '<unknown>'}", lead title: "${lead.title}") ` +
               'a private member-owned club of one of the listed types?',
    }],
  });
  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse) return null;
  const { is_icp, confidence, reason } = toolUse.input;
  if (typeof is_icp !== 'boolean' || typeof confidence !== 'number') return null;
  return { is_icp, confidence, reason };
}

function mapClaudeToStatus(out, lead) {
  if (!out) return { status: 'manual_review', reason: 'claude-malformed' };
  if (out.is_icp && out.confidence >= 0.7) {
    // Title check still required — reuses the canonical list from icp_filter.
    const titleHay = lead.title.toLowerCase();
    const titleOk = TARGET_TITLES.some((t) => titleHay.includes(t));
    return titleOk
      ? { status: 'queued',        reason: `claude-icp-ok conf=${out.confidence.toFixed(2)} | ${out.reason}` }
      : { status: 'manual_review', reason: `claude-icp-ok conf=${out.confidence.toFixed(2)} but title-miss | ${out.reason}` };
  }
  if (!out.is_icp && out.confidence >= 0.7) {
    return { status: 'irrelevant', reason: `claude-off-icp conf=${out.confidence.toFixed(2)} | ${out.reason}` };
  }
  return { status: 'manual_review', reason: `claude-low-conf conf=${out.confidence.toFixed(2)} | ${out.reason}` };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-file orchestration
// ────────────────────────────────────────────────────────────────────────────
async function processFile(filePath) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = basename(filePath);
  console.log(`\n📄 ${name}`);

  const parsed = await ingestCsv(filePath);
  if (!parsed.headers_ok) {
    console.log(`   ❌ malformed: missing headers ${parsed.missing_headers.join(',')}`);
    await mkdir(REJECTED, { recursive: true });
    await rename(filePath, join(REJECTED, `${ts}__${name}`));
    await mkdir(ERR_DIR, { recursive: true });
    await writeFile(join(ERR_DIR, `${ts}__${name}.json`),
      JSON.stringify({ file: name, reason: 'missing_headers', missing: parsed.missing_headers }, null, 2));
    return { file: name, status: 'rejected', new_leads: 0, errors: 1 };
  }

  console.log(`   parsed: ${parsed.rows.length} valid rows, ${parsed.row_errors.length} row errors`);

  let newCount = 0, skipCount = 0, errCount = parsed.row_errors.length, claudeCalls = 0;
  const counts = { queued: 0, manual_review: 0, irrelevant: 0 };
  const fileErrors = [...parsed.row_errors];
  let mid_file_failure = false;

  for (const lead of parsed.rows) {
    try {
      const existing = await findLeadByUrl(lead.linkedin_url);
      if (existing) { skipCount++; continue; }

      let decision = classify(lead);
      let icp_reason = decision.reason;
      let status;
      if (decision.decision === 'needs_llm') {
        claudeCalls++;
        const claudeOut = await claudeIcpClassify(lead);
        const mapped = mapClaudeToStatus(claudeOut, lead);
        status = mapped.status;
        icp_reason = `${decision.reason} | ${mapped.reason}`;
      } else {
        status = decision.decision;
      }

      await createLead(lead, status, icp_reason);
      counts[status]++;
      newCount++;
    } catch (err) {
      errCount++;
      mid_file_failure = true;
      fileErrors.push({ row: 'unknown', linkedin_url: lead.linkedin_url, reason: err.message });
      console.log(`   ⚠️  row error (${lead.linkedin_url}): ${err.message}`);
    }
  }

  // Write any errors to .tmp for later inspection
  if (fileErrors.length) {
    await mkdir(ERR_DIR, { recursive: true });
    await writeFile(join(ERR_DIR, `${ts}__${name}.json`),
      JSON.stringify({ file: name, errors: fileErrors }, null, 2));
  }

  // Archive iff no mid-file failure (SOP 01 rule 6).
  if (!mid_file_failure) {
    await mkdir(PROCESSED, { recursive: true });
    await rename(filePath, join(PROCESSED, `${ts}__${name}`));
  } else {
    console.log(`   ↩️  file kept in /inbox for retry due to mid-file failure`);
  }

  console.log(`   new: ${newCount} (queued=${counts.queued}, manual_review=${counts.manual_review}, irrelevant=${counts.irrelevant}) | skipped: ${skipCount} | errors: ${errCount} | claude calls: ${claudeCalls}`);
  return { file: name, status: mid_file_failure ? 'partial' : 'ok', new_leads: newCount, errors: errCount, claude_calls: claudeCalls };
}

// ────────────────────────────────────────────────────────────────────────────
// Entry — single-pass mode (watch mode lives in Phase T)
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(INBOX, { recursive: true });
  const files = (await readdir(INBOX))
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => join(INBOX, f));

  if (!files.length) {
    console.log('📭 No CSV files in ./inbox/ — nothing to do.');
    return;
  }

  console.log(`📨 Found ${files.length} CSV file${files.length > 1 ? 's' : ''} to process.`);
  const summary = [];
  for (const f of files) summary.push(await processFile(f));

  console.log('\n══════ INGEST SUMMARY ══════');
  for (const s of summary) {
    console.log(`${s.status === 'ok' ? '🟢' : s.status === 'partial' ? '🟡' : '🟥'} ${s.file} — new ${s.new_leads}, errors ${s.errors}, claude calls ${s.claude_calls ?? 0}`);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
