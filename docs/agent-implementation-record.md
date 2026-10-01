# Agent implementation record

Recorded: 2026-10-01.

**State:** substantial application implementation exists and passes the offline
suite and a built-server integration test. It is **not production-qualified**.
The real Qwen model, actual AISimulators deployment, and L4 capacity/quality gates
have not been exercised in this environment. The feature defaults to disabled.

Use [Continuation handoff](agent-continuation-handoff.md) for the ordered next
steps and known gaps. Use [Operator runbook](agent-runbook.md) for configuration.
The [design](chatbot-sizing-plan.md) and [original handoff](chatbot-sizing-handoff.md)
describe the baseline intent, not proof that every planned feature is complete.

## 1. Requested capability and implemented approach

The user asked for an agentic ConfigIQ sizing experience based on the latest
suitable Qwen 8B model, hosted alongside ConfigIQ on an L4 machine.

The selected candidate is `Qwen/Qwen3-VL-8B-Instruct-FP8`, using text input only.
Reviewed checkpoint revision: `9cdc6310a8cb770ce18efaf4e9935334512aee45`.
The research rationale distinguishes this general-purpose 8B-branded model from
newer specialized WebWorld/embedding/guard models. This selection is documented,
not a claim that the checkpoint has been loaded successfully on this L4.

Implemented architecture:

```text
PatternFly /assistant
  -> same-origin /api/agent session and run endpoints
  -> server-owned session + bounded agent controller
     -> private vLLM tokenizer/chat-completions endpoints
     -> validated tools -> AISimulators /catalog equivalents, /recommend,
                           /estimate, /memory
     -> controlled public Hugging Face config lookup when required
  -> deterministic evidence cards and comparison summary
  -> validated sessionStorage draft -> existing /recommend form
```

One model chooses its next action. Deterministic code controls allowed tools,
approval, argument validation, execution limits, receipts, and rendering. No new
agent framework or third-party dependency was installed. Sizing calculations stay
in AISimulators and the existing API normalization layer.

## 2. File inventory

### New runtime modules

| File | Implemented responsibility |
| --- | --- |
| `lib/agent/contracts.ts` | Strict scenario, turn, proposal, receipt, snapshot, event, handoff, and tool-argument schemas; sizing request projection |
| `lib/agent/config.ts` | Feature gate, required server configuration, limits, safe `AgentError`, URL validation |
| `lib/agent/http.ts` | Bounded streamed JSON reads, safe fetch wrapper, restricted Hugging Face configuration redirects |
| `lib/agent/limits.ts` | FIFO abortable semaphores and bounded rate limiter in process-global slots |
| `lib/agent/store.ts` | Ephemeral sessions, revisions, proposals, approvals, run idempotency, retention and size limits |
| `lib/agent/model-client.ts` | Tool JSON schemas, model wire contract, token-count preflight, one-call response parsing |
| `lib/agent/controller.ts` | Model-directed observe/act/revise loop, permissions, budgets, deduplication, evidence finalization, cancellation, metadata logs |
| `lib/agent/tools.ts` | Catalog/model resolution and validated sizing/memory/estimate execution |
| `lib/agent/evidence.ts` | Raw recommendation/memory validators, normalized metrics, topology and SLA checks, deterministic ranking |
| `lib/agent/provenance.ts` | Exact serialized-payload capture, public model-config digest/redaction, classified failed-attempt receipts |
| `lib/agent/routes.ts` | Shared session/run HTTP handlers, origin checks, cookies, limits, SSE, cancellation, safe errors |
| `lib/agent/client.ts` | Browser SSE decoding and one-use sizing-draft storage/validation |
| `lib/api/catalog.ts` | Server-side catalog client for model/system IDs |
| `lib/api/estimate.ts` | Constrained aggregate estimate client with required timing evidence, error-envelope/scope validation, and explicit cached-prefix rejection |

### New routes and interface

