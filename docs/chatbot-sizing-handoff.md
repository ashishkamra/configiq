# Agentic sizing implementation handoff

**For continuing the current code, start with the newer
[continuation handoff](agent-continuation-handoff.md) and
[implementation record](agent-implementation-record.md).** This document retains
the original implementation breakdown for design context.

Status: original implementation breakdown; application implementation is now available.  
Prepared: 2026-09-30.  
Design authority: [Agentic sizing with Qwen 8B](chatbot-sizing-plan.md).
Read the [current runbook](agent-runbook.md) before further work; it records the
implemented paths, deliberate simplifications, and outstanding L4 qualification.

## 1. Read this first

Implement an evidence-backed sizing agent, not a general chatbot and not an
unrestricted autonomous operator. The model selects tools and adapts to results;
deterministic code owns authorization, validation, budgets, and final metrics.

Selected family: `Qwen/Qwen3-VL-8B-Instruct`. Preferred single-L4 candidate:
`Qwen/Qwen3-VL-8B-Instruct-FP8`, reviewed revision
`9cdc6310a8cb770ce18efaf4e9935334512aee45`. This is an 8B-branded model with about
8.77B total parameters, not the older text-only Qwen3-8B. The design document
explains “latest,” exclusions, evidence, and the mandatory recheck before rollout.
Do not silently switch checkpoints if the selected model fails qualification.

This handoff creates no permission to provision infrastructure, expose the model
server publicly, add authentication/database infrastructure, or change GPU math.
The first implementation should be a small vertical slice with mocked tools,
then a gated real-model smoke test on the actual L4.

## 2. What exists and what does not

| Existing location | Reuse or caution |
| --- | --- |
| `AGENTS.md` | Current project rules: PatternFly v5, Red Hat fonts, strict TypeScript, service-owned sizing |
| `lib/api/schemas.ts` | Strict recommendation and memory request schemas; exactly one load target |
| `lib/api/recommend.ts` | `callRecommend`, normalized `RecommendResult`, aggregate/disaggregated layouts; some legacy absent metrics default to zero |
| `lib/api/kv-cache-calc.ts` | Existing `callKvCacheCalc`, used by the memory route |
| `lib/api/timeout.ts` | Gateway timeout helper; default 90 seconds |
| `app/api/catalog/route.ts` | Server-side `/models?include=specs` and `/systems?include=specs`; extract shared client rather than loopback HTTP |
| `app/api/estimate/route.ts` | Existing proxy lacks a strict request contract at this layer; add validation in the agent adapter |
| `app/api/recommend/route.ts` | Normal route validates; `include` branch passes through—do not use it as an agent validation bypass |
| `app/api/memory/route.ts` | Validates memory requests and calls shared client |
| `app/api/hf-config/route.ts` | Inspect before extracting a controlled model-config resolver; never accept arbitrary fetch URLs |
| `lib/api/estimate-adapter.ts` | Includes browser-relative API fetch behavior; not a drop-in server tool |
| `lib/hooks/useCatalog.ts` | Actual catalog hook file; AGENTS references the hook by the `useAicCatalog` name |
| `contexts/RecommendContext.tsx` | Existing `startSizing` entry point; explicit draft/result hydration must be designed and tested |
| `app/recommend/AdvancedEstimate.tsx` | Existing form to integrate; do not assume query-string hydration already exists |
| `lib/recommend-cost/economics.ts` | Existing cost calculations; reuse later instead of asking the LLM to calculate cost |
| `services/configiq-py/configiq/mcp.py` | Optional FastAPI MCP SSE mounting at `/mcp`; leave unchanged for MVP |
| `Containerfile` | Standalone Next.js Node deployment exists; actual host/proxy configuration still needs inspection |

The assistant UI, agent controller, agent API, offline tests, and opt-in model
evaluation suite are now implemented. The separate deployment repository was not
available, and model deployment/hardware benchmarks remain qualification tasks.

At handoff time the working tree already contained unrelated changes in
`.gitignore`, `CLAUDE.md`, `next.config.js`, `tsconfig.json`, and untracked local
development/tooling files. Inspect current status anew; preserve unrelated work.
Do not stage or commit without an explicit request.

## 3. Decisions to preserve

