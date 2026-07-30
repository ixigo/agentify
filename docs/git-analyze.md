# `agentify git analyze`

Turn your local git history into a filtered summary and a shareable HTML report.
One command, read-only, nothing to install.

```bash
agentify git analyze
```

That is the whole thing. Run it inside any git repository. It reads your commit
history for the last 30 days, groups the work into themes, prints a summary, and
writes an HTML report you can open in a browser. It installs nothing, writes
nothing into your repository, and makes no network calls.

You do **not** need to have run `agentify install`, `agentify scan`, or anything
else first. If this is the first Agentify command you have ever run, it works.

## What you get

- A summary of what changed, by whom, on what, in a window you choose — behind
  real filters (branch, path, commit-message search, conventional type/scope,
  issue key, author).
- An HTML report that opens in your browser, ending with a short note about what
  Agentify can do when it is set up. A pointer, not an installer.
- Every number is computed from your git history deterministically. Optional AI
  narration (off by default) may phrase and group; it never produces a figure.

## The one command, and a few useful shapes

```bash
# The last 30 days of this repository (default).
agentify git analyze

# A quarter, as JSON, for a script or a paste.
agentify git analyze --quarter 1 --year 2026 --format json

# Just your own commits over the last three months.
agentify git analyze --months 3 --me

# Preview the resolved window without reading a single commit.
agentify git analyze --dry-run

# Everything you shipped on fix commits touching the API, last quarter.
agentify git analyze --quarter 2 --year 2026 --type fix --path 'src/api/**'
```

## Command surface

```
agentify git analyze [window] [scope] [filters] [narration] [tracker] [output]

window   (mutually exclusive; default --days 30)
  --days <n> | --months <n> | --quarter <1-4> [--year <yyyy>] | --year <yyyy>
  --since <date|ref> [--until <date|ref>]

scope
  --local                current repository only                     (default)
  --global               every git repo discovered under the roots
  --root <dir>           discovery root, repeatable                  (default $HOME, depth 4)
  --repo <glob>          keep only repos matching name/path, repeatable

filters
  --me                   your git identities (git config + .mailmap)
  --author <pattern>     repeatable
  --branch <glob>        commits reachable from matching branches, repeatable
  --grep <pattern>       commit-message search, repeatable
  --path <glob>          pathspec filter, repeatable
  --type <list>          conventional types: feat,fix,refactor,...
  --scope <list>         conventional scopes: acp,analyze,...
  --issue <key>          commits citing #123 or PROJ-123, repeatable
  --include-merges       count merge commits                         (default excluded)

narration                (entirely optional; off = zero cost, zero network)
  --ai                   enable provider narration                   (default off)
  --provider claude|codex
  --depth metadata|diff  what reaches the provider                   (default metadata)
  --max-budget-usd <n>                                               (default 0.50)

tracker
  --jira auto|off|acli|rest                                          (default off)

output
  --format html|md|text|json                                         (default html)
  --output <path> | --no-open | --dry-run | --yes
```

The resolved filter set is printed in the report header, so a surprising number
is always explainable. Filter semantics are honest: `--branch` restricts
*reachability*, `--grep` restricts *messages*, and a report that applied both
says so.

## The `--me` gotcha: two identities

`--me` resolves *your* identities from `git config` and, if present, `.mailmap`.
The most common way a first run under-reports is a second identity it never saw.
Many people commit under a work email in one place and a personal email in
another — for example this project has commits under both
`ranveer.kumar@travenues.com` and `ranveersequeira@gmail.com`. If `--me` only
knows one of them, half your work is missing from the summary.

Two ways to fix it:

```bash
# Name both identities explicitly.
agentify git analyze --months 3 --author ranveer.kumar@travenues.com --author ranveersequeira@gmail.com

# Or teach git once, so --me (and everything else) sees them as one person.
printf 'Ranveer <ranveer.kumar@travenues.com> <ranveersequeira@gmail.com>\n' >> .mailmap
```

A missing `.mailmap` is never an error — it is a stated limitation in the report,
not a failure.

## Worked example (this repository)

For the window `2026-04-29 → 2026-07-29`, counting both identities and excluding
merge commits, this repository reports:

| Metric | Value |
|---|---|
| Commits | 276 |
| Churn | +84,067 / −44,717 |
| Files touched | 516 |
| Issue references | 140 |
| Merge commits (excluded from the churn above) | 176 |

```bash
agentify git analyze \
  --since 2026-04-29 --until 2026-07-29 \
  --author ranveer.kumar@travenues.com --author ranveersequeira@gmail.com \
  --format json
```

Add `--include-merges` to fold the 176 merge commits back into the counts.

## What it will never do

This command **observes; it does not record**. Specifically:

- It requires no `.agentify.yaml` and never creates one.
- It requires no index and never runs a scan.
- It writes **nothing** inside the repository being analysed — not a report, not
  a cache, not even a gitignored file. `git status` is unchanged afterwards.
- Reports default to a path **outside** your repository, under
  `~/.cache/agentify/git-analyze/` (or `$XDG_CACHE_HOME` when that is set to an
  absolute path). Use `--output <path>` to put a report wherever you like.
- On the default path it makes **no** network calls and starts **no** provider
  process. Git is used read-only: `log`, `rev-list`, `for-each-ref`,
  `rev-parse`, `show`, `diff`, `config --get`, and similar — never `fetch`,
  `checkout`, or anything that writes.
- Every optional layer degrades to "off" silently when its prerequisite is
  absent. No `claude`/`codex` CLI, no `acli`/`gh`, no `.mailmap`, no branches
  beyond `main` — each is a footnote in the report, never an error.

The zero-install property is enforced by a conformance suite
(`test/git-analyze-conformance.test.js`) that runs the real command inside a
sealed sandbox — a temp `HOME`, a minimal `PATH` with a git argv spy, and a
pristine fixture repo with none of the Agentify install footprint — and fails
loudly if any future change adds a write inside the analysed repo, a mutating
git subcommand, or a default-path network call.

## Optional: AI narration

Off by default. With `--ai`, the exact packet that would be sent to a provider is
disclosed before anything leaves your machine; a non-interactive run refuses
without `--yes`. Spend is reported, and a provider failure degrades to the
deterministic report rather than failing the command. A model may phrase and
group the themes; every figure still comes from your git history.

```bash
agentify git analyze --months 3 --ai --provider claude --max-budget-usd 0.25
```

## Optional: issue titles

`--jira auto` enriches issue references with their titles when a tracker CLI
(`acli`) or `gh` is available and authenticated. This is the only path that
touches a network, and only when you ask for it. Without `--jira`, zero network.

## If you want the rest of it

This report needed nothing installed — everything above came from your local git
history. Agentify does more when it is set up: it keeps what you decided and why
across sessions, answers structural questions about the code (who calls this,
what breaks if it changes), shows the blast radius of a change before you finish
it, and runs only the tests a change actually affects.

```bash
agentify install   # only if you want that; git analyze never needed it
```
