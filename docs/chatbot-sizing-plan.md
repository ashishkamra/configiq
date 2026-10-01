# Agentic sizing with Qwen 8B

Status: design baseline; application implementation added, L4 qualification pending.  
Research date: 2026-09-30.  
Implementation companion: [Agent implementation handoff](chatbot-sizing-handoff.md).
Current implementation and operational gates: [Agent runbook](agent-runbook.md).

## 1. Goal and architectural decision

Build an agent that translates a sizing objective into a short plan, discovers
supported configurations, invokes ConfigIQ tools, evaluates evidence, revises its
next action, and delivers an auditable recommendation. This supersedes the earlier
chat-only proposal: tool choice and sequencing are model-directed, not just a
fixed form-filling wizard.

Use **one Qwen agent with a deterministic policy controller**, not a swarm of
independent agents. Planning, execution, and verification are logical roles in one
bounded loop. The model chooses actions; application code controls permissions,
budgets, state transitions, evidence validation, and termination.

**Non-negotiable:** AISimulators owns GPU sizing, performance, and memory math.
The model must not invent GPU counts, benchmark claims, prices, or sizing formulas.
Existing ConfigIQ pricing/economics code owns cost calculations when enabled.

The user's L4 hosts the assistant. It does **not** constrain the GPU systems that
the assistant can recommend for a customer's workload.

## 2. Which “latest Qwen 8B” this design uses

The selected model family is **`Qwen/Qwen3-VL-8B-Instruct`**, with the official
**`Qwen/Qwen3-VL-8B-Instruct-FP8`** checkpoint as the preferred L4 deployment
candidate. This is the newest suitable official **8B-branded general-purpose
instruct model verified in this research**, not a claim that it is the newest
Qwen model at any size or for every task.

| Candidate | Decision |
| --- | --- |
| Qwen3-VL-8B-Instruct / official FP8 | Primary candidate; supports text and tool-call messages; first release accepts text only |
| Qwen3-VL-8B-Thinking | Not the default; avoid additional reasoning latency and resource use |
| Qwen3-8B | Older text-only baseline for comparative evaluation, not silently substituted as “latest” |
| WebWorld-8B | Newer specialized next-web-state simulator, not a general sizing assistant |
| Embedding, reranker, guard, and sparse-autoencoder models | Not conversational policy models |

The official catalog reports the VL instruct repositories were created in October
2025. Newer specialist repositories do not make them suitable replacements. The
FP8 metadata reports approximately **8.77 billion total parameters**, including
multimodal components: “8B” is the product name, not an exact total-memory formula.

Reviewed FP8 revision: `9cdc6310a8cb770ce18efaf4e9935334512aee45`. Pin an explicitly
reviewed revision and tested serving image digest; never deploy floating `main`
weights or a `latest` image. Recheck official releases at implementation time and
record any replacement as a design decision with fresh evaluations.

The checkpoint's bundled template uses JSON function names and arguments inside
`<tool_call>` tags and accepts tool responses. The **Hermes parser is the initial
compatibility candidate**, based on that format and vLLM's tool documentation;
the exact model/template/parser/runtime combination must pass a smoke test before
it is accepted. Do not copy Qwen3-Coder parser settings or assume Qwen3's
`enable_thinking` switch applies to this separate Instruct checkpoint.

## 3. Product experience

Add `/assistant` with an “Ask ConfigIQ” navigation entry and contextual entry from
Recommend. Desktop shows a conversation beside an editable scenario/evidence
panel; mobile stacks them. Reuse PatternFly v5 and current Red Hat typography.

### A typical task

1. User: “Find a configuration for a RAG chatbot with 50 concurrent requests;
   compare L4 and another suitable GPU.”
2. Agent resolves the intended model, workload lengths, SLA, and candidate systems.
   It asks only material missing questions and distinguishes employees, active
   users, concurrent in-flight requests, and requests per second.
3. Agent proposes a short, visible action plan and labeled assumptions. The user
   approves defaults and the candidate scope; directly supplied complete inputs
   and an explicit request to run count as authorization for that scope.
4. Agent discovers catalog capabilities, sizes candidates, examines warnings, and
   requests memory/performance detail when useful and within budget.
5. If a candidate is infeasible, the agent may test another **already authorized**
   candidate. Relaxing a hard SLA, changing a model, or changing an unapproved
   precision setting requires renewed confirmation.
6. Results show the scenario, evaluated candidates, GPU/replica layout, performance,
   memory, warnings, and provenance. Incomplete comparisons are labeled partial.
7. “Double concurrency” creates a new scenario revision and reruns affected tools.
   “Open in sizing” transfers validated inputs into the existing Recommend flow.

