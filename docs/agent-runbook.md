# Sizing agent implementation and operator runbook

Current work inventory and verification evidence: [Implementation record](agent-implementation-record.md).
Next-model instructions and known gaps: [Continuation handoff](agent-continuation-handoff.md).

The application implementation is available at `/assistant`. It is **off by
default**. The feature must remain off on a public deployment until the real Qwen
runtime and L4 have passed qualification. No model weights or new dependencies
are installed by this change.

Design: [Agentic sizing plan](chatbot-sizing-plan.md). Original implementation
breakdown: [Handoff](chatbot-sizing-handoff.md). This runbook records the current
implementation rather than treating the original proposed file map as literal.

## Implemented

- Single, bounded observe/act/revise controller in `lib/agent/controller.ts`.
- Native Qwen tool calls over a private OpenAI-compatible vLLM endpoint, with
  server-side `/tokenize` accounting for messages and tool definitions.
- Catalog discovery, controlled public Hugging Face config resolution, explicit
  scenario proposals/approval, recommendation, fixed-configuration performance,
  memory inspection, comparisons, and deterministic evidence summaries.
- Reuse of `callRecommend` and `callKvCacheCalc`, with optional cancellation and
  raw-response validation for agent callers. Existing callers retain their API.
- Strict aggregate estimate timing/envelope/scope validation. Nonzero cached
  prefixes are explicitly unsupported for fixed estimates; use recommendation.
- Versioned safe receipt provenance with exact wire-payload hashes, model-config
  digests, normalized memory defaults, and preserved failed-attempt metadata.
  Capture happens at dispatch and is not a remote delivery/execution acknowledgement.
- Same-origin, server-owned sessions, expiring approval proposals, revision checks,
  bounded queues, rate limits, byte limits, idempotency, cancellation, and SSE.
- PatternFly conversation, editable scenario, approval, progress, result cards,
  raw input inspection, and draft transfer into Recommend. An imported draft
  preserves request-rate/concurrency mode, backend/version, and SLA; it does not
  calculate until the user chooses Calculate.
- Deterministic unit/route/component tests, a production-route integration script,
  a real-model smoke script, and 50 opt-in model-evaluation fixtures repeated three
  times (20 fully specified workloads and 30 ambiguity/security cases).

Policy and tool permissions are implemented in the controller and tool registry;
there is no separate `policy.ts`. Streaming/session handlers are shared in
`lib/agent/routes.ts`. Tools are in `lib/agent/tools.ts`, not separate microservices.
The feature does not add a persistent store, agent framework, MCP client, vector
database, authentication provider, or GPU sizing formulas.

## Conservative differences from the design baseline

- Every new or edited scenario requires an explicit approval click, including
  complete initial requests. User text invalidates previous authorization.
- Exactly one complete model tool call is accepted per decision. Multiple calls
  are rejected and allowed one format repair, not dispatched speculatively.
- No automatic transient sizing retries. The agent can inspect the failure and
  try a different approved candidate; repeated identical calls reuse their result.
- Existing zero-defaulted optional metrics are conservatively marked unavailable.
  Agent raw validators prevent absent topology/memory fields being certified.
- Ephemeral sessions allow at most 64 turns; idempotency records are not evicted
  during the live session. The user can start a new conversation at that limit.
- Image/video upload, gated-model credentials, pricing, retrieval, and MCP remain
  out of scope. Public model configuration redirects are restricted to the
  requested repository on `huggingface.co`; remote model code is never executed.
- The UI streams trusted progress and verified artifacts, not unverified answer
  tokens. Numeric results are rendered from service evidence.

## Configuration

Use the placeholders in `.env.example`. Keep real keys in the deployment's secret
mechanism; never put them in `NEXT_PUBLIC_*` variables, URLs, browser storage, or
commits. Development can use the existing `.env.local`.

