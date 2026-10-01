// Run explicitly against the private model server. Does not execute generated tools.
import assert from 'node:assert/strict';
const base = process.env.CONFIGIQ_AGENT_MODEL_BASE_URL?.replace(/\/$/, '').replace(/\/v1$/, '');
const key = process.env.CONFIGIQ_AGENT_MODEL_API_KEY;
const model = process.env.CONFIGIQ_AGENT_MODEL_ID || 'Qwen/Qwen3-VL-8B-Instruct-FP8';
assert.ok(base && key, 'Set CONFIGIQ_AGENT_MODEL_BASE_URL and CONFIGIQ_AGENT_MODEL_API_KEY');
const tools = [{ type: 'function', function: { name: 'probe', description: 'Echo the supplied word.',
  parameters: { type: 'object', properties: { word: { type: 'string', enum: ['ready'] } }, required: ['word'], additionalProperties: false } } }];
const messages = [{ role: 'user', content: 'Call probe with word ready.' }];
async function post(path, body) {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${path} returned ${response.status}`);
  const data = await response.json();
  console.log(`${path}: ${Math.round(performance.now() - start)} ms`);
  return data;
}
const tokenized = await post('/tokenize', { model, messages, tools, add_generation_prompt: true });
assert.ok(Number.isInteger(tokenized.count), 'Tokenizer count missing');
for (const tool_choice of ['auto', { type: 'function', function: { name: 'probe' } }]) {
  const completion = await post('/v1/chat/completions', { model, messages, tools, tool_choice, parallel_tool_calls: false, temperature: 0.2, max_tokens: 128 });
  const call = completion.choices?.[0]?.message?.tool_calls?.[0];
  assert.equal(call?.function?.name, 'probe'); assert.deepEqual(JSON.parse(call.function.arguments), { word: 'ready' });
  assert.ok(call.id, 'Native tool call ID missing');
  const continuation = await post('/v1/chat/completions', { model, tools, tool_choice: 'none', max_tokens: 64,
    messages: [...messages, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '{"word":"ready"}' }] });
  assert.equal(typeof continuation.choices?.[0]?.message?.content, 'string');
}
console.log('PASS: tokenizer, automatic/named tool calls, and tool-result continuation. This is not an L4 capacity or quality qualification.');