1. One bounded agent loop in Next.js's Node runtime; native HTTP model client and
   existing Zod, no orchestration framework dependency initially.
2. Qwen model proposes actions; only application handlers execute them.
3. All sizing goes through AISimulators; no new formulas in React or legacy math.
4. Tool calls and responses are both validated. Structured generation is helpful,
   not a replacement for application validation or permissions.
5. Text only. Disable image/video ingestion, browsing, shell, arbitrary MCP
   discovery, and infrastructure mutation.
6. Server-owned ephemeral state in one long-lived Node process for the pilot.
   Multiple workers/replicas or serverless deployment block this storage choice.
7. Human approval binds to material assumptions and candidate scope; tool reads
   within an approved plan do not need a confirmation click each time.
8. Deterministic evidence-backed rendering; no unverified numerical prose.
9. Feature flag off by default; ordinary sizing remains independent of the agent.

## 4. Contracts to implement before the loop

The following are proposed contracts, not currently exported interfaces. Define
them with strict Zod schemas and inferred TypeScript types; reject unknown fields.

### Scenario and run records

| Record | Required content |
| --- | --- |
| `Scenario` | ID, revision, parent revision, objective, model ID, backend/version, ISL/OSL tokens, TTFT/TPOT in ms, optional E2E SLA, prefix, approved system IDs, hard constraints, load discriminant, per-field provenance |
| `LoadTarget` | Discriminated concurrency or request-rate value; never both; project schema validates positivity |
| `Proposal` | ID, scenario revision/hash, proposed patch/defaults, candidate scope, visible action summary, expiry, server-owned approval status |
| `Run` | ID, session binding, clientTurnId, scenario revision, status, remaining budgets, deadline, result IDs, cancellation state |
| `ToolReceipt` | ID, tool/contract version, input hash, scenario revision, normalized inputs/result, timestamp, request ID if available, warnings, field availability, classified error |
| `AnswerArtifact` | Referenced receipts, metric field references, checked comparison/SLA predicates, limitations, safe explanation, allowed handoff actions |

Represent unset fields as missing/null, not guessed numeric defaults. Catalog
resolution does not constitute user approval for a changed model or workload.
Build a canonical adapter from `Scenario` to `RecommendRequestSchema`; for
comparison invoke it separately for each approved `system`. Do not add a fictitious
“all GPUs” system or promise a globally optimal result.

Use the design's explicit objective enum (`satisfy_constraints`,
`minimize_gpu_count`, `minimize_ttft`) and ranking rules. If the user has not chosen
an optimization objective, compare without a winner. Do not silently interpret
“cheapest” as “fewest GPUs” while pricing tools remain out of scope.

Server-normalized receipts must distinguish absent throughput/latency from real
zero values. Fix this at a shared compatible boundary or retain availability
metadata in the agent adapter. Test existing callers when changing normalization.
Validate GPU counts, replica topology, phase details, units, and finite numbers.

### Tool adapter contract

Each registry entry declares a name, version, strict argument/result schemas,
allowed run states, approval requirement, expense class, timeout, handler, and
safe model-visible result projection. The handler receives session/run context
and an abort signal; never take those trusted values from model arguments.

Every invocation must pass: allowlist -> schema -> ownership/revision -> scope
approval -> budget/admission -> execution -> response validation -> receipt.
Reject extra arguments, non-finite numbers, unsupported configuration combinations,
unknown model/system IDs, and references owned by another session.

Prefer `scenarioId`, `revision`, `systemId`, and `resultId` arguments over resending
all workload values. Keep catalog/tool results short; never stuff the whole catalog
or raw debug payload into the model context. Keep needed warnings and provenance.

### Model wire contract

Use the private OpenAI-compatible `/v1/chat/completions` endpoint with native tool
definitions. Preserve assistant tool-call IDs and matching tool-role results.
Collect the complete model decision before dispatch; if several tool calls are
returned, validate all, reject dependent/contradictory batches, and run only
independent permitted calls within the global limits. Do not assume that requesting
no parallel tool calls guarantees the model obeys it.

At qualification, test bundled template + candidate `hermes` parser with automatic
tool choice, an explicit named call, tool-result continuation, and no-tool answers.
Also test malformed JSON, unknown tool names, truncated output, and argument schema
violations. Record which constrained-decoding modes the pinned runtime supports.
One format repair is allowed; repeated failures terminate safely. No regex-based
execution of tool-looking text and no fallback to executing model-generated code.

