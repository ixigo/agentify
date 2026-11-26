# Deviations — five-family downshift REPLICATION (agentify v0.5.0)

The pre-registration (`PREREGISTRATION.md`, committed in 360b4ac before any
graded trial) is authoritative. Its §5 lists five **planned** deviations from
the 2026-08-21 campaign (agentify version, dataset 1.1.0→1.2.0, Claude Code CLI
pin policy, identical model ids, unchanged Harbor/host). This file records the
**one unplanned deviation** forced during execution, plus restates the planned
ones for completeness. None change the pre-registered suite, tasks, arms, caps,
attempts, or the verdict rule.

## D6 (unplanned, forced) — `agentify install` SIGSEGV → skip the install-time index build

**What happened.** The first smoke (4 trials) failed both `agentify-claude`
trials with `NonZeroAgentExitCodeError` (exit 139). The baseline `claude-code`
trials passed. The crash is a segmentation fault in the agentify arm's install
step:

```
Command failed (exit 139): cd /app && agentify install --provider claude && ...
  agentify v0.5.0
bash: line 1: 128 Segmentation fault (core dumped) agentify install --provider claude
```

**Root cause.** agentify v0.5.0 bumped `better-sqlite3` to `^13.2.0`
(commit `1d98168`, part of PR #421 "sqlite-ts-majors"), which is **new since the
2026-11-25 injection-format campaign's commit `abb425e`** and absent in the
2026-08-21 campaign's v0.4.0. In the task image (`node:22.12.0-bookworm-slim`,
aarch64, glibc 2.36) the better-sqlite3@13 prebuilt native binding is missing /
non-loadable and SIGSEGVs when `agentify install` builds the **structural
index**. Reproduced deterministically in the exact task image (see
`scratchpad` repro; summarized here):

- default `agentify install --provider claude` → exit **139** (segfault in the
  index build);
- a from-source rebuild of better-sqlite3 let `install` exit 0 but
  `agentify scan` still segfaulted — so rebuilding is neither reliable nor
  minimal;
- `agentify install --provider claude --no-index` → exit **0**, writes
  `CLAUDE.md` + `.claude/hooks` + `settings.json`, seeds fixtures, and the
  **context-recall path the benchmark measures works**: `agentify ctx load` and
  `agentify ctx match` return the seeded decision (e.g. the INC-114 single JSON
  error-envelope ADR for `recall-error-envelope`), and the `agentify ctx track
  --hook` SessionStart hook exits 0.

**Why `--no-index` is faithful, not a design change.** The structural index
(`agentify scan`/`query`/`risk`) is backed by better-sqlite3
(`src/core/db/connection.js`). The durable **context store** that these
downshift tasks exercise is **file-based** (`src/core/project-store.js`:
`index.json` / `store.json`), and never touches better-sqlite3. The downshift
suite measures context recall, not structural queries — no task in the suite
issues a `query`/`risk`/`scan`. Skipping the index build therefore leaves the
measured behaviour (recall of seeded decisions via hooks + injected digest)
identical to August, and only drops a capability the benchmark does not use.

**Fix (harness-only, env-gated, committed).**
`evals/harbor/agents/agentify_claude.py` gained an opt-in
`AGENTIFY_EVAL_INSTALL_NO_INDEX` env flag (default off → the committed install
command stays byte-identical to every prior campaign). The replication launch
sets `AGENTIFY_EVAL_INSTALL_NO_INDEX=1`, appending `--no-index` to
`agentify install`. The agentify **product source is byte-identical to the
v0.5.0 tag** — nothing in agentify's code changed; only the eval harness's
install invocation skips an index build that segfaults and that the suite never
reads. The smoke was re-run and both agentify arms became gradeable before the
full campaign launched.

**Scope of effect on the result.** None on the measured arm behaviour for this
suite. If anything it is conservative for the agentify arm: the arm runs with
*less* tooling (no structural index) than August, yet the recall capability
under test is unchanged. The segfault itself is a real v0.5.0 packaging
regression worth a product follow-up (better-sqlite3@13 prebuilt binding on
aarch64 Debian-slim), tracked separately from this benchmark.

## D7 (unplanned, forced) — three full runs committed; primary chosen by a rule set *after* the runs

