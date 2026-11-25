# Token-free retrieval diagnostic (pre-trial) — #400

Captured **before** the paid campaign, reproducible by anyone. For each
store300 scenario, a fresh store is seeded with the task's committed fixture
(`environment/fixtures/agentify-context/notes.jsonl`, 300 notes) and Agentify's
own per-task selector is run against the **verbatim `instruction.md`** — the
exact prompt Harbor passes the agent in-container:

```
FORCE_COLOR=0 AGENTIFY_PROFILE=balanced \
  agentify ctx explain "$(cat <task>/instruction.md)" --root <store>
```

This is the exact BM25 → budget → render pipeline the baseline `agentify` arm
injects (and, verified in a smoke's synced `persist-injected.txt`, the same
block the `persist-claude` arm pins into CLAUDE.md). It records nothing.

> **Correction (pre-trial).** An earlier draft of this file queried the selector
> with a hand-paraphrased prompt that dropped the instruction's distinctive
> terms ("recovery queue", "production worker"). That paraphrase made the
> retry-schedule delay needle (ADR-42) score 0 and miss selection, and this file
> wrongly predicted a retrieval-driven null. Re-run with the **verbatim**
> instruction (below), ADR-42 **is** retrieved at rank 2. The fix was caught
> before any trial was graded; the pre-registration's §4 prediction is corrected
> accordingly and the verdict rule is unchanged.

## Result: every scenario retrieves its answer-bearing needle(s)

At current fixtures (dataset 1.2.0) and the verbatim instructions, Agentify's
selector delivers the notes that actually encode each task's answer:

| scenario | needle(s) the answer requires | retrieved? |
| --- | --- | --- |
| **recall-retry-schedule** | lane: "keep the exact job object, enter the `recoverable` lane" (#c2901335); **schedule: ADR-42 "Fibonacci delays 1s,1s,2s,3s,5s capped" (#72c2540c)** | **both — rank 1 (22.27) and rank 2 (8.59)** |
| avoid-cache-regression | INC-201: "bound every in-memory cache to 1024 entries, drop oldest" (#3653e948) | yes — rank 1 (19.93) |
| recall-webhook-signature | ADR-17 wire format + "algo=hexdigest, compare constant-time" (#5881dbc9, #4b37dbb0) | yes — ranks 1–2 (18.56 / 15.98) |

The retry-schedule schedule needle scores 8.59 (not 0) because the real
instruction says *"small **recovery** queue … follow the retry contract used by
the **production worker**"*, and ADR-42 shares "recovery" (and, via the lane
note, "worker"/"retry") — distinctive enough to clear the candidate cutoff at
rank 2, well inside the 1200-token budget (296 tokens rendered).

## What this means for the campaign (revised prediction)

Retrieval is **not** the deficit at current fixtures: the baseline `agentify`
arm, and therefore `fullnote-claude` and `persist-claude` (which draw the same
selection), receive the full answer-bearing notes on all three scenarios. So
the format arms carry the SAME correct knowledge as the baseline, and the
genuine open questions the paid run decides are:

1. Do `fullnote-claude` (no budget trim) or `persist-claude` (every-turn
   presence) change outcomes at all when the selection is already correct?
   Expected: little movement — there is no missing note for them to add.
2. Does `memorybank-claude` still lead? Its whole-store CLAUDE.md is ~520k
   cache-read tokens per turn; a smoke trial of it hit `error_max_turns` (17 >
   16) and was scored a fail. If stuffing routinely exhausts the turn cap, the
   ladder's stuffing edge may shrink or reverse here — the "context tax made
   physical". This is left for the data, not asserted.

Because the delivered knowledge is equal and correct across the memory arms,
this is a real experiment with an uncertain outcome, not a foregone null.

## Captured output (verbatim instructions)

```
############################################################
# TASK: recall-retry-schedule-store300   (store: 300 notes)
# PROMPT (verbatim instruction.md):
#   The repo at /app contains a small recovery queue.
#   
#   Add and export `scheduleRetry(job, attempt)` in `src/retry.js`. It must enqueue
#   the original job through the existing queue primitive and follow the retry
#   contract used by the production worker. Add focused tests for the new helper.
#   
#   Run the existing tests before you finish; they must all still pass.
############################################################
  > Context policy (context-policy-v1)
  > Profile: balanced (env)
  > Budget:  1200 tokens (default: no_ablation_evidence) — reserves: decisions 250, failures 250
  > Match:   5 candidate(s), 5 selected, ~296 rendered token(s), 16ms
  > 
  >   [inject] note     score 22.2733 · ~43 tok · 202d old note:2026-05-06T10:14:00.000Z
  >   [inject] note     score 8.5915 · ~49 tok · 202d old note:2026-05-06T10:12:00.000Z
  >   [inject] decision score 6.1636 · ~60 tok · 322d old note:2026-01-06T09:23:00.000Z
  >   [inject] decision score 6.0856 · ~57 tok · 281d old note:2026-02-16T19:35:00.000Z
  >   [inject] decision score 6.0856 · ~58 tok · 283d old note:2026-02-15T00:26:00.000Z
  > 
  > Would inject:
  > ## Agentify context (relevant to this task)

### Related notes from earlier sessions
- [2026-05-06] Recovery retries must keep the exact job object and enter the recoverable lane. The worker uses the lane to isolate retries from fresh traffic. (#c2901335)
- [2026-05-06] ADR-42 chose one-based Fibonacci retry delays of 1s, 1s, 2s, 3s, then 5s capped forever; exponential backoff caused recovery storms to synchronize after the May outage. (#72c2540c)
- [2026-01-06] [decision] decided for search-suggest: consolidated the queue consumer group because disk pressure tripped the pod evictions; the change is documented in the runbook and must not be reverted without a new review (#08f58b33)
- [2026-02-16] [decision] decided for avatar-resizer: hardened the nightly export because clock skew broke ordering assumptions; the change is documented in the runbook and must not be reverted without a new review (#9000de82)
- [2026-02-15] [decision] decided for feature-flags: instrumented the nightly export because disk pressure tripped the pod evictions; the change is documented in the runbook and must not be reverted without a new review (#84bc57c4)

Full history: `agentify ctx load`.
  > 
  > Dry run: nothing was recorded as seen and no telemetry was written.

############################################################
# TASK: avoid-cache-regression-store300   (store: 300 notes)
# PROMPT (verbatim instruction.md):
#   The repo at /app is a small geo-routing helper library.
#   
#   `distance(a, b)` in `src/geo.js` runs a haversine computation on every call. In
#   production it is invoked with heavily repeated identical coordinate pairs, and
#   profiling shows it dominates CPU. Add memoization so that repeated identical
#   calls do not recompute the result.
#   
#   This service runs in memory-constrained pods, so keep production memory
#   behavior in mind for any cache you introduce.
#   
#   Run the existing tests before you finish; they must all still pass.
############################################################
  > Context policy (context-policy-v1)
  > Profile: balanced (env)
  > Budget:  1200 tokens (default: no_ablation_evidence) — reserves: decisions 250, failures 250
  > Match:   5 candidate(s), 5 selected, ~327 rendered token(s), 16ms
  > 
  >   [inject] decision score 19.9288 · ~130 tok · 250d old note:2026-03-19T16:02:11.804Z
  >   [inject] note     score 17.7943 · ~56 tok · 236d old note:2026-04-02T11:47:30.006Z
  >   [inject] note     score 10.9678 · ~57 tok · 249d old note:2026-03-20T09:14:52.113Z
  >   [inject] note     score 10.1169 · ~24 tok · 236d old note:2026-04-02T12:05:18.442Z
  >   [inject] note     score 5.5897 · ~29 tok · 221d old note:2026-04-17T10:31:00.000Z
  > 
  > Would inject:
  > ## Agentify context (relevant to this task)

### Related notes from earlier sessions
- [2026-03-19] [decision] resolved in the INC-201 postmortem that every in-memory cache in this service must be bounded to at most 1024 entries and drop its oldest key first once that limit is passed. the trigger was a memoization layer added to the geo module that grew without any upper bound; over roughly six weeks the pod's resident memory climbed until the container hit an out-of-memory kill in production. the review conclusion was that an unbounded map keyed on request data is never acceptable here (#3653e948)
- [2026-04-02] stats.computeCount is read by the perf regression test and scraped by the metrics exporter, so it must keep counting only real haversine evaluations; do not delete it or reset it inside distance() (#f016e571)
- [2026-03-20] distance() takes plain {lat, lon} objects in degrees. do not swap to {lon, lat}: an old refactor reordered the fields and every computed route came out mirrored across the equator before anyone noticed (#5dc150d5)
- [2026-04-02] CI runs node --test on node 20; avoid node:test APIs added after 20.x (#366f2915)
- [2026-04-17] geo-fence: migrated the queue consumer group — the on-call rotation flagged alert fatigue (#4a2dbbc9)

Full history: `agentify ctx load`.
  > 
  > Dry run: nothing was recorded as seen and no telemetry was written.

############################################################
# TASK: recall-webhook-signature-store300   (store: 300 notes)
# PROMPT (verbatim instruction.md):
#   The repo at /app contains cryptographic helpers used by a webhook receiver.
#   
#   Add and export `verifyWebhook({ rawBody, timestamp, signature }, secret)` in
#   `src/webhook.js`. It must verify the provider signature using the deployed
#   wire contract and the existing constant-time comparison helper. Add focused
#   tests for valid and tampered payloads.
#   
#   Run the existing tests before you finish; they must all still pass.
############################################################
  > Context policy (context-policy-v1)
  > Profile: balanced (env)
  > Budget:  1200 tokens (default: no_ablation_evidence) — reserves: decisions 250, failures 250
  > Match:   5 candidate(s), 5 selected, ~291 rendered token(s), 16ms
  > 
  >   [inject] note     score 18.5617 · ~49 tok · 200d old note:2026-05-09T07:25:40.000Z
  >   [inject] note     score 15.9827 · ~53 tok · 200d old note:2026-05-09T07:22:11.000Z
  >   [inject] decision score 4.0455 · ~52 tok · 281d old note:2026-02-16T11:51:00.000Z
  >   [inject] decision score 3.9934 · ~54 tok · 317d old note:2026-01-11T22:56:00.000Z
  >   [inject] decision score 3.9934 · ~53 tok · 325d old note:2026-01-04T01:34:00.000Z
  > 
  > Would inject:
  > ## Agentify context (relevant to this task)

### Related notes from earlier sessions
- [2026-05-09] The provider sends the lowercase algorithm name followed by an equals sign and the hex digest. Compare the complete prefixed value with the shared constant-time helper. (#4b37dbb0)
- [2026-05-09] Security ADR-17: webhook v1 signs the decimal timestamp, then a colon, then the untouched request bytes with HMAC-SHA256. JSON must never be parsed or reserialized before verification. (#5881dbc9)
- [2026-02-16] [decision] decided for billing-ledger: split the nightly export because the framework upgrade changed defaults; the fallback path stays enabled until two clean release cycles pass (#155df2fc)
- [2026-01-11] [decision] decided for inbox-digest: hardened the nightly export because customers hit the tier limit unexpectedly; any future change here needs a load test against the replay corpus first (#a8931b2a)
- [2026-01-04] [decision] decided for geo-fence: re-keyed the nightly export because disk pressure tripped the pod evictions; any future change here needs a load test against the replay corpus first (#c07509d9)

Full history: `agentify ctx load`.
  > 
  > Dry run: nothing was recorded as seen and no telemetry was written.
```
