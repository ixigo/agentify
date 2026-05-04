---
name: pr-convention-learner
description: >
  Fetches pull request details and review comments from Azure DevOps, resolves reviewer feedback
  by generating code fixes, and extracts recurring patterns into per-repo convention files that
  accumulate over time. Also checks new code against learned conventions before PR creation and
  flags violations. Use this skill whenever the user mentions PR comments, PR review feedback,
  Azure DevOps pull requests, code review patterns, PR conventions, resolving review comments,
  learning from PRs, pre-PR checks, or convention violations. Also trigger when the user says
  things like "what did reviewers say", "fix PR comments", "check my code before PR", "learn
  from this PR", "what patterns do reviewers care about", or references an ADO PR URL or ID.
  Even if they just paste a PR link or say "handle this PR", use this skill.
---

# PR Convention Learner

A skill that closes the feedback loop between PR reviews and future code quality. It does three things:

1. **Fetch & Resolve** — Pull PR threads from Azure DevOps, understand each reviewer comment in context, and generate actionable fixes or responses.
2. **Extract & Accumulate** — Distill recurring reviewer feedback into a per-repo conventions file that grows smarter over time.
3. **Check & Flag** — Before creating a new PR, scan code against the learned conventions and flag violations.

---

## Prerequisites & Auth

The skill needs access to the Azure DevOps REST API (v7.1). Before making any API call, check for credentials in this order:

1. **Environment variable**: `$AZURE_DEVOPS_PAT` — a Personal Access Token with `Code (Read & Write)` scope.
2. **Config file**: `~/.ado-config.json` with structure:
   ```json
   {
     "organization": "your-org",
     "pat": "your-pat-token",
     "default_project": "optional-default-project"
   }
   ```
3. **az CLI**: Check if `az devops` is authenticated (`az account show`).

If none of these exist, tell the user exactly what's needed:

> I need access to your Azure DevOps instance. The easiest way:
>
> 1. Go to `https://dev.azure.com/{your-org}/_usersSettings/tokens`
> 2. Create a PAT with **Code → Read & Write** scope
> 3. Either export it: `export AZURE_DEVOPS_PAT=<token>`
> 4. Or create `~/.ado-config.json` with `{"organization": "...", "pat": "..."}`

The PAT is passed as Basic auth: `Authorization: Basic $(echo -n ":$PAT" | base64)`.

---

## Core Workflows

### 1. Fetch & Resolve PR Comments

**Trigger**: User provides a PR URL, PR ID, or says "fix/resolve/handle PR comments."

**Steps**:

1. **Parse the PR reference** to extract `organization`, `project`, `repository`, and `pullRequestId`. A typical ADO PR URL looks like:
   `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}`

2. **Fetch PR metadata**:
   ```
   GET https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}?api-version=7.1
   ```
   Extract: title, description, source branch, target branch, status, reviewers.

3. **Fetch all threads**:
   ```
   GET https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}/threads?api-version=7.1
   ```

4. **Filter to actionable human comments** — skip threads where:
   - `commentType` is `"system"` (merge attempts, vote updates, reviewer additions)
   - Thread status is `"closed"`, `"wontFix"`, or `"byDesign"`
   - The `properties.CodeReviewThreadType` exists (these are system-generated)

   Keep threads where:
   - `commentType` is `"text"` (human-written)
   - Thread `status` is `"active"` or `"pending"`
   - There is a `threadContext` with file path and line range (inline code comments)

5. **For each actionable thread**, gather context:
   - The file path from `threadContext.filePath`
   - The line range from `threadContext.rightFileStart` / `threadContext.rightFileEnd`
   - Fetch the actual file content around those lines (use the Items API or the local git checkout if available)
   - Read the full comment chain (parent + replies)

6. **Generate a fix or response** for each comment:
   - If it's a code change request → produce a diff/patch
   - If it's a question → draft a clarifying response
   - If it's a style/convention issue → fix the code AND note it for convention extraction
   - Group related comments on the same file together

7. **Present results** as a structured summary: file, line range, reviewer comment, proposed fix, and whether it was flagged as a convention candidate.

### 2. Extract & Accumulate Conventions

**Trigger**: Runs automatically after resolving PR comments (Step 1), or explicitly when user says "learn from this PR" / "extract conventions."

**Convention file location**: `{repo-root}/.conventions/conventions.md`

