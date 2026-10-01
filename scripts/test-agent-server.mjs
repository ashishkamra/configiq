// Run after npm run build. Exercises actual Next route bundles in one Node process.
// All inference/sizing is local deterministic fixture data, never a hardware benchmark.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

const scenario = { model_path: 'Qwen/Qwen3-8B', systems: ['l4'], backend: 'vllm', backend_version: null,
  isl: 2048, osl: 128, ttft: 1000, tpot: 30, target_concurrency: 8, target_request_rate: null,
  request_latency: null, prefix: 0, objective: 'satisfy_constraints' };
let sizingCalls = 0;
let holdCompletion = false;
let requestedTool = 'recommend_configuration';
let estimateData = { ttft: 200, tpot: 20, concurrency: 8 };
const sentPayloads = new Map();
const payloadHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const backend = createServer(async (request, response) => {
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    let data;
    if (request.url === '/tokenize') data = { count: 1000 };
    else if (request.url === '/models?include=specs') data = { models: [scenario.model_path] };
    else if (request.url === '/systems?include=specs') data = { systems: [{ id: 'l4', name: 'NVIDIA L4', memory_bytes: 24e9 }] };
    else if (request.url === '/recommend') {
      sentPayloads.set('recommend_configuration', body);
      sizingCalls++;
      assert.equal(body.target_concurrency, 8);
      data = { chosen_mode: 'agg', configs: [{ total_gpus_needed: 1, replicas_needed: 1, num_total_gpus: 1,
        tp: 1, pp: 1, dp: 1, ttft: 200, tpot: 20, concurrency: 8, tokens_per_second: 400, memory: 16 }] };
    } else if (request.url === '/estimate') {
      assert.equal('prefix' in body, false);
      sentPayloads.set('estimate_configuration', body);
      data = estimateData;
    } else if (request.url === '/memory') {
      sentPayloads.set('inspect_memory', body);
      data = { total_gpu_capacity_bytes: 24e9, total_kv_size_bytes: 2e9, kv_size_per_token_bytes: 1024, total_kv_size_tokens: 4096,
        memory_breakdown: { weights_bytes: 16e9, activations_bytes: 1e9, runtime_overhead_bytes: 0, comm_overhead_bytes: 0 } };
    } else if (request.url === '/v1/chat/completions') {
      if (holdCompletion) return; // The test cancels this request through the real run API.
      const state = JSON.parse(body.messages[0].content.split('Server-owned current state:\n')[1]);
      const name = !state.approved ? 'propose_scenario' : state.receipts.length ? 'finish' : requestedTool;
      const args = name === 'propose_scenario' ? { scenario, assumptions: ['Fixture workload for a production-route test'] }
        : name === 'finish' ? { resultIds: state.receipts.map(r => r.id) }
          : name === 'estimate_configuration' ? { system: 'l4', tp_size: 1, pp_size: 1, batch_size: 8 }
            : name === 'inspect_memory' ? { system: 'l4', tp_size: 1, pp_size: 1, max_batch_size: 8, max_num_tokens: 4096 }
              : { system: 'l4' };
      data = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
        usage: { completion_tokens: 100 } };
    } else { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  } catch { response.writeHead(500).end(); }
});
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const mockPort = backend.address().port;
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
  env: { ...process.env, CONFIGIQ_AGENT_ENABLED: 'true', CONFIGIQ_AGENT_SINGLE_PROCESS: 'true',
    CONFIGIQ_AGENT_ORIGIN: origin, CONFIGIQ_AGENT_MODEL_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    CONFIGIQ_AGENT_MODEL_API_KEY: 'test-only', CONFIGIQ_AGENT_MODEL_CONCURRENCY: '1', CONFIGIQ_AGENT_CONTEXT_TOKENS: '4096',
    AISIMULATORS_GATEWAY_URL: `http://127.0.0.1:${mockPort}` }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