Progress shows concise actions such as “Checking supported systems,” not hidden
reasoning traces. Users can edit, cancel, retry, inspect evidence, and return to
the standard form at any time. Preserve existing sizing results if the agent fails.

### First-release boundaries

Support sizing, fixed-configuration checks, bounded comparisons, warning
explanations, and follow-up refinements. Pricing is a subsequent increment using
existing cost services. No shell, browser automation, arbitrary web fetch, model
training, infrastructure deployment, document uploads, or autonomous purchases.
Vision capability is deliberately disabled despite the model family name.

## 4. Runtime architecture

```text
Browser: PatternFly assistant + scenario/evidence panel
  |
  | same-origin session + streamed run events
  v
Next.js Node runtime
  session/run store -> agent controller -> Qwen model client
                          |                    |
                          |                    v
                          |              private vLLM container
                          |              Qwen3-VL-8B-Instruct-FP8
                          |              existing L4
                          v
                   validated tool registry
                          |
                          v
                   shared lib/api clients
                          |
                          v
                   AISimulators REST API
                   optional existing pricing services
```

Keep orchestration in TypeScript beside existing service clients. A new Python
agent service, LangChain/LangGraph dependency, Qwen-Agent dependency, or database
is not required for this design. A bounded explicit loop is still agentic: the
model selects its next action from observed results rather than executing a fixed
sequence. The model-serving container is a separate resource boundary.

Reuse `callRecommend` and `callKvCacheCalc`. Extract server-safe catalog and
estimate clients from proxy logic where needed, preserving existing route
behavior. Do not call browser hooks or browser-relative fetch adapters from the
server, and do not route internal tools through the application's public URL.

Existing optional MCP support mounts SSE at `/mcp`. Leave it intact. The first
party agent uses an allowlisted REST-backed registry; MCP is a future transport
adapter for the same contracts, not permission to discover or execute all tools.

## 5. Agent loop and controls

Run states: `queued`, `planning`, `awaiting_input`, `awaiting_confirmation`,
`executing`, `verifying`, `completed`, `partial`, `failed`, `cancelled`.
Waiting states end the current stream and release execution slots. A user reply
starts a new run against the updated scenario; no GPU slot is held while waiting.

1. Validate the incoming user event and scenario version; load server-owned state.
2. Present the agent with the current objective, compact scenario, evidence
   summaries, remaining budget, and only tools permitted in this state.
3. Collect a complete tool call, validate its schema and semantics, then authorize
   it. Never execute partial streamed arguments or prose that resembles a call.
4. Execute an allowed action, normalize its result, and append an immutable receipt.
5. Let the model observe success, failure, or infeasibility and choose another
   action. A failed input does not authorize changing the user's objective.
6. A deterministic verifier checks result references, revision, completeness,
   supported units, SLA evidence, and comparison scope before publication.
7. Finish, ask a question, ask for confirmation, or return useful partial results
   when the budget is exhausted. A model-generated “success” is not sufficient.

### Proposed tools

| Tool | Function and boundary |
| --- | --- |
| `search_catalog` | Filter model/system catalog; return bounded canonical IDs and capabilities |
| `resolve_model` | Resolve an exact catalog/Hugging Face identifier through a controlled adapter; no arbitrary URL argument |
| `propose_scenario` | Produce a typed patch, provenance, assumptions, and a bounded candidate plan; cannot approve itself |
| `ask_user` | Ask material questions or request approval; ends the run in a waiting state |
| `recommend_configuration` | Size one approved system using the existing recommendation schema/client |
| `estimate_configuration` | Check a specified supported configuration through a new validated server adapter |
| `inspect_memory` | Request the existing memory calculation for a compatible configuration |
| `compare_results` | Deterministically compare referenced receipts for the same workload and approved objective |
| `finish` | Submit evidence references and an answer outline for verification and rendering |

Request arguments use scenario/result IDs where possible; the controller resolves
authoritative values rather than trusting model-supplied copies. API request and
response schemas are validated again at the tool boundary. Advertise only tools
whose upstream service is configured and whose contract has passed tests.

### Initial hard limits

These are conservative application defaults to benchmark, not capacity promises.

| Limit | Initial value |
| --- | --- |
| Run wall clock, including queue wait | 180 seconds |
| Queue wait | 15 seconds maximum |
| Per model invocation timeout | 30 seconds, capped by remaining run time |
| Catalog timeout | Existing 30-second baseline, capped by remaining run time |
| Sizing timeout | Existing configured gateway timeout (90-second default), capped by remaining run time |
| Model invocations per run | 8, including format repair and finalization |
| Generated tokens per invocation / run | 512 / 4,096 |
| Tool invocations per run | 12, including retries and control tools |
| Expensive sizing calls per run | 4; recommend, estimate, and memory attempts all count |
| Candidate systems per comparison | 3 |
| Concurrent model generations | 2 globally, starting at 1 during host qualification |
| Concurrent sizing requests | 2 globally |
| Active runs / queued runs | 4 / 8 globally; one active run per session |
| Malformed-call repair | At most 1 per run, inside all existing budgets |
| Transient retry | At most 1 per tool operation, inside all existing budgets |