Version the system policy and tool descriptions. Include domain boundaries,
approval rules, honest uncertainty, and budget visibility. Store only concise
action summaries and final answers, not private chain-of-thought.

## 5. Proposed HTTP and streaming surface

All routes use the Node runtime, enforce the server feature flag, same-origin
policy, session ownership, size limits, and admission limits. The browser never
contacts vLLM or an external gateway directly.

| Route | Contract |
| --- | --- |
| `POST /api/agent/session` | Create opaque session cookie and return initial state; no model call |
| `GET /api/agent/session` | Return unexpired public scenario/run snapshot; no secrets or internal prompts |
| `DELETE /api/agent/session` | Cancel work, delete retained state, clear cookie |
| `POST /api/agent/runs` | Accept `clientTurnId`, expected scenario revision, and exactly one text/edit/approval event; stream run events |
| `GET /api/agent/runs/[runId]` | Return owned run snapshot after disconnect or duplicate submission |
| `DELETE /api/agent/runs/[runId]` | Idempotently cancel an owned run |

Use fetch-based POST streaming with `text/event-stream`; browser EventSource alone
does not implement POST request bodies. Events contain `runId`, monotonic sequence,
scenario revision, type, and validated payload. Proposed event types:
`run.started`, `plan.updated`, `scenario.updated`, `input.required`,
`confirmation.required`, `tool.started`, `tool.completed`, `result.ready`,
`answer.ready`, `run.completed`, `run.partial`, `run.failed`, `run.cancelled`.

Stream trusted progress and verified artifacts; do not stream unchecked numerical
model prose to the user and attempt to retract it later. Coalesce screen-reader
announcements. Send heartbeats while waiting, disable proxy buffering, and cap
event size/history. A closed stream cancels work; reconnect reads a snapshot and
never restarts the operation automatically.

Reserve a per-session lock and idempotency record before executing anything.
Repeated `clientTurnId` with the same payload returns the existing run ID/snapshot;
the same key with a different payload returns 409. A concurrent distinct turn or
stale scenario revision returns 409. Use 400 for invalid input, 413 for oversized
input, 429 plus Retry-After for admission limits, and 503 for disabled/unavailable
agent infrastructure. After headers are sent, failures use terminal stream events.
Return a consistent not-found response for unknown or unowned run identifiers.

## 6. Storage, cancellation, and context mechanics

Implement a runtime-scoped store behind an interface so future shared storage
does not leak into the controller. The pilot must deploy exactly one serving Node
process, not rely on an incidental per-route module cache across serverless workers.
Verify shared store behavior between route handlers in the production build.

Use 30-minute idle expiry, 500-session cap, 256 KiB/session cap, and at most 512
retained public events per session. Reject oversized ingress (initial limit: 16 KiB
per user message and 32 KiB per request). Compact old conversation history while
retaining current canonical state and necessary receipts; never compact away the
provenance needed by a live recommendation. If evidence must be evicted, expire
its dependent artifact. Tell users that history is ephemeral.

Use the model tokenizer or serving token-count facility to budget the entire
prompt, tools, recent messages, and reserved output. If over budget, narrow tool
visibility and summaries; if still too large, ask to narrow scope rather than
silently truncate approved constraints. Never summarize authoritative state solely
through the LLM. The 4K context target includes the 512-token output reserve.

The controller owns one run-level abort signal composed with request cancellation
and per-operation deadlines. Extend shared clients to accept optional signals
without changing existing callers. Release locks/semaphores on all exit paths;
ignore late results from cancelled or superseded runs. Test whether upstream work
actually stops after disconnect, rather than claiming HTTP abort proves it.

Implement the exact budgets in the design document in one configuration module:
180-second run, 15-second queue wait, 8 model calls, 12 tools, 4 expensive calls,
3 candidate systems, 512 output tokens/call and 4,096/run. Retries/repairs consume
these same budgets. Global limits are 4 active runs, 8 waiting, 2 model calls,
2 sizing calls, and 1 active run/session; begin hardware qualification at one
model call. Enforce fairness so a comparison cannot monopolize sizing permits.
Per-operation timeouts are 30 seconds for a model call, the existing 30-second
catalog baseline, and the configured sizing timeout (90 seconds by default),
each bounded by the remaining run deadline. Preserve existing validated gateway
timeout overrides rather than hard-coding another independent service timeout.