| File | Responsibility |
| --- | --- |
| `app/assistant/page.tsx` | Dynamic server page; disabled-state fallback when the flag is off |
| `app/api/agent/session/route.ts` | Node runtime session GET/POST/DELETE |
| `app/api/agent/runs/route.ts` | Node runtime streamed run POST, 190-second framework duration hint |
| `app/api/agent/runs/[runId]/route.ts` | Owned run GET/DELETE |
| `components/assistant/Assistant.tsx` | Conversation, progress, cancellation, proposal approval, evidence, draft handoff |
| `components/assistant/ScenarioEditor.tsx` | Editable model/systems/backend/tokens/SLA/load/objective, validation, dirty-state notification |
| `components/assistant/Assistant.module.css` | Responsive layout, Red Hat fonts, readable text, numeric alignment, reduced motion |

### Existing files changed by this implementation

- `.env.example`: disabled-by-default agent settings and documented placeholders.
- `components/layout/AppShell.tsx`: “Ask ConfigIQ” navigation entry.
- `app/recommend/AdvancedEstimate.tsx`: assistant entry link, validated one-use
  draft import, backend/version preservation, explicit request-rate versus
  concurrency selection. Import never calculates automatically.
- `contexts/RecommendContext.tsx`: accepts and forwards `backend_version`.
- `lib/api/recommend.ts` and `lib/api/kv-cache-calc.ts`: backward-compatible optional
  caller abort signal, raw-response validation hook, bounded-response reader,
  and exact serialized-request observation. Agent calls supply all four;
  existing callers retain normal behavior.
- `package.json`: adds `test:agent:server` and `agent:smoke` commands. No dependency
  versions changed; no lockfile update was needed.

The isolated build temporarily reformatted `tsconfig.json` and added
`build/types/**/*.ts`; that temporary change was removed. Its pre-existing
`.next-dev-local/types/**/*.ts` include was retained.

### Tests and operator assets added

- `lib/agent/__tests__/fixtures.ts`
- `lib/agent/__tests__/core.test.ts`
- `lib/agent/__tests__/controller.test.ts`
- `lib/agent/__tests__/transport.test.ts`
- `lib/agent/__tests__/routes.test.ts`
- `lib/agent/__tests__/client.test.ts`
- `lib/api/__tests__/estimate.test.ts`
- `components/assistant/Assistant.test.tsx`
- `contexts/RecommendContext.agent.test.tsx`
- `tests/agent-evals/cases.ts`
- `tests/agent-evals/live.test.ts`
- `scripts/test-agent-server.mjs`
- `scripts/agent-model-smoke.mjs`

### Documentation added or updated

- `docs/chatbot-sizing-plan.md`: design baseline and model research.
- `docs/chatbot-sizing-handoff.md`: original implementation breakdown, now marked
  as historical relative to the implemented application.
- `docs/agent-runbook.md`: configuration, limits, qualification, tests, rollback.
- `docs/agent-implementation-record.md`: this implementation inventory.
- `docs/agent-continuation-handoff.md`: current continuation instructions.

`scripts/sweep_agentic_concurrency.py` and `docs/agentic-concurrency-sweep/` already
existed; they are not new chatbot implementation artifacts.

## 3. Implemented behavior

### Conversation and approvals

The model can discover catalog IDs, resolve a public model configuration, ask
questions, or propose a complete scenario. Every proposal requires an explicit
approval click before sizing, even when the initial user request is complete.

A proposal binds an expiring UUID to the current scenario revision and candidate
scope. Neither a model argument nor client-supplied tool history can approve it.
New text invalidates prior authorization. New proposals clear old receipts and
increment the scenario revision. Editing form fields disables approval until the
edits are saved and reviewed, preventing approval of older server values while
different values are visible in the form.

Scenario fields cover model, at most three unique systems, backend/version,
input/output tokens, TTFT/TPOT, optional E2E latency, cached prefix, exactly one
load target, and a comparison objective. Objectives are satisfy constraints,
minimize GPU count, and minimize TTFT. No cost objective is implemented.

### Agent tools

Available before approval: `search_catalog`, `resolve_model`, `propose_scenario`,
and `ask_user`. Approved runs can recommend, estimate, inspect memory, compare
current receipt IDs, finish, or ask a question. Tools are state-allowlisted and
strictly parsed before execution. Runtime execution validates approval/scope again.

The agent accepts exactly one complete native function call per model decision.
It does not execute tool-looking text, partial arguments, generated code, shell
commands, browser automation, arbitrary URLs, or discovered MCP tools.

### Evidence and results

