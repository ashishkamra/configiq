# Continuation handoff: ConfigIQ sizing agent

Prepared: 2026-10-01. Audience: the next coding model or engineer.

## 1. Start here

**Do not reimplement the assistant from scratch.** A substantial working-tree
implementation already exists. The user requested continuation after the initial
handoff. The estimate-validation gap and core payload-provenance gaps have now
been fixed. Software tests/build checks pass, but real-gateway integration and
Qwen/L4 production qualification are still incomplete.

Read in this order:

1. Root `AGENTS.md` and any applicable local instructions.
2. [Implementation record](agent-implementation-record.md): exact file inventory,
   behavior, latest verification results, and known gaps.
3. [Operator runbook](agent-runbook.md): environment and operational constraints.
4. [Design baseline](chatbot-sizing-plan.md): model selection and intended gates.
5. [Original handoff](chatbot-sizing-handoff.md): earlier proposed breakdown;
   some proposed filenames were consolidated into actual modules.

Use CodeGraph first for code exploration where available. Respect PatternFly v5,
Red Hat typography/sentence case, strict TypeScript, and AISimulators ownership
of sizing math. Do not add a database, auth framework, agent orchestration
framework, Tailwind, or client-side GPU formulas merely to continue this work.

## 2. Current architecture and entry points

User page: `app/assistant/page.tsx` -> `components/assistant/Assistant.tsx`.
The page is dynamic and shows a normal-form fallback when the feature is off.

API route files delegate to `lib/agent/routes.ts`:

| Endpoint | Current behavior |
| --- | --- |
| `POST /api/agent/session` | Create/reuse session cookie and return public snapshot |
| `GET /api/agent/session` | Read unexpired state; no-store |
| `DELETE /api/agent/session` | Abort owned work, remove state, clear cookie |
| `POST /api/agent/runs` | Validate one user/edit/approval event, reserve run/idempotency, stream progress/artifacts |
| `GET /api/agent/runs/[runId]` | Owned run snapshot |
| `DELETE /api/agent/runs/[runId]` | Abort owned run |

Run creation calls `store.begin`; execution calls `executeRun`. A single model
decision produces one tool call, validated against `ToolSchemas` and state-specific
allowed names. Sizing tools call the existing recommendation/memory normalizers
or new constrained catalog/estimate clients. Receipt metrics and comparisons are
deterministic. `finish` accepts receipt IDs, not a free-form numerical answer.

Run states are queued/planning/executing/verifying, waiting for input/confirmation,
or completed/partial/failed/cancelled. Waiting states end the stream and release
permits; a reply is a new run. No GPU slot is held while a user reviews a proposal.

There is no separate planner model, verifier model, `policy.ts`, Python agent
service, or persisted conversation database. Core policy is in the controller
and tool service. Existing MCP support was not changed or used by this agent.

## 3. Important contracts and invariants

### User state

`ScenarioSchema` requires full model/system/backend/workload/SLA fields before
proposal; unknown input is gathered through `ask_user`, not represented as an
arbitrary partial executable request. Exactly one positive concurrency or
request-rate target is allowed. The approved system set has one to three IDs.

Every proposal, including complete initial input and user edits, requires review.
Approval is a server-owned proposal UUID + current revision + expiry check. New
text removes authorization. New proposals increment the revision and clear old
receipts. Only one active run may exist per session. A changed payload cannot
reuse a turn idempotency key. The model never receives a tool that can approve.

The UI blocks approval while editor fields are dirty. Preserve this behavior:
otherwise a user can approve old server values while viewing unsaved new ones.

### Tool and evidence boundaries

- Never invoke model text as code or run partial streamed tool arguments.
- Preserve native tool-call IDs and matching tool-role messages.
- Validate both argument schemas and domain semantics/approval.
- Reuse `callRecommend`/`callKvCacheCalc`; their new optional hooks accept an abort
  signal, raw validator, and response-body reader without changing old callers.
