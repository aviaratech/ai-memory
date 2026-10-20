# Task workflow telemetry

Workflow telemetry records content-free observations supplied by a supported lifecycle hook or a cooperating producer. It answers which reported token subsets occur in a task and where reported retries, failures, blockers or corrections recur. It does not establish the cause of a failure, prove that a workflow change saved tokens, or independently accept an outcome.

These commands require a build containing migration `009_workflow_telemetry.sql`. Importing the existing `/ingestion` entry point does not provision or start a database. Applying migrations, installing or enabling hooks, and granting access to an operator database are separate deployment actions; ingestion never performs them automatically.

## Local commands

With an explicitly configured loopback `AI_MEMORY_DATABASE_URL` and the shipped migrations already applied:

```sh
ai-memory-mcp telemetry:ingest < synthetic-event.json
ai-memory-mcp telemetry:report --project 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' --task task-1 --days 7 --limit 20 --json
npm run health -w @aviaratech/ai-memory -- --workflow --project 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' --task task-1 --json
```

Both report commands use the same implementation. `health --workflow` returns before the legacy log, retrospective and transcript collectors. The default activity window is seven days with twenty groups per dimension; bounds are one to ninety days and one to one hundred groups. Activity is selected by ingestion time. A nullable supplied observation time is recorded separately; missing time cannot establish queue time, execution time or a stall.

Queries run in one read-only repeatable-read snapshot with a five-second server-side budget per query. Correlation uses retained explicit binding evidence from at most ninety days before the window end, separately from the activity window. The report exposes omitted groups, evidence IDs and outcome references. Its maximum serialized size is 256 KiB; `report_oversized` requests a smaller `--limit`, without returning a partial artifact.

## Strict event v1

The existing `/ingestion` export adds `ingestTelemetryEvent(input, { dbPool? })` and its event/result types. It accepts one plain JSON data object, at most 16 KiB UTF-8 and depth four. Unknown keys, Proxies, accessors, symbol properties, custom prototypes and non-enumerable producer properties are rejected before serialization; Proxy traps never execute. There is no generic payload, message, metadata or error field.

| Field | Type and bound |
| --- | --- |
| `schemaVersion`, `kind` | Exactly `1`; `host`, `usage`, `edge` or `correlation` |
| `producer`, `eventId` | Required machine identifier, at most 64 and 128 ASCII characters respectively |
| `source` | `codex-hook`, `claude-hook`, `openai-responses` or `producer` |
| `observedAt` | UTC ISO datetime ending in `Z`, or null; absent normalizes to null |
| `projectId` | `sha256:` followed by 64 lowercase hex digits, or null |
| `taskId`, `sessionId`, `turnId`, `responseId` | Opaque machine identifier of at most 128 characters, or null |
| `host`, `model` | `codex`, `claude-code` or null; separately, a supplied model identifier of at most 128 characters or null |
| `stage`, `toolCategory` | Machine slug of at most 64 characters, or null |
| `edge` | `stage`, `retry`, `failure`, `blocker`, `correction`, `accepted` or null |
| `attempt` | Safe integer from 1 to 9007199254740991, or null |
| `executionMs`, `queueMs` | Separately reported nonnegative safe integers, or null |
| `relatedEvent` | Strict `{producer,eventId}` for correction/accepted edges only, otherwise null |
| `evidenceIds` | At most eight distinct opaque machine identifiers, each at most 128 characters |
| `hostEvent` | `SessionStart`, `Stop`, `SessionEnd` or null |
| `dedupCoverage` | `producer-stable`, `host-turn` or `invocation-only`; cooperating producers default to `producer-stable` |
| `usage` | Strict supplied OpenAI usage object, or null; absent normalizes to null |

Machine identifiers allow only letters, digits, `_`, `.`, `:` and `-`. They must be content-free identifiers, never prompts, display text, paths, credentials or personal information. Project IDs hash the exact canonical existing project string using SHA-256 over UTF-8, without case changes or alias guessing. Hashes and opaque identifiers remain linkable, dictionary-testable metadata; they do not provide anonymity. Producers and operators are responsible for choosing identifiers and deciding which events to supply.

Subtype rules:

- A host event requires matching host/source and a lifecycle event, with no usage, edge or related-event claim.
- A usage event requires `source=openai-responses` and a stable `responseId`; usage may explicitly be null. Do not submit cumulative response snapshots as independent usage events.
- An edge requires `source=producer`, explicit project/task/stage/edge and at least one evidence ID. Correction and accepted edges require an explicit event reference.
- A correlation event requires `source=producer`, explicit project/task/host/session and at least one evidence ID. It carries no lifecycle, usage or edge claim.

For example, this synthetic producer reports an observed verification failure:

```json
{
  "schemaVersion": 1,
  "kind": "edge",
  "source": "producer",
  "producer": "example-runner",
  "eventId": "verification-failed-1",
  "projectId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "taskId": "task-1",
  "stage": "verify",
  "edge": "failure",
  "evidenceIds": ["synthetic-proof-1"]
}
```

## Sources and unknowns