## 7. File-level implementation map

These are planned paths; create only as each increment needs them.

| Location | Responsibility |
| --- | --- |
| `lib/agent/contracts.ts` | Scenario/run/event/tool/answer schemas |
| `lib/agent/config.ts` | Validated server configuration, budgets, feature flag |
| `lib/agent/model-client.ts` | Private Qwen HTTP transport, tool message framing, aborts |
| `lib/agent/policy.ts` | Scope, confirmation, permissions, state guards |
| `lib/agent/controller.ts` | Bounded observe/act/revise loop |
| `lib/agent/store.ts` | Session-owned ephemeral state, revision checks, idempotency |
| `lib/agent/limits.ts` | Global admission, fair semaphores, deadlines |
| `lib/agent/tools/` | Validated catalog, recommendation, estimate, memory, control tools |
| `lib/agent/evidence.ts` | Receipts, field availability, comparison predicates, artifact validation |
| `lib/agent/prompt.ts` | Versioned policy and concise domain instructions |
| `lib/api/catalog.ts`, `lib/api/estimate.ts` | Proposed shared server clients extracted with regression coverage |
| `app/api/agent/` | Session/run/cancellation routes |
| `app/assistant/page.tsx` | Server page boundary with interactive client subtree |
| `components/assistant/` | Conversation, scenario editor, approval, progress, evidence, result UI |
| `contexts/RecommendContext.tsx`, `app/recommend/AdvancedEstimate.tsx` | Explicit validated draft import and optional current-result hydration |
| `lib/agent/__tests__/`, route/component tests | Mock-model deterministic coverage |
| `tests/agent-evals/` | Versioned multi-turn task fixtures and expected tool/evidence behavior |

Keep deployment artifacts in the actual deployment repository once located.
Document the image digest, checkpoint revision, hardware/runtime inventory,
tokenizer/template, parser, limits, launch flags, and measured results. Do not add
a second deployment framework to this repo solely to satisfy this handoff.

## 8. Configuration and L4 qualification

Proposed new server-only settings: `CONFIGIQ_AGENT_ENABLED` (false by default),
`CONFIGIQ_AGENT_MODEL_BASE_URL`, `CONFIGIQ_AGENT_MODEL_ID`, and
`CONFIGIQ_AGENT_MODEL_API_KEY`. Reuse `AISIMULATORS_GATEWAY_URL` and
`AISIMULATORS_TIMEOUT_SECONDS`. Reject malformed settings at startup; when the
feature is disabled, missing model settings must not break the existing app.

Never prefix model credentials with `NEXT_PUBLIC_`. `.env.example` and `.env.local`
already existed during review; do not overwrite them or copy secrets into docs.
When implementing, add only documented placeholders to the example file and use
the host's secret mechanism for deployment. No new environment settings are needed
to use these planning documents.

Phase 0 deliverables:

- Inventory actual L4 VRAM/free memory, driver/CUDA, other GPU consumers, host
  CPU/RAM/disk, container runtime and GPU access. Record, do not assume.
- Select a stable compatible vLLM image and pin its digest. The historical recipe's
  minimum version is not a recommendation to deploy that old version or `latest`.
- Pin the reviewed model revision. Use tensor parallelism 1 and text-only serving;
  qualify exact image/video disable flags and template/parser settings with that
  runtime. Do not enable remote model code just because a sample does.
- Run FP8 kernel/load tests, native tool round trips, structured output tests,
  token-budget overflow, restart readiness, and cancellation tests.
- Compare 4K/8K context and 1/2 concurrent generations; record latency, throughput,
  KV allocation, total device memory, and failures. Retain at least 2 GiB measured
  headroom or the larger reserve demanded by co-resident workloads.
- Run the one-hour mixed sizing/agent soak. A passing L4 result is required before
  setting the feature flag on; template support alone is not sufficient.
- Inspect the real reverse proxy. Set buffering/heartbeats/timeouts so an allowed
  180-second run can stream and terminate cleanly without breaking sizing routes.

No tested launch command, image digest, measured performance, or capacity guarantee
is supplied by this handoff. Write the reproducible deployment command only after
these checks, using the pinned runtime's documented flags.

