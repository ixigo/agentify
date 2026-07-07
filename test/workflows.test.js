import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_BUNDLES,
  describeWorkflows,
  installWorkflow,
  matchWorkflowByRemote,
  normalizeWorkflowName,
} from "../src/core/workflows.js";

test("normalizeWorkflowName resolves names and aliases, rejects unknown", () => {
  assert.equal(normalizeWorkflowName("gh"), "gh");
  assert.equal(normalizeWorkflowName("GitHub"), "gh");
  assert.equal(normalizeWorkflowName("gitlab"), "glab");
  assert.equal(normalizeWorkflowName("ado"), "azure");
  assert.equal(normalizeWorkflowName("az"), "azure");
  assert.throws(() => normalizeWorkflowName("bitbucket"), /Unknown workflow/);
});

test("matchWorkflowByRemote detects platforms from remote URLs", () => {
  assert.equal(matchWorkflowByRemote("https://github.com/ixigo/agentify.git"), "gh");
  assert.equal(matchWorkflowByRemote("git@gitlab.com:group/proj.git"), "glab");
  assert.equal(matchWorkflowByRemote("https://gitlab.internal.corp/group/proj.git"), "glab");
  assert.equal(matchWorkflowByRemote("https://dev.azure.com/org/project/_git/repo"), "azure");
  assert.equal(matchWorkflowByRemote("https://org.visualstudio.com/project/_git/repo"), "azure");
  assert.equal(matchWorkflowByRemote("https://bitbucket.org/team/repo.git"), null);
  assert.equal(matchWorkflowByRemote(""), null);
});

test("every bundle skill exists in the built-in skill registry", async () => {
  const { listBuiltinSkills } = await import("../src/core/skills.js");
  const registered = new Set(listBuiltinSkills().flatMap((skill) => [skill.name, ...skill.aliases]));
  for (const [name, bundle] of Object.entries(WORKFLOW_BUNDLES)) {
    for (const skillName of bundle.skills) {
      assert.ok(registered.has(skillName), `workflow ${name} references unregistered skill ${skillName}`);
    }
    assert.equal(bundle.flow.length >= bundle.skills.length - 1, true, `workflow ${name} flow should describe its skills`);
  }
});

test("describeWorkflows reports detection and CLI availability", async () => {
  const described = await describeWorkflows("/repo", {
    remoteUrl: async () => "git@gitlab.com:group/proj.git",
    commandExists: async (command) => command === "glab",
  });
  assert.equal(described.detected, "glab");
  const glab = described.workflows.find((workflow) => workflow.name === "glab");
  assert.equal(glab.detected, true);
  assert.equal(glab.cli_available, true);
  const gh = described.workflows.find((workflow) => workflow.name === "gh");
  assert.equal(gh.detected, false);
  assert.equal(gh.cli_available, false);
});

test("installWorkflow installs every skill in the bundle via the injected installer", async () => {
  const installed = [];
  const result = await installWorkflow("/repo", "azure", {
    provider: "claude",
    scope: "project",
    runtime: {
      commandExists: async () => true,
      installSkill: async (root, options) => {
        installed.push(options.name);
        return { skill: { name: options.name }, results: [{ provider: "claude", status: "installed", target_dir: ".claude/skills" }] };
      },
    },
  });
  assert.equal(result.workflow, "azure");
  assert.deepEqual(installed, WORKFLOW_BUNDLES.azure.skills);
  assert.equal(result.cli_available, true);
});

test("installWorkflow auto-detects from the remote and errors when unknown", async () => {
  const installed = [];
  const result = await installWorkflow("/repo", null, {
    runtime: {
      remoteUrl: async () => "https://github.com/org/repo.git",
      commandExists: async () => true,
      installSkill: async (root, options) => {
        installed.push(options.name);
        return { skill: { name: options.name }, results: [] };
      },
    },
  });
  assert.equal(result.workflow, "gh");
  assert.deepEqual(installed, WORKFLOW_BUNDLES.gh.skills);

  await assert.rejects(
    () => installWorkflow("/repo", null, {
      runtime: { remoteUrl: async () => "https://bitbucket.org/x/y.git" },
    }),
    /Could not detect a platform/
  );
});
