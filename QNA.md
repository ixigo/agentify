# Agentify Deep-Dive Q&A

This file explains **what this project is**, **why it exists**, and **how indexing, semantic analysis, caching, docs, and execution loops work**.

---

## 1) What is Agentify in one sentence?

Agentify is a repository orchestration CLI that wraps provider CLIs (Codex/Claude/Gemini/OpenCode) with deterministic local indexing, planning, docs generation, validation, and session continuity.

---

## 2) Why not just use Codex or Claude Code directly?

You can use providers directly for fast one-off tasks.

Agentify adds value when you need:

- repeatable repository artifacts (`.agents/index.db`, docs, run manifests),
- deterministic context selection (`agentify plan`),
- safety checks/freshness validation (`agentify check`),
- provider portability and sticky defaults,
- local session manifests (`sess run/resume/fork`) that are auditable.

In short: provider CLIs are the execution engine; Agentify is the orchestration and governance layer.

---

## 3) What are the core phases in the workflow?

A typical full cycle is:

1. **index** (`scan`) -> build repository DB snapshot
2. **doc** -> generate docs/metadata/headers
3. **check** -> validate freshness/safety rules
4. **run/exec/sess** -> execute provider command with selected context

`agentify up` chains scan -> doc -> check -> tests.

---

## 4) Why does Agentify generate docs like `docs/repo-map.md` and module docs?

Because provider sandboxes often vary in what they can inspect.

Agentify materializes a stable repo map and module summaries so downstream prompts can rely on deterministic text context instead of repeatedly rediscovering structure from scratch.

This also makes context inspectable by humans in PR review.

---

## 5) Why use `.agents/index.db` at all?

SQLite gives a compact and queryable canonical model for:

- modules,
- files,
- symbols,
- imports,
- tests,
- commands,
- semantic project/symbol/edge tables.

Planner, query commands, docs generation, and semantic features all read from this index.

---

## 6) What does the index store (high level)?

It stores both structural and semantic layers:

- structural: modules/files/symbols/imports/tests/commands/artifacts/index events
- semantic TS/JS: semantic projects, semantic symbols, surfaces, symbol edges, external packages, project files

This lets Agentify answer ownership/dependency/search queries and build targeted prompts.

---

## 7) How does indexing detect modules/files?

Indexing walks repository files, applies language/module detection heuristics (workspace/package roots and stack-specific rules), classifies test/config/entrypoint files, then persists fingerprinted rows.

For TS/JS it uses TypeScript APIs for richer import/symbol extraction; for other stacks it also has generic extractors.

---

## 8) How does the AST/LSP-style analysis work here?

There are two levels:

1. **Structural indexer level**
   - Uses TypeScript parser APIs to extract symbols/import relations for TS/JS source.
   - Provides deterministic symbol spans and module linkage in `.agents/index.db`.

2. **Semantic TS/JS level**
   - `semantic refresh` discovers TS/JS projects (`tsconfig`/`jsconfig`), runs semantic worker analysis, and stores symbols/surfaces/edges.
   - This behaves like a lightweight, persisted code intelligence graph (similar spirit to LSP navigation artifacts, but stored in Agentify tables).

---

## 9) What is “semantic refresh” and why optional?

Semantic refresh computes deeper TS/JS facts (project graph, symbol graph, surfaces, route/react surfaces).

It is optional (`semantic.tsjs.enabled`) because it can be heavier than plain structural indexing, and not all repos need it.

When enabled, planner/docs/query can incorporate these richer facts.

---

## 10) How does planning choose context?

Planner tokenizes the task, then scores modules/files/symbols by:

- name/path/token matches,
- key-file/entrypoint hints,
- changed files,
- module dependency proximity,
- semantic symbol facts (when enabled).

It then selects bounded modules/files/symbols/tests and renders one execution prompt with explicit verification command hints.

---

## 11) How does caching work in docs generation?

Two major cache layers are used during `doc`:

1. **Manager plan cache**
   - If manager input fingerprint matches, reuse prior plan.

2. **Per-module artifact cache**
   - If module fingerprint+context match, reuse prior module artifact payload.