| Setting | Meaning |
| --- | --- |
| `CONFIGIQ_AGENT_ENABLED` | Must be exactly `true` to expose active agent APIs; default off |
| `CONFIGIQ_AGENT_SINGLE_PROCESS` | Must be `true` only after verifying one long-lived serving Node process |
| `CONFIGIQ_AGENT_ORIGIN` | Exact external application origin used for origin checks and secure cookies |
| `CONFIGIQ_AGENT_MODEL_BASE_URL` | Private vLLM base, normally `http://model-service:8000/v1` |
| `CONFIGIQ_AGENT_MODEL_ID` | Served model ID; default `Qwen/Qwen3-VL-8B-Instruct-FP8` |
| `CONFIGIQ_AGENT_MODEL_REVISION` | Optional operator-declared deployed revision for receipts; does not pin/download/verify the running server |
| `CONFIGIQ_AGENT_MODEL_API_KEY` | Required private inference-server API key |
| `CONFIGIQ_AGENT_CONTEXT_TOKENS` | 4096 initially; 8192 only after qualification; includes output reserve |
| `CONFIGIQ_AGENT_MODEL_CONCURRENCY` | 1 initially; 2 only after qualification; restart app when changing |
| `CONFIGIQ_AGENT_CLIENT_IP_HEADER` | Optional trusted ingress-overwritten client IP header, such as `x-real-ip` |
| `AISIMULATORS_GATEWAY_URL` | Existing server-side simulator gateway; no public fallback |
| `AISIMULATORS_TIMEOUT_SECONDS` | Existing validated timeout; defaults to 90 seconds |

In production use HTTPS for the application origin. The session cookie is
HttpOnly, SameSite Strict, scoped to `/api/agent`, and Secure on HTTPS. Mutating
requests require the configured Origin. GET responses are private/no-store and
cross-site browser requests are rejected. All routes enforce the feature flag.

The app has global admission/rate limits even without trusted client IP metadata.
For a public rollout, add ingress connection and per-client limits. Only configure
the optional IP header if the proxy strips client-supplied values and overwrites
it: trusting an arbitrary forwarded header is not safe. Session creation is capped
at 20/minute globally, requests at 300/minute globally, turns at 12/minute/session,
and trusted-IP requests at 60/minute when enabled. Tune only with load evidence.

## Runtime and retention

Exactly one long-lived Node process is supported. The session store, rate limiter,
and admission semaphores live in versioned `globalThis` slots so Next route bundles
share them in that process. Run the production integration check below to verify
this with the built app. Multiple instances, serverless workers, and rolling
overlap with sticky-session assumptions are not supported by this store.

Sessions expire after 30 minutes idle or a process restart. Cookies renew on
successful state/run requests. There are at most 500 sessions and 256 KiB of
public state/model configs per session. Ten recent user-visible messages are
retained; model context includes the latest four and two complete tool exchanges
plus canonical scenario/evidence. If the tokenizer reports overflow, the run
fails closed with guidance to shorten it; approved constraints are never silently
truncated. Conversation content and private reasoning are not logged.

Run limits: 180 seconds including queue wait; 15-second admission wait; 8 model
calls; 12 tools; 4 expensive sizing attempts; 512 output tokens/call and 4096/run;
3 GPU candidates; 4 active runs and 8 queued globally; 2 concurrent sizing calls;
one active run per session. Model calls time out after 30 seconds. Body reads
time out after 10 seconds. Oversized/invalid inputs are rejected before execution.

Cancellation aborts downstream HTTP requests, prevents subsequent tools and late
result publication, and releases local permits. It cannot prove that an upstream
simulator stopped computation after disconnect. Verify that behavior on the host
and add gateway-side admission limits if upstream cancellation is not cooperative.

## Model qualification: required before activation

Candidate: `Qwen/Qwen3-VL-8B-Instruct-FP8`.
Reviewed weight revision: `9cdc6310a8cb770ce18efaf4e9935334512aee45`.
See the design's dated official-source links and model-selection rationale.