- Do not certify legacy zero defaults as measured values.
- Reject contradictory topology and missing disaggregated prefill/decode phases.
- Only current owned receipts can be referenced in comparisons/finalization.
- Do not translate an error/timeout into an infeasible or more expensive candidate.
- No model-generated GPU counts or prices in result rendering.
- Keep cancellation checks after awaits so late results cannot become current.

### Runtime and data handling

Session store/semaphores/rate limiter use versioned `globalThis` slots in one
long-lived Node process. This was tested across actual production route bundles.
Do not substitute per-route caches or enable serverless/multiple replicas without
implementing shared state, atomic locks/idempotency, and isolation.

User messages, proposals, and receipts are ephemeral and server-owned. Clients
cannot supply system messages, trusted tool history, budgets, or fabricated
results. Cookies are HttpOnly/SameSite Strict/Secure on HTTPS; no wildcard CORS.
Public HF redirects stay on the permitted repository and host, with bounded reads.

Existing sizing-form handoff uses `lib/agent/client.ts` and a one-use validated
sessionStorage entry. No raw transcript or credentials are placed in the URL.
Loading a draft never calls sizing; the user must choose Calculate.

## 4. Exact current verification state

- 296 offline tests passed; 150 real-model evaluations were skipped deliberately.
- Lint completed with two pre-existing warnings (cluster-cost hook dependency
  and root-layout font usage), no new lint errors.
- Type checking passed.
- The final implementation built successfully in isolated ignored `build/`.
- The actual built-server script passed session sharing, approval, sizing, SSE,
  evidence, cancellation, run lookup, reset, invalid/failed estimate rejection,
  memory evidence, and exact payload provenance checks using fake backends.
- No real-model smoke/evaluation or actual L4 benchmark was run.

Reproduce offline checks:

```bash
npm test
npm run lint
npm run type-check
```

Reproduce the final successful production checks without sharing the default
Next output with another process:

```bash
CONFIGIQ_DEV_DIST_DIR=build NEXT_TELEMETRY_DISABLED=1 npm run build
CONFIGIQ_DEV_DIST_DIR=build NEXT_TELEMETRY_DISABLED=1 npm run test:agent:server
```

`next.config.js` already supports `CONFIGIQ_DEV_DIST_DIR` as pre-existing user
work. `build/` is ignored. Next may automatically reformat `tsconfig.json` and
insert `build/types/**/*.ts`; do not discard the user's existing
`.next-dev-local/types/**/*.ts` include when removing temporary build changes.

Default-directory build attempts intermittently timed out; the isolated build
succeeded, with transient Google Fonts retries. The root cause of the stalls was
not conclusively diagnosed. Do not stop unrelated Next servers or disable TLS
verification to make the build pass. The ordinary build script also refreshes
generated metadata in ignored `.env.local`; do not overwrite its real settings.

## 5. Highest-priority next implementation work

### A. Estimate response-validation gap — completed

Location: `lib/api/estimate.ts`, especially `EstimateEvidenceSchema` and
`callEstimate`; publication occurs in `lib/agent/tools.ts`.

TTFT and TPOT are now required positive finite numbers. Empty/unrelated JSON,
HTTP-200 failure envelopes (even with valid timing fields), invalid timings,
non-aggregate modes, and mismatched response scope fail with `INVALID_EVIDENCE`.
The error path preserves safe attempted-payload provenance and clears successful
metrics. Optional metrics remain optional; missing concurrency/request rate is
not inferred from batch size or requested load. Nonzero cached prefixes fail
before dispatch because the current service request does not define prefix.

Required work:

```markdown
- [x] Add regression tests for empty, unrelated, and HTTP-200 failure-envelope JSON.
- [x] Validate the source-defined response contract before extracting metrics.
- [x] Require both positive TTFT and TPOT for successful estimate evidence.
- [x] Preserve legitimate missing optional metrics without inventing zeros.
- [x] Return classified error/unsupported results, not success-labeled empty evidence.
- [x] Test request-rate cases, missing concurrency, and unsupported configurations.
- [ ] Capture and qualify actual deployed gateway responses; fixtures are not live captures.
```