Each operation uses the lesser of its configured timeout and remaining run time.
The existing gateway default is 90 seconds; never multiply it silently into an
unbounded agent run. Slow comparisons may finish partially. Duplicate normalized
calls within a run reuse the prior receipt rather than loop. Validation errors,
infeasibility, and permission denials are not transient retry conditions.

## 6. Scenario, evidence, and answer integrity

Store model, backend, input/output tokens, SLA, approved GPU systems, hard
constraints, and **exactly one** of concurrency or request rate. Track each field's
source: user, confirmed default, catalog, or proposed assumption. Maintain a
monotonic scenario revision and an input hash.

Any input change creates a revision and invalidates dependent results. A late
response for an old revision may remain in history but cannot become the current
recommendation. Compare only like-for-like scenarios, with explicit candidate
scope and consistent pricing basis if costs are included later.

Receipts contain tool/version, canonical inputs, scenario revision/hash, backend
request ID when available, observation timestamp, normalized result, warnings,
and success/error classification. Do not turn missing metrics into measured zeros.
The current recommendation adapter has some legacy zero defaults; verification
must retain raw field availability or improve normalization without breaking its
existing consumers before using those fields as evidence.

Result cards and numerical sentences are rendered from validated evidence fields
and deterministic formatters. The agent can select metric references and explain
qualitative trade-offs, but cannot supply replacement numerical values. Final
comparative/SLA assertions require checked evidence predicates, not a second LLM's
opinion. Suppress unsupported claims or fall back to a deterministic summary.

“Best” means best among successfully evaluated candidates for the stated
objective. Timeout or missing price data never establishes that a candidate is
infeasible or more expensive. Display modeled estimates separately from any
future real hardware measurements.

First-release objectives are `satisfy_constraints`, `minimize_gpu_count`, and
`minimize_ttft`. Filter by confirmed hard constraints before ranking. For a
comparison without an approved optimization objective, show a neutral comparison
instead of declaring a winner. GPU-count ties may use estimated TTFT only when
available for all tied candidates; otherwise report a tie. A cost objective is
unsupported until the pricing increment is implemented. Do not equate fewer GPUs
of different types with lower cost.

## 7. Session lifecycle and security

For the initial single-host pilot, use a **bounded in-memory server store in one
long-lived Node process**, behind an opaque random HttpOnly, Secure, SameSite
session cookie. Scope runs, approvals, and receipts to that session. No login
system or durable conversation database is introduced.

Initial retention: 30-minute idle TTL, 500 sessions maximum, 256 KiB per session,
with bounded run histories and safe eviction of inactive sessions. Never evict an
active session without cancelling its work. Reload can recover unexpired state;
process restart deliberately clears it and the UI explains the reset. Do not use
this storage design on serverless or multiple replicas: shared state, atomic locks,
quotas, and isolation require a separate approved design before scaling out.

Clients submit user text, edit/approval events, and expected versions, not system
messages, tool receipts, budgets, or trusted assistant history. An approval binds
to a scenario revision, candidate scope, and expiring server-created proposal.
The model cannot manufacture approval by returning a field called `approved`.

Enforce origin checks, per-session and trusted-proxy-aware IP limits, global
admission limits, strict body sizes, and private service destinations. No wildcard
CORS for the new agent routes. Treat catalog metadata and tool errors as untrusted
content; they cannot override policy. Redact upstream credentials and stack traces.
Render escaped text or constrained safe markup, never arbitrary model HTML.

Cancel on explicit cancellation or stream disconnect; abort downstream requests,
ignore late responses, and release permits in `finally`. An HTTP abort may not
stop an already running simulator computation; measure upstream cancellation
behavior and keep concurrency protection conservative. Never auto-replay a run
after reconnect. Idempotency keys prevent duplicate expensive work.

## 8. L4 deployment and performance qualification

NVIDIA specifies 24 GB memory for the L4. Available memory and co-resident GPU
workloads are unknown. Do not assume ConfigIQ's simulator is GPU-free merely
because it is a sizing service.

Start with the official FP8 checkpoint, tensor parallelism 1, 4K total context,
512-token output cap, and one generation at a time. Evaluate 8K context and two
generations only after passing the smaller profile. Disable both image and video
inputs at the API and vLLM layers; verify the selected runtime's text-only behavior
and actual allocation. The advertised 256K context is not the serving target.