| Source | Supplied observations | Unsupported or incomplete coverage |
| --- | --- | --- |
| Codex lifecycle hook | Documented event/session fields; Stop additionally supplies a turn ID | No provider usage totals, canonical project/task identity, model/effort, acceptance or execution/queue duration inferred |
| Claude Code lifecycle hook | Documented event/session fields; SessionStart may supply model | Stop has no replay-stable turn identity in this adapter; no usage totals, project/task identity, effort, acceptance or durations inferred |
| Cooperating OpenAI Responses caller | Explicit response ID, model/correlation fields and strict usage object | No network request, API key, account connection or response body is read; absent fields remain unknown |
| Cooperating producer | Explicit binding, stage/retry/failure/blocker/correction/accepted evidence and durations | Reported claims require source evidence and do not supply independent acceptance |

Other hosts have no lifecycle adapter in v1. Hooks accept at most 64 KiB, project only the listed safe fields and do not open `transcript_path`, inspect `cwd`, resolve a repository, read host history or use transcript size to estimate tokens. A task is never inferred from a session ID. A producer can explicitly bind a project/task to a host/session using a correlation event.

Codex Stop events with a valid session and turn ID get a deterministic event ID over host/session/turn. Absent observation time stays null so replay is identical. Other observations use fresh invocation IDs. Claude Stop observations therefore cannot establish deduplicated delivery counts or unique turns. Missing usage is null, including when a host omits the entire object; it is never measured zero.

## Token accounting

OpenAI usage accepts only nullable safe integer fields `input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` and `total_tokens`. Nested unknown fields are rejected. The redundant total is validated against input plus output when both are known and is not stored or added to totals.

Cached-read and cache-write counts are input subsets; reasoning is an output subset. The report derives non-read input as input minus cached-read only when both are known, and ordinary input as input minus cached-read minus cache-write only when all three are known with compatible accounting. Missing cache-write is not zero. Invalid subsets, unsafe sums and negative/fractional counts are rejected. Reasoning is never added to output again.

Every metric includes an exact decimal-string observed sum, observed sample count and missing sample count. A sum is null when there are no measured samples, and a measured zero remains `"0"`. Derived metrics have their own denominators rather than subtracting incompatible partial aggregates. The observed sums do not claim complete task usage.

Expected synthetic example, mirrored in the report fixtures: responses `(input=100,cached=80,written=10,output=20,reasoning=5)` and `(200,50,20,40,10)`, plus one missing-usage observation:

| Metric | Observed sum | Measured / missing samples |
| --- | --- | --- |
| Input | 300 | 2 / 1 |
| Cached-read input | 130 | 2 / 1 |
| Cache-write input | 30 | 2 / 1 |
| Non-read input | 170 | 2 / 1 |
| Ordinary input | 140 | 2 / 1 |
| Output | 60 | 2 / 1 |
| Reasoning output subset | 15 | 2 / 1 |

The synthetic workflow also reports two verification failures, one retry, one correction and one accepted reference, with separately supplied execution 30000 ms and queue 5000 ms. Replaying an event does not add a retry. A Stop event alone does not add an accepted outcome. Repeated-failure hypotheses cite evidence from that stage and attach only same-stage or related-stage resolved producer references; they do not promote lessons or recommend changes automatically.

## Replay, correlation, retention and failures

The database owns uniqueness of `(producer,eventId)`, comparing a fixed normalized fingerprint. An exact replay returns `duplicate`; changed content returns `conflict` without overwriting. A second unique usage-response index prevents a different producer/event identity from counting the same OpenAI response again.

Explicit retained correlation is evidence, not mutable authoritative session state. Conflicting host/session bindings stay ambiguous. Related outcome references resolve only against another edge in the same explicit project/task; out-of-order references may resolve on a later report. Foreign, missing, expired and self references cannot establish a resolved outcome. Bounded outcome-reference output and omission counts expose incomplete evidence.

Canonical memory-tool observations stay in `ai_tool_invocations`. The report matches the exact project digest and explicit, unambiguous reported-host/session binding; missing host/project identity cannot be guessed. It reads numeric/status/category fields and bounded opaque invocation IDs, without memory bodies, tool payloads or injected/used memory-ID lists. Continuity projection characters and actual omission observations are distinct from the stored pack size, token estimates and final global hook clipping. Historical uninstrumented projections remain unknown.

`AI_MEMORY_RETENTION_TELEMETRY_DAYS` controls both canonical and workflow observations, defaulting to ninety days. Workflow purge uses ingestion age and deterministic `(ingested_at,id)` batches. A future supplied observation timestamp cannot pin old rows. The report's ninety-day lookup horizon is a maximum search horizon, not a guarantee that evidence survived a shorter configured retention or a missing collection period.

Ingestion returns only `stored`, `duplicate`, `conflict`, a rejection with `invalid_event`, `unsupported_version`, `oversized`, `invalid_usage` or `invalid_correlation`, or `unavailable` with `storage_unavailable`. It never returns raw validation/database errors or input. Caller-supplied pools remain caller-owned; an internally created max-one pool is closed by ingestion. Hook connection/statement waits are separately bounded at 500 ms and the lifecycle handler at three seconds. The wrapper suppresses all child output and emits a fixed advisory `{"continue":true}` envelope. Telemetry failure does not block agent or memory operations.

## Compatibility boundary

This public contract is the boundary for evaluating retirement of private `@aviaratech/ai-telemetry`. Retirement requires an accepted public capability and separately accepted consumer transitions, including any required schema, installation, trust or activation steps. This change does not inspect, remove, migrate or activate a private consumer, and does not change the package's version or publication workflow. Existing memory tools, checkpoint semantics and lifecycle handlers keep their owners.
