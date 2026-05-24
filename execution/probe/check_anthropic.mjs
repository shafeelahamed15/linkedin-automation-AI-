// Phase L probe — Anthropic / Claude API
// Verifies ANTHROPIC_API_KEY is valid by making a tiny request.
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('❌ ANTHROPIC_API_KEY is missing in .env');
  process.exit(1);
}

const client = new Anthropic({ apiKey: key });

try {
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Say "pong" and nothing else.' }],
  });
  const text = res.content?.[0]?.text?.trim() ?? '';
  console.log(`✅ Claude reachable. Model replied: "${text}"`);
  console.log(`   input_tokens=${res.usage.input_tokens} output_tokens=${res.usage.output_tokens}`);
  process.exit(0);
} catch (err) {
  console.error('❌ Claude probe failed:', err?.message ?? err);
  process.exit(2);
}