If the repo is not locally checked out, use: `~/conventions/{org}/{project}/{repo}/conventions.md`

**Steps**:

1. **Analyze all resolved comments** from the PR and identify patterns that are:
   - Repeated across multiple files or PRs (not one-off nits)
   - About code style, architecture, naming, error handling, testing, or API design
   - Generalizable (not specific to a single feature)

2. **Categorize** each convention into one of these buckets:
   - `naming` — variable, function, class, file naming patterns
   - `architecture` — module structure, layering, dependency rules
   - `error-handling` — how errors should be caught, propagated, logged
   - `testing` — test structure, mocking patterns, coverage expectations
   - `style` — formatting, imports, comments, documentation
   - `api-design` — endpoint naming, request/response patterns, versioning
   - `android` — Android-specific: Compose patterns, ViewModel usage, lifecycle
   - `general` — anything that doesn't fit above

3. **Merge with existing conventions** — read the current conventions file, deduplicate, and update. Never remove existing conventions unless the user explicitly asks. When a convention is reinforced (seen again), bump its `confidence` and add the PR reference.

4. **Convention format** in the markdown file:
   ```markdown
   ## [category]

   ### [Short Convention Title]
   - **Rule**: One-sentence description of what to do / not do
   - **Why**: Why reviewers care about this
   - **Example (bad)**: Code snippet showing the violation
   - **Example (good)**: Code snippet showing the correct way
   - **Confidence**: high | medium | low
   - **Source PRs**: PR-123, PR-456
   - **Last seen**: 2026-04-29
   ```

5. **Write the updated file** and show the user what was added/changed.

### 3. Check & Flag Violations (Pre-PR)

**Trigger**: User says "check my code", "pre-PR check", "review against conventions", or is about to create a PR.

**Steps**:

1. **Load the conventions file** for the current repo.
2. **Identify changed files** — use `git diff` against the target branch, or the user-specified file list.
3. **For each changed file**, check against all conventions:
   - Parse the convention rules
   - Scan the diff hunks for violations
   - Be precise: flag specific lines, not whole files
4. **Report violations** with:
   - File and line number
   - Which convention is violated
   - The fix (inline suggestion)
   - Severity: `must-fix` (high confidence convention) vs `consider` (low confidence)
5. **Skip conventions** that don't apply to the file type (e.g., don't check Android conventions in a Python file).

---

## API Reference (Quick)

All endpoints use `api-version=7.1`. Auth header: `Authorization: Basic $(echo -n ":$PAT" | base64)`.

| Action | Method | Endpoint |
|--------|--------|----------|
| PR details | GET | `/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}` |
| List threads | GET | `...pullRequests/{prId}/threads` |
| Thread detail | GET | `...pullRequests/{prId}/threads/{threadId}` |
| PR iterations | GET | `...pullRequests/{prId}/iterations` |
| Iteration changes | GET | `...pullRequests/{prId}/iterations/{iterationId}/changes` |
| File content | GET | `...repositories/{repo}/items?path={filePath}&version={branch}` |
| Commit diffs | GET | `...repositories/{repo}/diffs/commits?baseVersion={base}&targetVersion={target}` |

Base URL: `https://dev.azure.com`

---

## Scripts

The skill bundles helper scripts in `scripts/`:

- **`fetch_pr.sh`** — Fetches PR metadata + all threads, filters to actionable comments, outputs structured JSON.
- **`extract_conventions.sh`** — Reads resolved comments JSON, merges with existing conventions file.
- **`check_conventions.sh`** — Runs pre-PR convention check against a diff.

Run scripts from the skill directory or reference them by absolute path. They handle API calls, JSON parsing, convention file I/O, and diff collection so the main workflow can focus on analysis and fix generation.

---

## Edge Cases

- **PR with no actionable comments**: Report "No open review comments found" and offer to extract conventions from already-resolved threads (useful for historical learning).
- **PR across multiple repos**: Not supported in a single run. Ask the user which repo to focus on.
- **Large PRs (50+ files)**: Process in batches of 10 files. Prioritize files with the most comments.
- **Conflicting conventions**: If a new PR comment contradicts an existing convention, flag it for the user to resolve. Don't auto-overwrite.
- **No local git checkout**: The skill works entirely via the REST API. Local checkout is preferred (faster file access) but not required.
- **Rate limiting**: ADO doesn't have strict published rate limits for authenticated users, but if you hit 429s, add exponential backoff.
