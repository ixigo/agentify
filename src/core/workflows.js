import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { installBuiltinSkill } from "./skills.js";

const execFileAsync = promisify(execFile);

// Each platform gets a prebuilt agent workflow: triage the board, pick up an
// item, implement it in an isolated worktree, and raise a draft PR/MR — all
// delivered as a skill bundle the agent drives.
export const WORKFLOW_BUNDLES = {
  gh: {
    title: "GitHub",
    cli: "gh",
    aliases: ["github"],
    remoteHosts: ["github.com"],
    skills: ["github-triage", "grill-me", "gh-autopilot", "issue-killer", "worktree-autopilot", "pr-creator", "commit-creator"],
    flow: [
      "github-triage — label-based state machine over the issue board",
      "grill-me — interview the user until a new issue is concrete before filing it",
      "gh-autopilot — resolve issues/PRs/reviews end-to-end with gh",
      "issue-killer — fan opted-in issues out to parallel tmux worktree agents",
      "worktree-autopilot — implement one task in an isolated worktree and verify",
      "pr-creator — open a draft PR with a clean summary",
      "commit-creator — conventional, focused commits",
    ],
  },
  glab: {
    title: "GitLab",
    cli: "glab",
    aliases: ["gitlab"],
    remoteHosts: ["gitlab.com", "gitlab."],
    skills: ["gitlab-triage", "grill-me", "glab-autopilot", "issue-killer", "worktree-autopilot", "pr-creator", "commit-creator"],
    flow: [
      "gitlab-triage — conservative label/state management over the issue board",
      "grill-me — interview the user until a new issue is concrete before filing it",
      "glab-autopilot — resolve issues/MRs/reviews end-to-end with glab",
      "issue-killer — fan opted-in issues out to parallel tmux worktree agents",
      "worktree-autopilot — implement one task in an isolated worktree and verify",
      "pr-creator — open a draft MR with a clean summary",
      "commit-creator — conventional, focused commits",
    ],
  },
  azure: {
    title: "Azure DevOps",
    cli: "az",
    aliases: ["ado", "az", "azure-devops"],
    remoteHosts: ["dev.azure.com", "visualstudio.com"],
    skills: ["azure-devops-triage", "grill-me", "ado-autopilot", "issue-killer", "worktree-autopilot", "pr-convention-learner", "pr-creator", "commit-creator"],
    flow: [
      "azure-devops-triage — inspect and classify Azure Boards work items with az",
      "grill-me — interview the user until a new issue is concrete before filing it",
      "ado-autopilot — resolve work items and Azure Repos PRs end-to-end",
      "issue-killer — fan opted-in work items out to parallel tmux worktree agents",
      "worktree-autopilot — implement one task in an isolated worktree and verify",
      "pr-convention-learner — learn reviewer conventions from past ADO PRs",
      "pr-creator — open a draft PR with a clean summary",
      "commit-creator — conventional, focused commits",
    ],
  },
};

export function normalizeWorkflowName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (WORKFLOW_BUNDLES[name]) {
    return name;
  }
  for (const [key, bundle] of Object.entries(WORKFLOW_BUNDLES)) {
    if (bundle.aliases.includes(name)) {
      return key;
    }
  }
  throw new Error(`Unknown workflow "${value}". Available: ${Object.keys(WORKFLOW_BUNDLES).join(", ")}`);
}

async function defaultCommandExists(command) {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", 'command -v -- "$1"', "sh", command]);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function defaultRemoteUrl(root) {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: root });
    return stdout.trim();
  } catch {
    return "";
  }
}

export function matchWorkflowByRemote(remoteUrl) {
  const url = String(remoteUrl || "").toLowerCase();
  if (!url) {
    return null;
  }
  for (const [key, bundle] of Object.entries(WORKFLOW_BUNDLES)) {
    if (bundle.remoteHosts.some((host) => url.includes(host))) {
      return key;
    }
  }
  return null;
}

export async function detectWorkflow(root, runtime = {}) {
  const remoteUrl = await (runtime.remoteUrl ? runtime.remoteUrl(root) : defaultRemoteUrl(root));
  return {
    remote_url: remoteUrl || null,
    workflow: matchWorkflowByRemote(remoteUrl),
  };
}

export async function describeWorkflows(root, runtime = {}) {
  const commandExists = runtime.commandExists || defaultCommandExists;
  const detection = await detectWorkflow(root, runtime);

  const workflows = [];
  for (const [name, bundle] of Object.entries(WORKFLOW_BUNDLES)) {
    workflows.push({
      name,
      title: bundle.title,
      cli: bundle.cli,
      cli_available: await commandExists(bundle.cli),
      detected: detection.workflow === name,
      skills: bundle.skills,
      flow: bundle.flow,
    });
  }

  return {
    command: "workflow",
    detected: detection.workflow,
    remote_url: detection.remote_url,
    workflows,
  };
}

export async function installWorkflow(root, nameInput, options = {}) {
  let name;
  if (nameInput) {
    name = normalizeWorkflowName(nameInput);
  } else {
    const detection = await detectWorkflow(root, options.runtime || {});
    if (!detection.workflow) {
      throw new Error(
        `Could not detect a platform from the git remote (${detection.remote_url || "none"}). Pass one explicitly: agentify workflow install <gh|glab|azure>`,
      );
    }
    name = detection.workflow;
  }

  const bundle = WORKFLOW_BUNDLES[name];
  const commandExists = options.runtime?.commandExists || defaultCommandExists;
  const cliAvailable = await commandExists(bundle.cli);
  const installSkill = options.runtime?.installSkill || installBuiltinSkill;

  const results = [];
  for (const skillName of bundle.skills) {
    const result = await installSkill(root, {
      name: skillName,
      provider: options.provider,
      scope: options.scope,
      force: options.force,
      dryRun: options.dryRun,
      defaultProvider: options.defaultProvider,
    });
    results.push({
      skill: result.skill?.name || skillName,
      results: result.results,
    });
  }

  return {
    command: "workflow install",
    workflow: name,
    title: bundle.title,
    cli: bundle.cli,
    cli_available: cliAvailable,
    ...(cliAvailable ? {} : { cli_hint: `Install the ${bundle.cli} CLI to use this workflow.` }),
    dry_run: options.dryRun === true,
    skills: results,
    flow: bundle.flow,
  };
}
