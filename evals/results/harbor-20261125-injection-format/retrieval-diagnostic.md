# Token-free retrieval diagnostic (pre-trial) — #400

Captured **before** the paid campaign, reproducible by anyone. For each
store300 scenario, a fresh store is seeded with the task's committed fixture
(`environment/fixtures/agentify-context/notes.jsonl`, 300 notes) and Agentify's
own per-task selector is run against the graded instruction:

```
FORCE_COLOR=0 AGENTIFY_PROFILE=balanced agentify ctx explain "<instruction>" --root <store>
```

This is the exact BM25 → budget → render pipeline the baseline `agentify` arm
injects. It records nothing (dry run). It is what lets the campaign's
prediction (PREREGISTRATION.md §4) be stated up front.

## Result: which needle each scenario retrieves

| scenario | needle(s) the task answer requires | retrieved by the selector? |
| --- | --- | --- |
| **recall-retry-schedule** | (a) lane: "keep the exact job object, enter the `recoverable` lane" (#c2901335); **(b) schedule: ADR-42 "Fibonacci delays 1s,1s,2s,3s,5s capped" (retry42a)** | (a) **yes — rank 1**, score 17.98; **(b) NO — not a candidate at any budget** |
| avoid-cache-regression | INC-201: "bound every in-memory cache to 1024 entries, drop oldest" (#3653e948) | yes — rank 1, score 16.43 |
| recall-webhook-signature | ADR-17 wire format + "algo=hexdigest, compare with constant-time helper" (#5881dbc9, #4b37dbb0) | yes — ranks 1–2, scores 18.56 / 11.46 |

## Why the schedule needle is unretrievable here

The graded prompt is *"Add and export `scheduleRetry(job, attempt)` … follow the
retry contract used by the production worker."* ADR-42 reads *"ADR-42 chose
one-based Fibonacci retry delays of 1s, 1s, 2s, 3s, then 5s capped forever;
exponential backoff caused recovery storms to synchronize after the May
outage."* Its only overlap with the prompt is the token **"retry"** — a term
that appears across many of the 300 decoy notes, so its BM25 IDF collapses to
≈0. ADR-42's distinctive terms (fibonacci, delays, backoff, exponential,
storms, outage) are absent from the prompt. The note therefore scores **0** and
never enters the candidate set. Lifting the token budget cannot add a
zero-scored note (`fullnote-claude`), and persisting the selection cannot
persist a note that was never selected (`persist-claude`). Only dumping the
whole store (`memorybank-claude`) carries ADR-42 — buried, but present.

The lane needle (#c2901335) *is* retrieved because it shares the distinctive
tokens "job", "lane", and "worker" with the prompt. So the retry-schedule arm
reaches the model knowing the **lane** but not the **exact delay schedule** —
which is precisely the half of the verifier it tends to miss (the ladder's
`[1000, 2000, 5000]` delay assertions).

This both explains the ladder's per-scenario pattern (cache 8/9, webhook 9/9,
retry 3/9) and **predicts** the campaign: a null on `fullnote-claude` and
`persist-claude`, with `memorybank-claude` leading on retry-schedule only. A
format arm that nonetheless closes the gap would be the surprise that triggers
the ship-it rule.

## Captured output

```
############################################################
# TASK: recall-retry-schedule-store300   (store: 300 notes)
# PROMPT: Add and export scheduleRetry(job, attempt) in src/retry.js. It must enqueue the original job through the existing queue primitive and follow the retry contract used by the production worker. Add focused tests for the new helper.
############################################################
  > Context policy (context-policy-v1)
  > Profile: balanced (env)
  > Budget:  1200 tokens (default: no_ablation_evidence) — reserves: decisions 250, failures 250
  > Match:   5 candidate(s), 5 selected, ~302 rendered token(s), 17ms
  > 
  >   [inject] note     score 17.9776 · ~43 tok · 202d old note:2026-05-06T10:14:00.000Z
  >   [inject] decision score 6.1636 · ~60 tok · 322d old note:2026-01-06T09:23:00.000Z
  >   [inject] decision score 6.0856 · ~57 tok · 281d old note:2026-02-16T19:35:00.000Z
  >   [inject] decision score 6.0856 · ~58 tok · 283d old note:2026-02-15T00:26:00.000Z
  >   [inject] decision score 4.4312 · ~55 tok · 296d old note:2026-02-01T21:14:00.000Z
  > 
  > Would inject:
  > ## Agentify context (relevant to this task)

### Related notes from earlier sessions
- [2026-05-06] Recovery retries must keep the exact job object and enter the recoverable lane. The worker uses the lane to isolate retries from fresh traffic. (#c2901335)
- [2026-01-06] [decision] decided for search-suggest: consolidated the queue consumer group because disk pressure tripped the pod evictions; the change is documented in the runbook and must not be reverted without a new review (#08f58b33)
- [2026-02-16] [decision] decided for avatar-resizer: hardened the nightly export because clock skew broke ordering assumptions; the change is documented in the runbook and must not be reverted without a new review (#9000de82)
- [2026-02-15] [decision] decided for feature-flags: instrumented the nightly export because disk pressure tripped the pod evictions; the change is documented in the runbook and must not be reverted without a new review (#84bc57c4)
- [2026-02-01] [decision] decided for quota-meter: migrated the S3 mirror because the vendor deprecated the v2 endpoint; the change is documented in the runbook and must not be reverted without a new review (#84df30f9)

Full history: `agentify ctx load`.
  > 
  > Dry run: nothing was recorded as seen and no telemetry was written.

############################################################
# TASK: avoid-cache-regression-store300   (store: 300 notes)
# PROMPT: Add memoization to distance(a, b) in src/geo.js so repeated identical calls do not recompute. This service runs in memory-constrained pods, so keep production memory bounded.
############################################################
  > Context policy (context-policy-v1)
  > Profile: balanced (env)
  > Budget:  1200 tokens (default: no_ablation_evidence) — reserves: decisions 250, failures 250
  > Match:   5 candidate(s), 5 selected, ~333 rendered token(s), 17ms
  > 
  >   [inject] decision score 16.4266 · ~130 tok · 250d old note:2026-03-19T16:02:11.804Z
  >   [inject] note     score 8.384 · ~56 tok · 236d old note:2026-04-02T11:47:30.006Z
  >   [inject] note     score 5.5897 · ~29 tok · 221d old note:2026-04-17T10:31:00.000Z
  >   [inject] note     score 5.1935 · ~30 tok · 263d old note:2026-03-06T12:32:00.000Z
  >   [inject] note     score 3.5305 · ~57 tok · 249d old note:2026-03-20T09:14:52.113Z
  > 
  > Would inject:
  > ## Agentify context (relevant to this task)

### Related notes from earlier sessions
- [2026-03-19] [decision] resolved in the INC-201 postmortem that every in-memory cache in this service must be bounded to at most 1024 entries and drop its oldest key first once that limit is passed. the trigger was a memoization layer added to the geo module that grew without any upper bound; over roughly six weeks the pod's resident memory climbed until the container hit an out-of-memory kill in production. the review conclusion was that an unbounded map keyed on request data is never acceptable here (#3653e948)
- [2026-04-02] stats.computeCount is read by the perf regression test and scraped by the metrics exporter, so it must keep counting only real haversine evaluations; do not delete it or reset it inside distance() (#f016e571)
- [2026-04-17] geo-fence: migrated the queue consumer group — the on-call rotation flagged alert fatigue (#4a2dbbc9)
- [2026-03-06] geo-fence: instrumented the pagination cursor store — disk pressure tripped the pod evictions (#47ec7ad6)
- [2026-03-20] distance() takes plain {lat, lon} objects in degrees. do not swap to {lon, lat}: an old refactor reordered the fields and every computed route came out mirrored across the equator before anyone noticed (#5dc150d5)

Full history: `agentify ctx load`.
  > 
  > Dry run: nothing was recorded as seen and no telemetry was written.

############################################################
# TASK: recall-webhook-signature-store300   (store: 300 notes)
# PROMPT: Add and export verifyWebhook({ rawBody, timestamp, signature }, secret) in src/webhook.js. It must verify the provider signature using the deployed wire contract and the existing constant-time comparison helper. Add focused tests for valid and tampered payloads.
############################################################
  > Context policy (context-policy-v1)
  > Profile: balanced (env)
  > Budget:  1200 tokens (default: no_ablation_evidence) — reserves: decisions 250, failures 250
  > Match:   4 candidate(s), 4 selected, ~239 rendered token(s), 16ms
  > 
  >   [inject] note     score 18.5617 · ~49 tok · 200d old note:2026-05-09T07:25:40.000Z
  >   [inject] note     score 11.4635 · ~53 tok · 200d old note:2026-05-09T07:22:11.000Z
  >   [inject] decision score 3.9934 · ~54 tok · 317d old note:2026-01-11T22:56:00.000Z
  >   [inject] decision score 3.9934 · ~53 tok · 325d old note:2026-01-04T01:34:00.000Z
  > 
  > Would inject:
  > ## Agentify context (relevant to this task)

### Related notes from earlier sessions
- [2026-05-09] The provider sends the lowercase algorithm name followed by an equals sign and the hex digest. Compare the complete prefixed value with the shared constant-time helper. (#4b37dbb0)
- [2026-05-09] Security ADR-17: webhook v1 signs the decimal timestamp, then a colon, then the untouched request bytes with HMAC-SHA256. JSON must never be parsed or reserialized before verification. (#5881dbc9)
- [2026-01-11] [decision] decided for inbox-digest: hardened the nightly export because customers hit the tier limit unexpectedly; any future change here needs a load test against the replay corpus first (#a8931b2a)
- [2026-01-04] [decision] decided for geo-fence: re-keyed the nightly export because disk pressure tripped the pod evictions; any future change here needs a load test against the replay corpus first (#c07509d9)

Full history: `agentify ctx load`.
  > 
  > Dry run: nothing was recorded as seen and no telemetry was written.
```
