// Phase L probe — runs every probe and reports pass/fail summary.
import { spawn } from 'node:child_process';

const probes = [
  ['Anthropic', 'execution/probe/check_anthropic.mjs'],
  ['Notion',    'execution/probe/check_notion.mjs'],
  ['Slack',     'execution/probe/check_slack.mjs'],
  ['Gmail',     'execution/probe/check_gmail.mjs'],
  ['LinkedIn',  'execution/probe/check_linkedin.mjs'],
];

const results = [];
for (const [name, path] of probes) {
  console.log(`\n──── ${name} ─────────────────`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path], { stdio: 'inherit' });
    p.on('exit', resolve);
  });
  results.push({ name, ok: code === 0, code });
}

console.log('\n══════ SUMMARY ══════');
for (const r of results) {
  console.log(`${r.ok ? '🟢' : '🟥'} ${r.name} (exit ${r.code})`);
}
const allGreen = results.every(r => r.ok);
console.log(allGreen ? '\n✅ Phase L complete — all links green.' : '\n⚠️  Phase L incomplete. Fix red probes before Phase A.');
process.exit(allGreen ? 0 : 1);