## 9. Ordered work packages and acceptance

```markdown
- [ ] P0 — Qualify the actual L4 and model/runtime pair; record evidence and pins.
- [ ] P1 — Add schemas, store, policy, budgets, and a fake model transport.
- [ ] P2 — Add catalog/recommend tools and compatible shared-client extraction.
- [ ] P3 — Complete one vertical slice: objective -> clarification/approval ->
           recommend -> verified artifact, with cancellation and idempotency.
- [ ] P4 — Add adaptive comparisons, estimate/memory tools, and partial outcomes.
- [ ] P5 — Add the PatternFly assistant, scenario revisions, and form handoff.
- [ ] P6 — Run evaluation, security, accessibility, and mixed-load release gates.
- [ ] P7 — Deploy to an internal pilot behind the flag; document rollback.
```

P1/P2 can proceed with mocks while P0 awaits host access. Real-model rollout is
blocked on P0. Do not spend the first implementation increment building a polished
chat UI around unqualified tools. Optional cost optimization, curated retrieval,
MCP transport, and vision are separate follow-up work, not hidden P3 dependencies.

### Required tests

| Area | Cases and pass condition |
| --- | --- |
| Input | Missing fields, zero/negative/non-finite values, tokens vs characters, seconds vs ms, employees vs concurrency, both/neither load targets |
| Policy | Explicit approved plan, unconfirmed defaults, unauthorized model/SLA changes, self-approved model output, expired proposal |
| Loop | Dependent tools, alternate candidate after infeasibility, repeat-call deduplication, repair/retry budgets, terminal states |
| Evidence | Exact metric parity, absent vs zero, aggregate/disaggregated layouts, partial comparisons, stale/foreign receipts, unsupported SLA claim |
| Isolation | Cross-session reads/cancel/approval, forged tool messages, origin mismatch, untrusted metadata injection, unsafe HTML, credential redaction |
| Lifecycle | Duplicate submits, mismatched idempotency payload, concurrent turns, out-of-order events, disconnect, timeout, late result, restart, TTL/eviction |
| Resources | Full queue, rate-limit bypass attempts, oversized requests, prompt overflow, token cap, all permits released on error |
| UX | Keyboard, focus after confirmation, screen-reader progress, reduced motion, responsive layout, visible partial/error/reset states |
| Handoff | Same scenario in Recommend; explicit user-triggered calculation; no accidental double request or raw transcript in URL |

Create at least 50 curated multi-turn tasks, including “500 employees,” “try a
different GPU,” infeasible SLAs, unavailable pricing, and hostile metadata. Run
the set three times with recorded model/runtime/prompt versions. Apply the design's
95% field extraction, 90% supported-task completion, 100% numeric fidelity, and
zero unauthorized-action gates. Keep mocked contract tests separate from
stochastic model-quality results; do not hide failure behind automatic retries.

Run existing repository checks during implementation: `npm test`, `npm run lint`,
`npm run type-check`, and `npm run build`. Run Python service tests if those
services are changed. These commands are future implementation checks, not claims
that an unimplemented agent has passed them.

## 10. Operational handoff and first next action

Before enabling the pilot, deliver an operator runbook with private endpoint
connectivity, pins, health/readiness probes, resource limits, redacted tracing,
queue behavior, TTL semantics, model restart, and rollback procedures. Alert on
OOM/restarts, growing queues, tool failure spikes, and direct-sizing latency
regression. Keep raw chat logging off by default.

Rollback: disable the server feature flag, cancel/drain agent runs, stop the model
container if necessary, and verify existing Recommend/Performance/Memory paths.
An unavailable agent must not change global application health to unhealthy while
ordinary sizing still works; expose agent readiness separately.

**First next action:** read this document and the linked design, inspect the live
working tree and deployment topology, then start P0 and a mocked P1/P2 vertical
slice. Do not claim L4 readiness without access to that host. Track unresolved
image/kernel/parser compatibility, available GPU headroom, streaming proxy limits,
and one-process session-store behavior as explicit release blockers.

This document originally accompanied a documentation-only delivery. Application
implementation is now recorded in the linked runbook. No new third-party
dependency, secret, model download, hardware qualification, or deployment change
is implied by that implementation.