app.stdout.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
app.stderr.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
let cookie = '';
async function request(path, method = 'GET', body) {
  const response = await fetch(`${origin}/api/agent/${path}`, { method,
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response;
}
async function turn(revision, event) {
  const response = await request('runs', 'POST', { revision, event, clientTurnId: randomUUID() });
  assert.equal(response.status, 200);
  const frames = (await response.text()).split('\n\n').flatMap(frame => frame.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))));
  assert.equal(frames.at(-1)?.type, 'run.finished');
  return frames.at(-1).snapshot;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null) throw new Error(`Next exited before ready: ${logs}`);
    try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Next did not become ready');
  const created = await request('session', 'POST'); assert.equal(created.status, 200); assert.ok(cookie);
  const proposed = await turn(0, { type: 'message', text: 'Size a workload for me' });
  assert.equal(proposed.run.status, 'awaiting_confirmation'); assert.equal(sizingCalls, 0);
  const read = await (await request('session')).json();
  assert.equal(read.proposal.id, proposed.proposal.id, 'Session store must be shared across route bundles');
  const completed = await turn(read.revision, { type: 'approve', proposalId: read.proposal.id });
  assert.equal(completed.run.status, 'completed'); assert.equal(sizingCalls, 1);
  assert.equal(completed.receipts[0].metrics.gpus.value, 1);
  assert.equal(completed.receipts[0].inputHash, payloadHash(sentPayloads.get('recommend_configuration')));
  assert.equal(completed.receipts[0].provenance.requestIdSource, 'configiq_adapter');
  const detail = await (await request(`runs/${completed.run.id}`)).json();
  assert.equal(detail.run.status, 'completed');
  holdCompletion = true;
  const pending = await request('runs', 'POST', { revision: completed.revision, clientTurnId: randomUUID(), event: { type: 'message', text: 'Please reconsider the workload' } });
  assert.equal(pending.status, 200);
  const reader = pending.body.getReader(), decoder = new TextDecoder();
  let framesText = '';
  while (!framesText.includes('\n\n')) {
    const { done, value } = await reader.read(); assert.equal(done, false);
    framesText += decoder.decode(value, { stream: true });
  }
  const firstEvent = JSON.parse(framesText.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal((await request(`runs/${firstEvent.runId}`, 'DELETE')).status, 200);
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    framesText += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  const cancelled = framesText.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1);
  assert.equal(cancelled.type, 'run.finished'); assert.equal(cancelled.snapshot.run.status, 'cancelled');
  assert.equal(sizingCalls, 1, 'Cancelling the new turn must not execute more sizing');
  assert.equal((await fetch(`${origin}/assistant`)).status, 200);
  assert.equal((await request('session', 'DELETE')).status, 200);
  assert.equal((await request('session')).status, 404);
  holdCompletion = false;
  for (const check of [
    { tool: 'estimate_configuration', data: {}, status: 'error' },
    { tool: 'estimate_configuration', data: { status: 'failed', error: { message: 'private simulator error' }, ttft: 200, tpot: 20 }, status: 'error' },
    { tool: 'estimate_configuration', data: { ttft: 200, tpot: 20, concurrency: 8 }, status: 'success' },
    { tool: 'inspect_memory', status: 'success' },
  ]) {
    requestedTool = check.tool; estimateData = check.data;
    assert.equal((await request('session', 'POST')).status, 200);
    const proposedTool = await turn(0, { type: 'message', text: 'Evaluate this fixture workload' });
    const outcome = await turn(proposedTool.revision, { type: 'approve', proposalId: proposedTool.proposal.id });
    const result = outcome.receipts[0];
    assert.equal(result.tool, check.tool); assert.equal(result.status, check.status);
    assert.equal(result.inputHash, payloadHash(sentPayloads.get(check.tool)));
    assert.deepEqual(result.inputs, sentPayloads.get(check.tool));
    assert.equal(result.provenance.contractVersion, '2');
    assert.equal(result.provenance.inputHashSource, 'wire_payload');
    if (check.status === 'error') {
      assert.deepEqual(result.metrics, {}); assert.match(result.error, /INVALID_EVIDENCE/);
      assert.equal(JSON.stringify(result).includes('private simulator error'), false);
    }
    if (check.tool === 'inspect_memory') assert.equal(result.inputs.memory_fraction_value, 1);
    assert.equal((await request('session', 'DELETE')).status, 200);
  }
  console.log('PASS: shared sessions, approval, sizing, SSE, cancellation, estimate failure rejection, memory evidence, exact payload provenance, and reset. Fake backends only.');
} catch (error) { console.error(logs); throw error; }
finally {
  app.kill('SIGTERM');
  await Promise.race([once(app, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (app.exitCode === null) app.kill('SIGKILL');
  backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
}