**What happened.** The original run (`2026-11-25__18-19-12`, concurrency 2)
finished all 180 trials in 4h43m but left **25 install/setup host-faults** —
overwhelmingly the baseline `claude-code` arm, whose Harbor builtin installer
downloads the latest CLI (`claude-2.1.332`, unpinned) from downloads.claude.ai
on every trial; under host/network load that download exceeded Harbor's hardcoded
360s setup cap (`trial.py: _AGENT_SETUP_TIMEOUT_SEC = 360`), raising
`AgentSetupTimeoutError`/`NetworkConnectionError` before any graded model ran
(the arm-neutral `harness_error` class). Per the pre-registration ("re-run when
feasible"), I tried to recover those 25.

**The lesson (operator error, recorded).** I believed `harbor job resume -p <job>`
would re-run only the errored trials in place. It does **not**: it launches a
**fresh full 180-trial run in a new job directory**. (Proof: every `result.json`
in the later jobs carries a fresh mtime from its own run window, and there is
zero trial-hash overlap between the three job dirs.) So each "recovery" was a
whole new campaign:

| run | job dir | concurrency | host-faults | gradeable pairs |
| --- | --- | --- | --- | --- |
| A | `2026-11-25__18-19-12` | 2 | 25 | 66 |
| B | `2026-11-25__23-05-12` | 2 | 25 | 66 |
| C (**primary**) | `2026-11-26__12-18-47` | 1 | **0** | **90** |

B was resume #1 (still concurrency 2 → still 25 host-faults). C was resume #2 at
**concurrency 1** (a host-scheduling knob only — it does not change any trial's
image, model, caps, or verifier, so it is not a pre-registered variable) to
remove the contention; it completed all 180 trials with **0 harness errors**.

**Primary-selection rule, and the honest caveat.** The pre-registration assumes
one run and does not cover reruns. I therefore set the rule here, **after** the
runs existed — which I state plainly rather than imply it was pre-declared. The
rule is deliberately **outcome-independent**: *primary = the single full run in
which all 180 pre-registered trials are gradeable (zero excluded harness_errors),
i.e. the run matching the pre-registered n=180 exactly.* That is **C**. It is
decided on data completeness, never on pass counts, discordant tallies, or
p-values. The guard against cherry-picking is empirical: the #322 suite-level
verdict is **WINNER agentify in all three runs**, same direction, discordant
spanning the **same two families**, Wilson CIs separated in each — so the choice
of primary cannot change the conclusion. All three are committed as separate
jobs in `campaign.json` and reported side by side by `analysis.mjs`, so a reader
audits every run, not just the primary:

| run | agentify | claude-code | discordant a/b | sign p | WINNER? |
| --- | --- | --- | --- | --- | --- |
| A | 64/66 | 39/66 | 25/0 | 5.96e-8 | yes |
| B | 65/66 | 43/66 | 22/0 | 4.77e-7 | yes |
| C (primary) | 89/90 | 57/90 | 32/0 | 4.66e-10 | yes |

**Scope of effect.** None on the verdict (identical across A/B/C). The only
substantive differences are pair counts (A/B lose ~24 pairs to the baseline's
install host-faults; C loses none) and that extra subscription time/tokens were
spent on the two unintended full reruns.

## Planned deviations (restated from PREREGISTRATION.md §5)

1. **Agentify version (the intended variable):** 0.4.0 (`#7cd5351`) → **0.5.0**
   (`v0.5.0` tag, resolved `dfcfb3c…`), via
   `AGENTIFY_EVAL_AGENTIFY_SPEC=github:ixigo/agentify#v0.5.0`.
2. **Dataset / fixtures:** `agentify-context-bench` **1.1.0 → 1.2.0** (fixtures
   regenerated between Aug and Nov; a genuine confound, unavoidable on current
   `main`).
3. **Claude Code CLI:** agentify arm pins `@anthropic-ai/claude-code@2.1.208`;
   the builtin baseline installs whatever Harbor 0.18.0 resolves at run time
   (same policy as August).
4. **Models:** identical ids to August. `claude-sonnet-4-5-20250929` emits a
   "retired on 2026-11-30" warning but still serves; all sonnet trials finished
   before that date.
5. **Harbor 0.18.0**, host colima/macOS aarch64 — unchanged.