1. On the actual machine, record L4 driver/CUDA, available/used VRAM, other GPU
   processes, host CPU/RAM/disk, container runtime, and the direct-sizing baseline.
2. Select and pin a stable vLLM image **by digest**, not `latest`; recheck its
   Qwen3-VL and fine-grained FP8 kernel support. Pin the reviewed weights revision
   and tokenizer/template. No image digest has been hardware-qualified here.
3. Begin with tensor parallelism 1, 4096 total context, one active sequence, and
   both image/video limits zero. Keep measured device headroom of at least 2 GiB,
   more if co-resident workloads require it. Do not use the advertised 256K context.
4. Qualify native automatic tool choice using the bundled template and the
   candidate `hermes` parser. The checkpoint uses JSON-in-tool-call tags; do not
   copy the Qwen3-Coder parser or Qwen3 thinking switches blindly.
5. Expose private authenticated `/v1/chat/completions` and `/tokenize`; allow only
   the app host/network. Validate that tokenization includes tools. Provision an
   operator-only readiness probe against vLLM `/health`. Do not add model readiness
   as a dependency of ConfigIQ's existing application health endpoint.
6. Run the smoke and evaluation commands below, then a one-hour mixed-load soak
   at 4K/one sequence. Evaluate 8K/two sequences only after the smaller profile
   passes. Record warm/cold p50/p95 latency, GPU memory, OOM/restart count, queue
   depth, and direct-sizing latency. Follow the design's quality/headroom/SLA gates.
7. The live evaluation suite uses real Qwen with **fixture sizing evidence**. It
   tests policy/extraction/tool use, not simulator fidelity or real GPU performance.
   Add host-specific real-gateway acceptance scenarios and verify results against
   the existing sizing UI before enabling a pilot.

The development environment used for this implementation did not provide
`nvidia-smi` or a configured Qwen server. Hardware fit, parser quality, model
latency, and sustained-load qualification are **not claimed** by application tests.

## Commands

Standard offline checks:

```bash
npm test
npm run lint
npm run type-check
npm run build
npm run test:agent:server
```

`test:agent:server` starts the built Next app on a temporary loopback port with
local fake model/simulator servers, checks session sharing across route bundles,
approval, SSE, evidence, cancellation/reset boundaries, strict estimate failure
rejection, memory success, exact payload provenance, and stops the processes.
It does not modify production services or make a real inference request.

Explicit real-model checks, after securely exporting configuration:

```bash
npm run agent:smoke
CONFIGIQ_AGENT_LIVE_EVALS=true npm test -- tests/agent-evals/live.test.ts
```

The smoke script calls the private model endpoint, validates token counts, named
and automatic tool calls, and tool-result continuation. It never executes model
generated actions. Live evaluations are skipped by default; a skipped suite is
not a passed model-quality gate. The opt-in suite uses stricter per-case assertions
than the aggregate design thresholds; investigate each failure and record the
aggregate extraction/completion rates rather than masking failures with retries.

## Streaming ingress and rollout

Locate the actual deployment repository (`configiq-deploy` is referenced by the
existing timeout helper). Do not invent a second deployment system here. Disable
response buffering and compression that buffers SSE, allow the bounded 180-second
run plus transport overhead, and permit ten-second heartbeat frames to flush.
Set upstream connection timeouts conservatively and test disconnect propagation.

Enable first for an internal pilot only after qualification. Record image/model
pins, prompt bundle version (currently v2), receipt contract version (v2), environment, benchmark results,
and operator sign-off. Watch `configiq.agent.run` metadata logs (run ID, status,
duration, invocation counts) plus model/GPU metrics. Logs contain no raw chat.

Rollback: disable `CONFIGIQ_AGENT_ENABLED` and restart the single application
process to clear sessions/runs; stop the model container if needed. Confirm
Recommend, Performance, Memory, and ordinary app health still work. Browser
conversation state will expire/reset. An independent model failure must not make
the rest of ConfigIQ unhealthy.
