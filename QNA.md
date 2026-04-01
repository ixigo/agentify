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
