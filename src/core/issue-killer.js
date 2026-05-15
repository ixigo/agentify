import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildProviderTemplateCommand } from "./provider-command.js";
import * as ui from "./ui.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_ISSUE_PROVIDERS = ["github"];
const FUTURE_ISSUE_PROVIDERS = ["gitlab", "azure-devops"];
const SUPPORTED_AGENT_PROVIDERS = ["codex", "claude"];
const DEFAULT_LABEL = "agentify-ready";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_SESSION_NAME = "gh-issue-killer";

function splitCsv(value) {
  if (value === undefined || value === null || value === false) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(splitCsv);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLimit(value, defaultLimit = DEFAULT_LIMIT) {
  const limit = value === undefined || value === null || value === true
    ? defaultLimit
    : Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  if (limit > MAX_LIMIT) {
    throw new Error(`--limit cannot exceed ${MAX_LIMIT} for supervised v1 runs.`);
  }
  return limit;
}

function normalizeIssueProvider(value) {
  const provider = String(value || "github").trim().toLowerCase();
  if (SUPPORTED_ISSUE_PROVIDERS.includes(provider)) {
    return provider;
  }
  if (FUTURE_ISSUE_PROVIDERS.includes(provider)) {
    throw new Error(`issue provider "${provider}" is not supported in v1. Use --issue-provider github.`);
  }
  throw new Error(`unsupported issue provider "${provider}". Supported issue providers: github`);
}

function normalizeAgentProvider(value, config) {
  const raw = value === undefined || value === null || value === false || value === true
    ? config.provider
    : value;
  const provider = String(raw || "codex").trim().toLowerCase();
  if (SUPPORTED_AGENT_PROVIDERS.includes(provider)) {
    return provider;
  }
  throw new Error(`unsupported agent provider "${provider}". Supported agent providers: codex, claude`);
}

function normalizeBranchPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 70)
    .replace(/^[-/.]+|[-/.]+$/g, "");
}