Result: reruns are faster and cheaper when content is unchanged.

---

## 12) What does semantic caching mean in practice?

Semantic refresh tracks analyzer version, project fingerprints, and project states.

If project inputs are unchanged, semantic work can be skipped/reused, and doc/planner operate on stored semantic tables.

This avoids recomputing large TS/JS graphs every run.

---

## 13) Example: cache hit during docs

Suppose `src/auth` is unchanged and planner inputs are stable:

- manager plan fingerprint matches -> cached manager plan reused,
- module fingerprint matches -> cached module markdown/metadata reused,
- output still refreshed (run manifests/docs references) with minimal recompute.

If only one module changes, only that module recomputes while others remain cache hits.

---

## 14) Example: index + plan + run

Task: “add retry logic to checkout service”

1. `agentify scan` updates module/file/symbol index.
2. `agentify plan "add retry logic..."` selects likely modules/files/tests.
3. `agentify run ...` builds provider command template and executes.
4. On code changes, Agentify auto-runs scan+doc refresh and validation.

This makes execution loop deterministic and repo-aware.

---

## 15) How does validation protect the repo?

Validation checks:

- index freshness (HEAD commit alignment),
- allowed generated paths,
- constrained header-only behavior in guarded scenarios,
- semantic project readiness/coverage when semantic mode is enabled.

This catches stale/misaligned artifacts and unsafe generated file drift.

---

## 16) Why session manifests?

Sessions store:

- manifest (`session-manifest.json`),
- context snapshot (`context.json`),
- bootstrap markdown (`bootstrap.md`),
- checklist.

This supports resuming/forking work with bounded context and traceability across long tasks.

---

## 17) What is stored in `.agents/cache`?

Content-addressed blobs and manifests used by cache maintenance commands (`cache gc`, `cache status`) and cleanup workflows.

It enables pruning by age and measuring footprint.

---

## 18) What is the role of `agentify query`?

It surfaces index-backed answers without manual DB work:

- `owner` -> owning module of a file,
- `deps` -> module dependency neighbors,
- `changed` -> module impact since commit,
- `search` -> structural + semantic search.

Useful for deterministic triage and prompt preparation.

---

## 19) Why add skills like `grill-me` and `gh-issue-autopilot`?

Skills are reusable operation playbooks.

- `grill-me` now helps pressure-test plans and map final plans to GitHub issue types before optional publishing.
- `gh-issue-autopilot` can pick first/latest open issue through `gh`, execute implementation loops, rerun checks, and commit when green.

This turns repeated workflows into consistent operator patterns.

---

## 20) Project direction: what are we doing here?

The project is building a **deterministic AI coding operations layer** for real repositories:

- predictable context prep,
- provider-agnostic execution,
- auditable artifacts,
- safety/freshness guardrails,
- repeatable autonomous workflows (skills + sessions).

The goal is not replacing provider intelligence; it is making AI-assisted engineering workflows **reliable, inspectable, and team-scalable**.

---

## 21) What are the biggest current problems/gaps to solve next?

The biggest practical gaps today are mostly around **depth, visibility, and feedback loops**:

1. **Semantic coverage is TS/JS-first**
   - Deep semantic graphing is strongest for TypeScript/JavaScript projects.
   - Python/Go/Java/C# repositories get structural indexing, but not equivalent semantic richness yet.

2. **Semantic internals are not obvious to new users**
   - Users can run `scan/plan/query`, but often do not understand which tables/facts are driving ranking decisions.
   - This creates a “black box” feel when context selection seems surprising.

3. **Limited explainability in planner outputs**
   - Planner picks are deterministic, but the “why this file, why this symbol” rationale can still be too compact.
   - Users want score breakdowns tied to token matches, dependency distance, and semantic edge strength.

4. **Optional semantic mode can be underused**
   - Because semantic refresh is optional, teams may skip it and unknowingly lose high-value context quality.
   - We need better defaults, prompts, and diagnostics to signal when semantic mode would materially help.

5. **LSP-style parity is partial**
   - Agentify stores persisted navigation facts similar in spirit to LSP capabilities, but does not yet expose full “IDE-like” operations uniformly across all languages.