Recommendation and memory responses receive additional raw validation before
normalization. GPU topology checks include total/replica consistency and required
prefill/decode phases for disaggregated layouts. Phase worker/GPU/TP/PP metrics are
included in evidence. Missing optional positive metrics are displayed as
unavailable rather than replaced with measured zeros.

Fixed estimates now require finite positive TTFT and TPOT, reject failure/error
envelopes even at HTTP 200, and reject non-aggregate or mismatched system/backend/
parallelism responses. Nonzero cached-prefix inputs fail explicitly before any
estimate request; zero prefix is omitted from the wire request because the current
service `EstimateRequest` does not define it. Missing load-capacity metrics remain
unavailable and cannot be replaced with the requested target or batch size.

Real sizing-tool receipts now include provenance contract version 2 and prompt
bundle version 2. Adapters capture a detached copy of their exact serialized wire
payload, including normalized defaults, before dispatch. The full payload is
SHA-256 hashed; public inputs omit `model_config`, retaining only its digest.
Failed upstream attempts retain the same safe payload provenance and no successful
metrics. Unsent attempts are explicitly marked with `payloadCaptured: false` and
`inputHashSource: tool_arguments`, not mislabeled as wire evidence. Adapter-created
request IDs are labeled `configiq_adapter`; no upstream correlation is claimed.
The serving model ID and optional operator-declared revision are recorded, not
verified against a running model server. Older/test receipts may omit provenance.
Payload capture proves what the adapter prepared at dispatch, not that a remote
gateway received or executed a request; the local integration fixture verifies
received-payload parity separately. No delivery acknowledgement is inferred.

Latency/load predicates are deterministic and three-state: yes, no, unknown.
Ranking considers only successful current recommendations with verified
constraints. A tied GPU count can be broken by TTFT only when the tied values
are available. Rankings explicitly apply to successfully evaluated candidates;
fewer GPUs of different types does not imply lower cost.

Results and numeric sentences come from evidence, not model-generated numbers.
Model-visible questions and proposed assumptions are still model text, rendered
escaped and labeled for review. The model is not a verifier for its own results.

### HTTP, retention, and resource controls

- Exact configured Origin for mutations, same-site cookie, no wildcard CORS,
  private/no-store responses, session-owned run lookups and cancellation.
- 30-minute idle sessions, ten recent visible messages, 64 turn/idempotency
  records maximum, 500 sessions globally, 256 KiB/session state/config cap.
- 32 KiB request cap, 16 KiB user-message byte cap, ten-second body-read deadline.
- Bounded upstream JSON bodies: recommendation/memory 256 KiB, model completions
  64 KiB, tokenizer 128 KiB, catalog endpoint responses 2 MiB, HF config 32 KiB.
- 180-second run, 15-second admission wait, 30-second model call, existing
  simulator timeout (90-second default), all constrained by run cancellation.
- Eight model decisions, twelve tool calls, four expensive sizing attempts,
  512 output tokens/decision, 4096 output tokens/run.
- Four active runs/eight queued; two global sizing calls; one or two model calls
  depending on the validated setting (one by default); one active run/session.
- One format repair; repeated identical calls are deduplicated. No automatic
  transient sizing retries. Queue permits release on failure/cancellation.
- Idempotency keys prevent duplicated work and reject changed payload reuse.
- Disconnect or DELETE aborts requests and prevents late-result publication.
  Actual upstream compute cancellation remains a deployment verification item.

## 4. Verification evidence

Latest offline suite result after the continuation hardening pass:

| Check | Observed outcome |
| --- | --- |
| `npm test` | 296 passed, 150 skipped; 17 test files passed and one live suite skipped |
| `npm run lint` | Completed; two pre-existing warnings, no new lint errors |
| `npm run type-check` | Passed, including after the final isolated production build |
| Production build | Passed using isolated `CONFIGIQ_DEV_DIST_DIR=build` and telemetry disabled |
| Built-server integration | Passed against the isolated final build, including cancellation |
| Real-model smoke | Not run: no configured Qwen endpoint available |
| Live model evaluations | Skipped intentionally: 50 fixtures x three repetitions |
| L4 inventory/soak | Not run: `nvidia-smi` was unavailable in this environment |

Exact final successful build/integration commands:

```bash
CONFIGIQ_DEV_DIST_DIR=build NEXT_TELEMETRY_DISABLED=1 npm run build
CONFIGIQ_DEV_DIST_DIR=build NEXT_TELEMETRY_DISABLED=1 npm run test:agent:server
npm run type-check
```

Ordinary builds passed earlier, but subsequent default-directory attempts timed
out. The final isolated build completed after transient Google Fonts retries.
Do not claim a confirmed root cause for the stalls. Another Next development
server was running and was deliberately not stopped. `build/` is already ignored.
Next may add that output directory's type include when rebuilding there.

The build script updates auto-generated metadata in ignored `.env.local` and
prints a nonfatal missing-Git-tag message in this checkout. It was not used to
change secrets or agent configuration.

Existing lint warnings are the missing `ref` dependency in
`app/cluster-cost/page.tsx` and the font warning in `app/layout.tsx`.

The production script starts a built Next server and fake model/simulator HTTP
servers on temporary loopback ports. It proves cross-route session sharing,
proposal/approval separation, no sizing before approval, SSE completion, receipt
rendering data, owned run lookup, cancellation, session reset, invalid/failed
HTTP-200 estimate rejection, successful estimate/memory evidence, and exact
receipt hash/input parity with received wire payloads. **It does not
prove real Qwen quality, real SDK contracts, or real hardware performance.**

## 5. Known unfinished work and review findings

1. **Estimate response-validation gap: fixed.**
   Empty/unrelated responses, missing timings, invalid values, failure envelopes,
   unsupported modes, and mismatched configuration are rejected. The initial
   regression suite reproduced 18 failures before the fix and now passes.
2. **Estimate support is narrower than the existing Performance adapter.**
   `lib/api/estimate-adapter.ts` supports MoE parameters, disaggregated pools,
   and `include=config,memory`. The new agent client does not. It also expects
   certain flat metrics that a deployed gateway may omit. Prefix limitations are
   explicit; MoE dimension/disaggregated inputs are not exposed. Current tests use
   source-contract fixtures, not captures from a live gateway. Capture real response
   fixtures and qualify supported capabilities. Do not copy
   legacy client-side sizing formulas as a fallback.
3. **Receipt provenance: core payload gap fixed; broader design work remains.**
   Successful and failed sent attempts hash their actual serialized upstream
   payload, including memory defaults, with safe public inputs and explicit
   contract/prompt versions and ID scope. Live checkpoint revision verification,
   upstream trace correlation, and a full per-field scenario provenance map remain
   outstanding. Operator-declared model revisions are not deployment proof.
4. **Real model compatibility/quality is unverified.**
   The Hermes parser, tokenizer endpoint with tools, bundled template, FP8
   kernels, context fit, and instruction-following need the opt-in checks on the
   actual server. The 4K budget may be tight for lengthy tool observations.
5. **L4 deployment is not performed.** No serving image digest was qualified,
   model downloaded, GPU capacity measured, reverse proxy changed, or internal
   pilot enabled. The separate deployment repository was not available.
6. **Single-process state remains a hard limitation.** The environment switch
   acknowledges this requirement; it does not detect an accidental second replica.
   Restarts lose conversations. Scaling requires a separately designed shared store.
7. **Broader acceptance coverage remains.** Happy DOM tests are not a real-browser
   keyboard/screen-reader/mobile audit; fixture servers are not live AISimulators
   integration; the live fixture set is a starting quality gate, not a complete
   suite of realistic multi-turn operational tasks.

None of these gaps should be represented as completed hardware/production gates.

## 6. Working-tree ownership

No changes were staged, committed, or pushed. The code and documents remain in
the working tree, with many new files untracked. Base commit observed during
builds: `b460e22` (not an implementation commit).

Pre-existing changes that must be preserved include `.gitignore`, the `CLAUDE.md`
type/content change, `next.config.js`, and the local-dev include in `tsconfig.json`.
Pre-existing untracked material includes `.codegraph/`, `.rtk/`,
`docs/LOCAL_COST_DEVELOPMENT.md`, `scripts/dev-local.sh`, and
`self-hosted-llm-cost-calculator/`. Recheck current status rather than assuming
all untracked files belong to this agent feature. Do not use a broad reset or
stage everything indiscriminately.
