import { resolveCavemanLevel } from "../caveman.js";
import { runClean } from "../cleanup.js";
import {
  CONTEXT_MODE_DEFAULT,
  normalizeContextMode,
  toPlannerContextMode,
} from "../context-mode.js";
import { runExec } from "../exec.js";
import { runAfk } from "../afk.js";
import { runIssueKiller } from "../issue-killer.js";
import { buildExecutionPlan, renderPlanExplanation } from "../planner.js";
import {
  buildExecutionPrompt,
  buildMinimalRunPrompt,
  buildNoTaskRunPrompt,
  buildProviderTemplateCommand,
  getExecFlags,
  getProviderTemplateOptions,
  getPromptFromArgs,
  loadAutomaticRunMemory,
  resolveRtkPromptInstruction,
  resolveRunContextMode,
  resolveRunTask,
} from "../run-prompts.js";
import { throwWithIndexGuidance } from "./shared.js";

export async function handlePlan({ root, config, args }) {
  const task = getPromptFromArgs(args, 1);
  const contextMode = normalizeContextMode(args.contextMode, { fallback: CONTEXT_MODE_DEFAULT });
  const includeSource = contextMode !== "routed" || args.withContext === true;
  let plan;
  try {
    plan = await buildExecutionPlan(root, config, task, {
      explain: args.explain === true,
      contextMode: toPlannerContextMode(contextMode),
      includeSource,
    });
  } catch (error) {
    throwWithIndexGuidance(error, root);
  }
  if (args.explain === true && !args.json) {
    process.stdout.write(renderPlanExplanation(plan));
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
}

export async function handleRun({ root, config, args }) {
  const task = resolveRunTask(args, 1);
  const caveman = resolveCavemanLevel(args);
  const usingTemplateCommand = !args._exec?.length;
  const providerOptions = {
    ...getProviderTemplateOptions(args, root, config.provider, usingTemplateCommand),
    continueSession: args.continue === true || args.resume === true,
  };
  const noTaskInteractiveLaunch = !task && usingTemplateCommand && providerOptions.interactive === true;
  if (!task && !noTaskInteractiveLaunch && !args._exec?.length) {
    throw new Error('agentify run requires a task when not launching an interactive provider. Pass one as `agentify run "task"`.');
  }
  const contextMode = resolveRunContextMode(args, config);
  const usesManagedContext = usingTemplateCommand && (
    contextMode === "routed"
    || providerOptions.interactive !== true
    || args.withContext === true
    || args.explainPlan === true
  );
  const includeSource = contextMode !== "routed" || args.withContext === true;
  let memoryContext;
  let plan;
  try {
    memoryContext = noTaskInteractiveLaunch
      ? await loadAutomaticRunMemory(root, "", config)
      : usesManagedContext
      ? await loadAutomaticRunMemory(root, task, config)
      : { markdown: "" };
    plan = usesManagedContext && task
      ? await buildExecutionPlan(root, config, task, {
        contextMode: toPlannerContextMode(contextMode),
        includeSource,
      })
      : null;
  } catch (error) {
    throwWithIndexGuidance(error, root);
  }
  if (args.explainPlan && plan) {
    console.log(JSON.stringify(plan, null, 2));
  }
  const rtkInstruction = usingTemplateCommand
    ? await resolveRtkPromptInstruction(root, config, args, config.provider)
    : "";
  const prompt = noTaskInteractiveLaunch
    ? buildNoTaskRunPrompt(memoryContext.markdown, { caveman, resume: providerOptions.continueSession, rtkInstruction })
    : usesManagedContext
    ? buildExecutionPrompt(plan?.prompt || task, memoryContext.markdown, { caveman, rtkInstruction })
    : !task && args._exec?.length
    ? ""
    : buildMinimalRunPrompt(task, { caveman, rtkInstruction });
  const agentCommand = args._exec?.length
    ? args._exec
    : buildProviderTemplateCommand(
      config.provider,
      prompt,
      providerOptions,
    );

  await runExec(root, config, agentCommand, getExecFlags(args, {
    commandName: "run",
    providerEnvMode: usingTemplateCommand ? "provider" : "generic",
    skipCodeBodyChanges: true,
  }));
}

export async function handleExec({ root, config, args }) {
  const agentCommand = args._exec || [];
  if (agentCommand.length === 0) {
    throw new Error("exec requires a command after --: agentify exec [flags] -- <command...>");
  }
  await runExec(root, config, agentCommand, getExecFlags(args, {
    commandName: "exec",
    providerEnvMode: "generic",
    skipCodeBodyChanges: true,
  }));
}

export async function handleIssueKiller({ root, config, args }) {
  await runIssueKiller(root, config, args);
}

export async function handleAfk({ root, config, args }) {
  await runAfk(root, config, args, { runClean });
}