Read `lib/api/estimate-adapter.ts` and the service's `EstimateRequest`/response
contract before changing field names. Existing Performance sends
`/api/estimate?include=config,memory`, handles MoE dimensions, and supports
disaggregated pools. The new agent adapter is narrower. Do not blindly copy the
legacy Performance adapter's locally derived throughput/memory formulas into the
agent; obtain authoritative fields from the service or mark them unavailable.

### B. Provenance — core payload capture completed; live coverage still required

`lib/agent/provenance.ts` captures exact serialized wire payloads through detached
adapter `onRequest` callbacks, after request normalization. Receipts include
contract version 2 and prompt bundle version 2, payload/hash source, endpoint,
model-config digest, and adapter request-ID scope. Sent failures retain their
payload metadata via `SizingToolError`; the controller does not reconstruct them
as generic unversioned receipts. Unsent failures explicitly mark payload capture
false and their hash source as scenario/tool arguments.

Tests verify successful and failed attempts, memory defaults, model-config
redaction, observer mutation isolation, and compiled-route payload/hash parity.
Public `inputs` exclude full model configs; SHA-256 fingerprints include the
complete wire payload and a separate config digest. IDs are explicitly
`configiq_adapter` or `none`, not asserted as upstream trace correlation.
`CONFIGIQ_AGENT_MODEL_REVISION` is optional operator-declared provenance, **not**
runtime checkpoint verification. No default revision is invented.
Payload capture is a dispatch-boundary observation, not proof of remote delivery
or execution. Source-contract fixtures and a local receiving server establish
offline behavior, not real-gateway qualification.

Remaining work: qualify live responses, correlate upstream traces if available,
and decide whether to implement full per-field scenario provenance. The current
proposal-source/assumptions mechanism is coarser than the original design.

Add success-path estimate and memory fixtures captured from the current gateway,
not only fabricated recommendation fixtures. Exercise aggregate/disaggregated,
MoE, missing-version, invalid response, timeout, and cancellation paths. Declare
unsupported capabilities explicitly instead of silently presenting limited tools
as full equivalents of every ConfigIQ form.

### C. Qualify the actual Qwen runtime and L4

Host access/model endpoint were not available. Do not assert that the development
machine is the user's L4 machine; `nvidia-smi` was not found here.

Candidate artifact: `Qwen/Qwen3-VL-8B-Instruct-FP8`, reviewed SHA
`9cdc6310a8cb770ce18efaf4e9935334512aee45`. Recheck official releases and current
vLLM support at implementation time; record any model substitution. Do not relabel
the older text-only Qwen3-8B or specialized WebWorld as the selected artifact.

Before enabling a pilot:

```markdown
- [ ] Inventory actual GPU/driver/CUDA/free VRAM and co-resident workloads.
- [ ] Locate the separate deployment repository and real streaming ingress.
- [ ] Select a stable compatible serving image; pin its digest and model revision.
- [ ] Verify private authenticated chat-completions and tokenizer endpoints.
- [ ] Test the bundled template and candidate Hermes parser with native tool calls.
- [ ] Start text-only at 4K total context and one generation; reserve measured headroom.
- [ ] Run the model smoke script and review every failure.
- [ ] Run the opt-in evaluation set and capture results with model/runtime/prompt pins.
- [ ] Measure whether full tool schemas and real observations fit the context budget.
- [ ] Add realistic follow-ups, infeasible comparisons, and domain-jargon cases.
- [ ] Verify exact parity with real AISimulators and the standard sizing experience.
- [ ] Run the mixed-load soak and check upstream cancellation, queue growth, and OOMs.
- [ ] Perform actual-browser accessibility/mobile/keyboard and disconnect checks.
- [ ] Enable a limited internal pilot only after documented acceptance.
```

The environment variables and limits are in `.env.example`, `lib/agent/config.ts`,
and the runbook. Model concurrency defaults to one. Context may be 4096 or 8192
after qualification; output is capped at 512 tokens per decision. `SINGLE_PROCESS`
is an explicit operator assertion, not automatic replica detection.

Real-model commands require securely exported configuration:

```bash
npm run agent:smoke
CONFIGIQ_AGENT_LIVE_EVALS=true npm test -- tests/agent-evals/live.test.ts
```