6. **Agent handoff ergonomics can improve**
   - Sessions and docs are strong, but cross-agent collaboration still benefits from richer “next best action” artifacts and stronger conflict detection for parallel changes.

---

## 22) Concrete feature roadmap to address those issues

High-impact features to add next:

1. **Multi-language semantic adapters**
   - Add analyzers for Python, Go, Java, and .NET with normalized symbol/edge tables.
   - Goal: same query/planner quality profile regardless of language stack.

2. **Explainable planning mode**
   - Add `agentify plan --explain` to print per-file/per-symbol scoring contributions:
     - lexical match score,
     - dependency proximity score,
     - semantic edge score,
     - recency/changed-file score.

3. **Semantic health diagnostics**
   - Add `agentify doctor --semantic` to report:
     - discovered projects,
     - parse failures,
     - stale project fingerprints,
     - symbol/edge counts and coverage trends.

4. **LSP-bridge query commands**
   - Add query subcommands aligned with common IDE navigation:
     - `query def --symbol <name>`
     - `query refs --symbol <name>`
     - `query callers --symbol <name>`
     - `query impacts --file <path>`

5. **Agent handoff bundle generation**
   - Add `agentify handoff` to package:
     - top-ranked context,
     - semantic neighborhood of touched symbols,
     - recommended test commands,
     - unresolved risks and TODOs.

6. **PR-risk and regression prediction**
   - Use dependency + semantic edges to estimate blast radius and prioritize test suites automatically.

---

## 23) How semantic AST + LSP-style analysis actually works (detailed)

Think of Agentify analysis as a layered pipeline:

1. **File discovery + module detection**
   - Classifies files into modules and identifies project roots.

2. **AST extraction (structural layer)**
   - Parses source files and records symbols/imports with stable spans.
   - Produces deterministic base facts for ownership and dependency queries.

3. **Semantic project build (TS/JS today)**
   - Discovers `tsconfig`/`jsconfig` roots.
   - Builds project-level semantic model and symbol graph.

4. **LSP-style relationships persisted in DB**
   - Stores “navigation-like” facts (symbol edges, surfaces, external package links).
   - Unlike transient IDE memory, these artifacts are persisted and queryable by CLI.

5. **Planner consumption**
   - Planner combines lexical relevance + graph proximity + semantic edges.
   - Returns bounded context to provider execution with test hints.

### Example walkthrough

Task: **“harden checkout retries and propagate timeout errors correctly”**

1. AST layer finds likely lexical matches:
   - `CheckoutService`, `RetryPolicy`, `TimeoutError`, `httpClient`.
2. Semantic layer resolves deeper links:
   - `CheckoutService.submitOrder` -> calls `PaymentGateway.charge`.
   - `PaymentGateway.charge` -> wraps `httpClient.post` and maps transport errors.
   - tests referencing `PaymentGateway.charge` and retry behavior are connected by symbol edges.
3. Planner ranks context:
   - includes checkout and payment modules,
   - includes retry utility,
   - includes highest-impact tests,
   - excludes unrelated modules despite broad keyword overlap.

Result: agents start with tighter, higher-signal context and spend fewer turns rediscovering architecture.

---

## 24) How agents benefit when a codebase is “Agentify-up”

When a repo is kept fresh with `agentify up`, agents gain:

1. **Faster onboarding per task**
   - prebuilt map/docs/index reduce discovery overhead.

2. **Higher precision context windows**
   - planner pulls likely-impact files/symbols/tests instead of naive keyword chunks.

3. **Lower hallucination risk**
   - responses can anchor to indexed structure and generated docs rather than assumptions.

4. **More reliable edits**
   - semantic edges expose hidden coupling and call impacts before patching.

5. **Better test targeting**
   - dependency + symbol neighborhood narrows which tests should run first.

6. **Auditable execution trail**
   - run manifests/session artifacts make autonomous behavior inspectable and reproducible.

In practice, this means better first-pass patches, fewer corrective loops, and easier multi-agent collaboration in large repositories.