function parseGitHubIssueUrl(url) {
  const match = String(url).match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/);
  if (!match) {
    throw new Error(`unsupported GitHub issue URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    repoFullName: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function argvToShell(argv) {
  return argv.map(shellQuote).join(" ");
}

async function execText(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout.trim();
}

async function execJson(command, args, options = {}) {
  const text = await execText(command, args, options);
  return text ? JSON.parse(text) : null;
}

async function commandExists(command) {
  try {
    await execFileAsync("sh", ["-lc", "command -v -- \"$0\"", command]);
    return true;
  } catch {
    return false;
  }
}

async function requireCommand(command, purpose) {
  if (!(await commandExists(command))) {
    throw new Error(`missing required command "${command}" (${purpose}).`);
  }
}

async function preflight(root, options) {
  await requireCommand("git", "repository inspection");
  await requireCommand("gh", "GitHub issue and PR workflow");

  await execText("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  await execText("gh", ["auth", "status"], { cwd: root });

  if (!options.dryRun) {
    await requireCommand("wt", "Worktrunk worktree creation");
    await requireCommand("tmux", "supervised pane orchestration");
    await requireCommand(options.agentProvider, `${options.agentProvider} agent provider`);
  }
}

async function resolveGitHubRepo(root, explicitRepo) {
  if (explicitRepo && explicitRepo !== true) {
    return String(explicitRepo).trim();
  }
  const repo = await execJson("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: root });
  if (!repo?.nameWithOwner) {
    throw new Error("could not resolve GitHub repository. Pass --repo owner/name.");
  }
  return repo.nameWithOwner;
}

function normalizeIssue(raw, fallbackRepo) {
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
    : [];
  return {
    number: Number(raw.number),
    title: String(raw.title || `issue-${raw.number}`),
    url: String(raw.url || ""),
    state: String(raw.state || "OPEN").toLowerCase(),
    labels,
    repo: fallbackRepo,
  };
}

async function loadExplicitGitHubIssues(root, urls) {
  const issues = [];
  for (const url of urls) {
    const parsed = parseGitHubIssueUrl(url);
    const raw = await execJson("gh", [
      "issue",
      "view",
      url,
      "--json",
      "number,title,url,state,labels",
    ], { cwd: root });
    issues.push(normalizeIssue(raw || parsed, parsed.repoFullName));
  }
  return issues;
}

async function listLabelledGitHubIssues(root, { repo, label, limit }) {
  const raw = await execJson("gh", [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--label",
    label,
    "--limit",
    String(limit),
    "--json",
    "number,title,url,state,labels",
  ], { cwd: root });
  return (Array.isArray(raw) ? raw : []).map((issue) => normalizeIssue(issue, repo));
}

function selectIssues(issues, limit, allowPartial) {
  const openIssues = issues.filter((issue) => issue.state !== "closed");
  if (openIssues.length === 0) {
    throw new Error("no open GitHub issues were selected.");
  }
  if (openIssues.length < limit && !allowPartial) {
    throw new Error(`selected ${openIssues.length} issue(s), but --limit is ${limit}. Pass --allow-partial to launch fewer panes.`);
  }
  return openIssues.slice(0, limit);
}

async function loadIssues(root, options) {
  if (options.issueUrls.length > 0) {
    return selectIssues(await loadExplicitGitHubIssues(root, options.issueUrls), options.limit, options.allowPartial);
  }

  const repo = await resolveGitHubRepo(root, options.repo);
  const issues = await listLabelledGitHubIssues(root, {
    repo,
    label: options.label,
    limit: options.limit,
  });
  return selectIssues(issues, options.limit, options.allowPartial);
}

function createBranchName(issue, branchPrefix) {
  const prefix = normalizeBranchPart(branchPrefix || "issue") || "issue";
  const slug = normalizeBranchPart(issue.title)
    .replaceAll("/", "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "") || `issue-${issue.number}`;
  return `${prefix}/${issue.number}-${slug}`;
}

async function getWorktreePathForBranch(root, branch) {
  const output = await execText("git", ["worktree", "list", "--porcelain"], { cwd: root });
  let currentPath = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line === `branch refs/heads/${branch}` && currentPath) {
      return currentPath;
    }
  }
  throw new Error(`could not locate worktree path for branch ${branch}`);
}

async function createWorktree(root, assignment, options) {
  try {
    return await getWorktreePathForBranch(root, assignment.branch);
  } catch {
    // No existing worktree for this branch; create one below.
  }

  const args = ["-C", root, "switch", "--create", "--yes"];
  if (options.base && options.base !== true) {
    args.push("--base", String(options.base));
  }
  args.push("--no-cd", assignment.branch);
  await execText("wt", args, { cwd: root });
  return getWorktreePathForBranch(root, assignment.branch);
}

function buildIssuePrompt(issue, assignment, options = {}) {
  const permissionRules = options.bypassPermissions
    ? [
        "- WARNING: YOLO mode is enabled. Agentify launched this provider with permission prompts bypassed for this issue-killer pane.",
        "- Keep command side effects limited to this assigned issue and this isolated worktree.",
        "- Do not ask for permission before running task-related shell, git, gh, package-manager, test, commit, push, or draft PR commands.",
      ]
    : [
        "- Respect provider permission prompts and sandbox approvals; do not assume side-effecting commands are pre-approved.",
        "- Keep task-related shell, git, gh, package-manager, test, commit, push, or draft PR commands scoped to this assigned issue.",
      ];

  return [
    "You are working in an Agentify issue-killer tmux pane.",
    "",
    `Assigned GitHub issue: ${issue.url}`,
    `Branch: ${assignment.branch}`,
    `Worktree: ${assignment.worktreePath}`,
    "",
    "Rules:",
    "- Solve exactly this issue and do not pick up other issues.",
    "- Keep changes scoped, minimal, and production-ready.",
    "- You are running in an isolated issue-killer worktree.",
    ...permissionRules,
    "- Run the relevant tests and checks for the touched area.",
    "- Commit with a clear Conventional Commit message.",
    "- Push the branch with upstream tracking.",
    "- Create a draft pull request with gh pr create --draft and link the issue in the PR body.",
    "- Do not force-push, rewrite unrelated history, or weaken tests to pass checks.",
    "- If blocked, leave a concise blocker note in this pane and do not create a misleading PR.",
  ].join("\n");
}

function buildPaneCommand(assignment, options) {
  const prompt = buildIssuePrompt(assignment.issue, assignment, options);
  const argv = buildProviderTemplateCommand(options.agentProvider, prompt, {
    root: assignment.worktreePath,
    interactive: true,
    bypassPermissions: options.bypassPermissions,
  });
  return argvToShell(argv);
}

async function tmuxSessionExists(name) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

async function splitOrCreateWindow(session, windowTarget, shellArgs, assignment) {
  try {
    await execFileAsync("tmux", [
      "split-window",
      "-t",
      windowTarget,
      "-c",
      assignment.worktreePath,
      ...shellArgs,
    ]);
  } catch (error) {
    const output = `${error?.stdout || ""}\n${error?.stderr || ""}`;
    if (!output.includes("no space for new pane")) {
      throw error;
    }

    await execFileAsync("tmux", [
      "new-window",
      "-d",
      "-t",
      `${session}:`,
      "-n",
      `issue-${assignment.issue.number}`,
      "-c",
      assignment.worktreePath,
      ...shellArgs,
    ]);
  }
}

async function launchTmux(assignments, options) {
  const shell = process.env.SHELL || "sh";
  const session = options.sessionName;
  const windowTarget = `${session}:`;
  const exists = await tmuxSessionExists(session);
  if (exists && !options.reuseSession) {
    throw new Error(`tmux session "${session}" already exists. Pass --reuse-session or choose --session-name.`);
  }

  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index];
    const paneCommand = buildPaneCommand(assignment, options);
    const shellArgs = [shell, "-lc", `exec ${paneCommand}`];

    if (index === 0 && !exists) {
      await execFileAsync("tmux", [
        "new-session",
        "-d",
        "-s",
        session,
        "-n",
        `issue-${assignment.issue.number}`,
        "-c",
        assignment.worktreePath,
        ...shellArgs,
      ]);
    } else {
      await splitOrCreateWindow(session, windowTarget, shellArgs, assignment);
    }
  }

  if (assignments.length > 1) {
    await execFileAsync("tmux", ["select-layout", "-t", windowTarget, "tiled"]);
  }
}

function normalizeOptions(args, config) {
  const issueUrls = [
    ...splitCsv(args.issueUrl),
    ...splitCsv(args.issueUrls),
  ];
  const issueProvider = normalizeIssueProvider(args.issueProvider);
  const agentProvider = normalizeAgentProvider(args.agentProvider || args.provider, config);
  const defaultLimit = issueUrls.length > 0 ? issueUrls.length : DEFAULT_LIMIT;
  const limit = normalizeLimit(args.limit, defaultLimit);
  const label = String(args.label === undefined || args.label === true ? DEFAULT_LABEL : args.label).trim();

  if (!label && issueUrls.length === 0) {
    throw new Error("issue-killer requires --label <name> or --issue-url <url>[,<url>].");
  }

  return {
    issueProvider,
    agentProvider,
    issueUrls,
    label,
    limit,
    allowPartial: Boolean(args.allowPartial),
    repo: args.repo,
    branchPrefix: args.branchPrefix || "issue",
    base: args.base,
    sessionName: String(args.sessionName === undefined || args.sessionName === true ? DEFAULT_SESSION_NAME : args.sessionName).trim(),
    reuseSession: Boolean(args.reuseSession),
    bypassPermissions: args.bypassPermissions === true,
    dryRun: Boolean(config.dryRun),
  };
}

function createAssignments(issues, options) {
  return issues.map((issue) => ({
    issue,
    branch: createBranchName(issue, options.branchPrefix),
    worktreePath: null,
    paneCommand: null,
  }));
}

function renderSummary(result) {
  ui.success(`Prepared ${result.assignments.length} issue-killer pane(s).`);
  ui.log(`tmux session: ${ui.bold(result.session_name)}`);
  ui.log(`provider permission bypass: ${ui.bold(result.provider_permission_bypass ? "enabled" : "disabled")}`);
  ui.log(`attach: ${ui.bold(`tmux attach -t ${result.session_name}`)}`);
  for (const assignment of result.assignments) {
    ui.log(`#${assignment.issue.number} ${assignment.branch}`);
    ui.log(`issue: ${assignment.issue.url}`);
    ui.log(`worktree: ${assignment.worktree_path || "(dry-run)"}`);
  }
}

export async function runIssueKiller(root, config, args = {}) {
  const options = normalizeOptions(args, config);
  await preflight(root, options);

  const issues = await loadIssues(root, options);
  const assignments = createAssignments(issues, options);

  if (!options.dryRun) {
    for (const assignment of assignments) {
      assignment.worktreePath = await createWorktree(root, assignment, options);
      assignment.paneCommand = buildPaneCommand(assignment, options);
    }
    await launchTmux(assignments, options);
  }

  const result = {
    command: "issue-killer",
    issue_provider: options.issueProvider,
    agent_provider: options.agentProvider,
    provider_permission_bypass: options.bypassPermissions,
    session_name: options.sessionName,
    dry_run: options.dryRun,
    attach_command: `tmux attach -t ${options.sessionName}`,
    assignments: assignments.map((assignment) => ({
      issue: assignment.issue,
      branch: assignment.branch,
      worktree_path: assignment.worktreePath,
      pane_command: assignment.paneCommand,
    })),
  };

  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    renderSummary(result);
  }

  return result;
}