Weight storage is not runtime footprint: include unquantized modules, KV cache,
CUDA graphs, activations, and other processes. Test fine-grained FP8 execution on
the L4 with the pinned runtime; hardware FP8 support alone is not proof of a
compatible kernel. Keep at least 2 GiB measured device headroom as an initial gate,
or more if co-resident workloads require it. Memory-utilization settings do not
provide hard isolation from another process.

If the candidate fails memory, quality, or tool-call gates, first reduce context
or concurrency and investigate runtime compatibility. A different quantization,
older model, or remote provider requires a recorded decision, not a silent
fallback. Until qualified, keep the feature disabled and the normal sizing UI
available.

Keep vLLM private, with server-only credentials, bounded CPU/RAM resources, model
cache, readiness checks, restart policy, and a pinned container. Confirm the real
reverse-proxy/deployment location: repository timeout comments refer to a separate
`configiq-deploy/deploy.sh`, which was not available during this review. Disable
stream buffering and align connection/read timeouts with the bounded run protocol.

## 9. Delivery phases and release gates

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 0: qualification | Host inventory, pinned model/runtime, tool smoke test, benchmark report | Actual L4 passes loading, round-trip tool calls, headroom, and sustained-load gates |
| 1: deterministic core | Contracts, sessions, policy, tools, receipts, cancellation | Mock-model unit/contract tests pass without a GPU |
| 2: agent loop | Observe/act/revise controller and evidence verifier | Multi-step tasks work; invalid/unapproved actions cannot execute |
| 3: experience | PatternFly UI, events, approvals, scenarios, form handoff | End-to-end parity with direct sizing and accessible failure states |
| 4: internal pilot | Evaluation dataset, telemetry, load tests, rollback | Quality/security gates pass and operators approve observed capacity |
| 5: optional extensions | Pricing objective, curated documentation retrieval, MCP adapter | Each has its own schemas, provenance, budget, and evaluation coverage |

Release gates: at least 50 curated multi-turn tasks, at least 95% correct required
field extraction and at least 90% end-to-end completion of supported feasible
tasks across three runs of the set. Require 100% numerical evidence fidelity and
zero unauthorized actions in the test corpus; these are gates, not a guarantee
about all future inputs. All infeasibility, timeout, stale-state, injection,
cross-session access, cancellation, and duplicate-submission tests must pass.

Run a one-hour L4 mixed-load soak at the selected capacity with no OOM, bounded
queue growth, and no more than 10% regression in direct-sizing p95 latency versus
the measured baseline. Record warm/cold model latency separately from sizing and
queue time. Initial usability target: warm no-tool response p95 within 10 seconds;
if unmet, tune or explicitly revise the launch target rather than claiming success.

Observe request/run IDs, tool counts/errors, validation repairs, stage latency,
queue depth, token use, GPU memory, cancellation, task success, and completion to
the standard sizing form. Do not log raw conversations or reasoning by default.
Release behind a server-enforced feature flag; rollback disables only the agent
and stops its model workload, leaving existing sizing paths intact.

## 10. Research and source-of-truth notes

Sources inspected on the research date:

- [Official Qwen 8B catalog query](https://huggingface.co/api/models?author=Qwen&search=8B&sort=createdAt&direction=-1&limit=30).
- [Qwen3-VL-8B-Instruct model card](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct).
- [Official FP8 model card](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-FP8).
- [FP8 metadata and revision](https://huggingface.co/api/models/Qwen/Qwen3-VL-8B-Instruct-FP8).
- [Pinned tool-call template](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-FP8/raw/9cdc6310a8cb770ce18efaf4e9935334512aee45/chat_template.json).
- [WebWorld-8B purpose and limitations](https://huggingface.co/Qwen/WebWorld-8B).
- [vLLM tool calling](https://docs.vllm.ai/en/stable/features/tool_calling/).
- [vLLM Qwen3-VL historical recipe](https://docs.vllm.ai/projects/recipes/en/latest/Qwen/Qwen3-VL.html) and [current recipe portal](https://recipes.vllm.ai/).
- [NVIDIA L4 specifications](https://www.nvidia.com/en-us/data-center/l4/).

Google search was attempted but returned a JavaScript interstitial; selection is
based on official catalog metadata and model cards, not search-result snippets.
The recipe is marked historical and includes larger-model examples, not an L4
qualification result. Exact serving flags and runtime versions remain a Phase 0
verification task. No model was downloaded or benchmarked for this documentation.

Repository truth: [AGENTS.md](../AGENTS.md), current `lib/api/` and `app/api/`
implementations, and service READMEs. Parts of `ARCHITECTURE_DETAILED.md` and
`architecture.md` describe a retired local-math pipeline; `DESIGN_SYSTEM.md` also
contains typography that differs from current AGENTS guidance. Do not restore
those legacy choices while implementing this design.