The live suite runs real Qwen against **fake sizing tools**. It contains twenty
fully specified cases with approval continuation and thirty ambiguity/security
cases, repeated three times. It is not proof of live SDK fidelity, comprehensive
multi-turn quality, or GPU capacity. Record rates and investigate failures; do
not count skipped tests as passing gates or loosen safety limits to hide failures.

## 6. Further review opportunities

- Review whether cumulative messages/observations fit 4K before deciding that
  8K is required; preserve complete tool-call/result pairs and canonical state.
- Improve classified timeout/queue errors and collect prompt/token-budget metrics
  without logging prompts, credentials, or private reasoning.
- Consider moving generic transport/config helpers out of `lib/agent` if the new
  `lib/api/catalog.ts`/`estimate.ts` clients are reused more broadly; currently
  those new clients depend on agent HTTP/error helpers.
- Validate shared source-of-truth extraction from existing proxy routes rather
  than letting duplicate catalog/estimate transport behavior diverge over time.
- Review memory/tool parameter defaults and visible assumptions carefully.
- Add a full browser test of draft hydration in `AdvancedEstimate`, not just
  storage validation plus context payload preservation.
- Ensure the production ingress overwrites the configured client-IP header and
  imposes connection limits; do not trust arbitrary forwarded client headers.
- Keep an independently observable model readiness check without making the
  standard ConfigIQ health endpoint fail when the assistant is unavailable.

These are review items, not claims that all represent observed production bugs.
Pricing, retrieval/vector storage, arbitrary MCP discovery, uploads/vision,
infrastructure automation, durable histories, and multi-replica support remain
out of scope unless explicitly approved.

## 7. Working-tree and environment safety

No implementation commit exists. Nothing was staged or pushed. Base commit seen
in build metadata was `b460e22`; the implementation consists of tracked edits
plus many untracked feature files. Run `git status` first and preserve all work.

Pre-existing user work: `.gitignore`, `CLAUDE.md`, `next.config.js`, local-dev
`tsconfig.json` include, `.codegraph/`, `.rtk/`, `docs/LOCAL_COST_DEVELOPMENT.md`,
`scripts/dev-local.sh`, and `self-hosted-llm-cost-calculator/`. Do not stage all
untracked files or reset these paths. The new feature inventory is in the record.

Do not read or publish `.env.local` secrets unnecessarily. No serving key was
provided in these docs. Placeholders in `.env.example` are not working credentials.
The build's metadata refresh is expected; user settings must remain intact.

Tool commands in the previous session were filtered by RTK. For full build logs,
`rtk proxy npm run build` was useful. The local `.rtk/filters.toml` was reported
untrusted; it was not trusted or enabled. Do not blindly trust local tool filters.

## 8. Copyable continuation prompt

```markdown
Continue the existing ConfigIQ sizing agent implementation; do not start over.

Read AGENTS.md, docs/agent-implementation-record.md,
docs/agent-continuation-handoff.md, and docs/agent-runbook.md first.
Inspect git status and preserve pre-existing user changes and untracked material.

Estimate response validation and exact upstream-payload provenance have been
fixed and regression-tested. Do not redo them or weaken the new contracts.
Next capture real gateway fixtures, qualify unsupported capabilities, and improve
live contract coverage, per-field provenance, and upstream trace correlation.
Compare the service contract and existing lib/api/estimate-adapter.ts before
changing mappings. Do not add GPU formulas.
Keep explicit scenario approval, bounded tools, server-owned evidence, cancellation,
same-origin protection, and disabled-by-default/single-process gates intact.

Run tests, lint, type-check, and a production build/integration smoke test.
Use the documented isolated build directory if another Next server is running.
Remove only build-generated TypeScript includes, retaining the user's local-dev
include. Do not stop unrelated processes or commit unless explicitly requested.

Real Qwen/L4 qualification is still outstanding. Do not claim deployment readiness
from fake-model tests. Qualify the pinned checkpoint/runtime, tokenization/tool
parser, quality fixtures, actual gateway parity, and mixed-load resource limits
before enabling an internal pilot. Update the record and runbook with exact evidence.
```
