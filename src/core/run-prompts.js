import { applyCavemanPreamble, resolveCavemanLevel } from "./caveman.js";
import { persistProviderPreference } from "./config.js";
import { buildRoutedPrompt, normalizeContextMode as normalizeSessionContextMode } from "./context.js";
import {
  CONTEXT_MODE_DEFAULT,
  normalizeContextMode,
} from "./context-mode.js";
import { buildProviderTemplateCommand, SUPPORTED_PROVIDERS, assertSupportedProvider } from "./provider-command.js";
import { buildRtkProviderInstruction, detectRtk, formatRtkUnavailableMessage, resolveRtkConfig } from "./rtk.js";
import { maybePrepareChildSession, resolveSessionProvider, validateSessionId } from "./session.js";
import { loadAutomaticRunMemory, loadAutomaticSessionMemory } from "./session-memory.js";
import { dim, success, log } from "./ui.js";
import { hasOwn } from "./cli-args.js";

const DEFAULT_SESSION_TASK = "Continue this session from the latest repository state.";
const NO_TASK_PROVIDER_INSTRUCTION = "No task was provided. Do not infer a task or continue prior work. Use this context only to orient yourself, then ask the user what task they want to work on before making changes.";
const RESUME_PROVIDER_INSTRUCTION = "Resume mode is active. Use the previous provider or Agentify session context for continuity. If the next step is unclear, ask the user what to do next before making changes.";

function isProviderStickyCommand(command, subcommand) {
  return command === "run" || command === "exec" || (command === "sess" && ["run", "resume", "fork"].includes(subcommand || ""));
}

export function normalizeProvider(value) {
  const provider = String(value || "").trim();
  if (!provider || provider === "true") {
    throw new Error(`--provider requires a value. Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`);
  }
  assertSupportedProvider(provider);
  return provider;
}

export async function maybePersistProvider(root, config, args, command, subcommand) {
  if (command === "skill" || command === "skills") {
    return;
  }

  if (!hasOwn(args, "provider")) {
    return;
  }

  const provider = normalizeProvider(args.provider);
  config.provider = provider;

  if (isProviderStickyCommand(command, subcommand)) {
    await persistProviderPreference(root, provider, { dryRun: config.dryRun });
  }
}

export function getExecFlags(args, extras = {}) {
  return {
    failOnStale: args.failOnStale || false,
    timeout: args.timeout || null,
    skipRefresh: args.skipRefresh || false,
    skipCodeBodyChanges: args.hook === true,
    ...extras,
  };
}

export function getProviderTemplateOptions(args, root, provider, usingTemplateCommand) {
  const interactiveByDefault = usingTemplateCommand;
  const interactive = hasOwn(args, "interactive") ? args.interactive === true : interactiveByDefault;

  return {
    root,
    interactive,
  };
}

export function getSessionCaptureSettings(usingTemplateCommand, providerOptions) {
  if (!usingTemplateCommand) {
    return {
      captureOutputMode: "inherit",
      captureMode: "interactive-inherit",
    };
  }

  return providerOptions.interactive
    ? {
      captureOutputMode: "pty",
      captureMode: "interactive-pty",
    }
    : {
      captureOutputMode: "pipe",
      captureMode: "captured-pipe",
    };
}

export function getPromptFromArgs(args, startIndex) {
  return args._.slice(startIndex).join(" ").trim();
}

function buildRunPrompt(userPrompt) {
  return String(userPrompt || "").trim();
}

export function resolveRunTask(args, startIndex) {
  return buildRunPrompt(getPromptFromArgs(args, startIndex));
}

export function resolveRunContextMode(args = {}, config = {}) {
  return normalizeContextMode(
    hasOwn(args, "contextMode") ? args.contextMode : config?.context?.mode,
    { fallback: CONTEXT_MODE_DEFAULT },
  );
}

function buildRoutedExecutionPrompt(task, memoryMarkdown = "", options = {}) {
  return applyCavemanPreamble([buildRoutedPrompt(task, memoryMarkdown), options.rtkInstruction].filter(Boolean).join("\n\n"), options.caveman, { promptKind: options.promptKind });
}

export function buildExecutionPrompt(basePrompt, memoryMarkdown = "", options = {}) {
  const prompt = String(basePrompt || "").trim();
  const promptWithMemory = [memoryMarkdown.trim(), prompt, options.rtkInstruction].filter(Boolean).join("\n\n");
  return applyCavemanPreamble(promptWithMemory, options.caveman, { promptKind: options.promptKind });
}

export function buildMinimalRunPrompt(userPrompt, options = {}) {
  const task = buildRunPrompt(userPrompt);
  if (!task) {
    throw new Error("buildMinimalRunPrompt requires a non-empty task");
  }
  const prompt = [
    "You are running inside an Agentify-prepared repository.",
    "Follow the user's task. Load repo docs or installed skills only when they are needed or explicitly invoked.",
    "",
    `Task: ${task}`,
  ];
  if (options.rtkInstruction) {
    prompt.push("", options.rtkInstruction);
  }
  const promptText = prompt.join("\n");
  return applyCavemanPreamble(promptText, options.caveman, { promptKind: options.promptKind });
}

export function buildNoTaskRunPrompt(memoryMarkdown = "", options = {}) {
  const instruction = options.resume ? RESUME_PROVIDER_INSTRUCTION : NO_TASK_PROVIDER_INSTRUCTION;
  const sections = [
    "You are running inside an Agentify-prepared repository.",
    "Load repo docs or installed skills only when they are needed or explicitly invoked.",
  ];
  if (memoryMarkdown.trim()) {
    sections.push("", memoryMarkdown.trim());
  }
  if (options.rtkInstruction) {
    sections.push("", options.rtkInstruction);
  }
  sections.push("", instruction);
  return applyCavemanPreamble(sections.join("\n"), options.caveman, { promptKind: options.promptKind });
}

export function buildSessionPrompt(bootstrap, userPrompt, memoryMarkdown = "", options = {}) {
  const task = buildRunPrompt(userPrompt);
  const sections = [
    "You are continuing an Agentify session.",
    "",
    bootstrap.trim(),
  ];
  if (memoryMarkdown.trim()) {
    sections.push("", memoryMarkdown.trim());
  }
  if (options.rtkInstruction) {
    sections.push("", options.rtkInstruction);
  }
  if (task) {
    sections.push("", `Current task: ${task}`);
  } else {
    sections.push("", options.resume ? RESUME_PROVIDER_INSTRUCTION : NO_TASK_PROVIDER_INSTRUCTION);
  }
  return applyCavemanPreamble(sections.join("\n"), options.caveman, { promptKind: options.promptKind });
}

export async function resolveRtkPromptInstruction(root, config, args, provider) {
  const rtkConfig = resolveRtkConfig(config, args);
  if (!rtkConfig.providerInstruction) {
    return "";
  }
  const detection = await detectRtk(rtkConfig.command, { cwd: root });
  if (!detection.verified) {
    if (rtkConfig.explicit) {
      throw new Error(formatRtkUnavailableMessage(detection));
    }
    return "";
  }
  return buildRtkProviderInstruction(provider, detection);
}

export async function prepareSessionLaunch(root, config, args, sessionResult, task) {
  const memoryQuery = task || sessionResult.manifest.name || "";
  const memoryContext = await loadAutomaticSessionMemory(root, sessionResult.manifest, config, memoryQuery);
  const caveman = resolveCavemanLevel(args);
  const provider = hasOwn(args, "provider")
    ? normalizeProvider(args.provider)
    : normalizeProvider(resolveSessionProvider(sessionResult.manifest, config.provider));
  const usingTemplateCommand = !args._exec?.length;
  const providerOptions = getProviderTemplateOptions(args, root, provider, usingTemplateCommand);
  const captureSettings = getSessionCaptureSettings(usingTemplateCommand, providerOptions);
  const contextMode = normalizeSessionContextMode(hasOwn(args, "contextMode") ? args.contextMode : CONTEXT_MODE_DEFAULT);
  const subcommand = args._?.[1] || "run";
  const resumeMode = subcommand === "resume" || args.resume === true;
  const rtkInstruction = usingTemplateCommand
    ? await resolveRtkPromptInstruction(root, config, args, provider)
    : "";
  const sessionInstruction = task
    || (resumeMode ? DEFAULT_SESSION_TASK : NO_TASK_PROVIDER_INSTRUCTION);
  const prompt = contextMode === "routed"
    ? buildRoutedExecutionPrompt(`${sessionInstruction}\n\nSession bootstrap:\n${sessionResult.bootstrap.trim()}`, memoryContext.markdown, { caveman, rtkInstruction })
    : buildSessionPrompt(sessionResult.bootstrap, task, memoryContext.markdown, { caveman, resume: resumeMode, rtkInstruction });
  const agentCommand = args._exec?.length
    ? args._exec
    : buildProviderTemplateCommand(
      provider,
      prompt,
      providerOptions,
    );
  const sessionRecord = {
    sessionId: sessionResult.manifest.session_id,
    provider,
    prompt,
    task: task || (resumeMode ? DEFAULT_SESSION_TASK : ""),
    command: agentCommand,
    memoryContext,
    captureMode: captureSettings.captureMode,
    contextMode,
  };

  return {
    provider,
    memoryContext,
    prompt,
    captureSettings,
    agentCommand,
    sessionRecord,
    runExecConfig: { ...config, provider },
    runExecFlags: getExecFlags(args, {
      captureOutputMode: captureSettings.captureOutputMode,
      sessionRecord,
      commandName: `sess ${args._?.[1] || "run"}`,
      providerEnvMode: usingTemplateCommand ? "provider" : "generic",
      skipCodeBodyChanges: true,
    }),
  };
}

export function resolveSessionIdForResume(args) {
  if (args.session) {
    return { sessionId: validateSessionId(String(args.session), "--session id"), promptStartIndex: 2 };
  }
  const positional = args._[2];
  if (positional) {
    return { sessionId: validateSessionId(String(positional), "session id"), promptStartIndex: 3 };
  }
  throw new Error("sess resume requires --session <id> or sess resume <id>");
}

export async function maybePrintPreparedChild(root, config, launch) {
  const child = await maybePrepareChildSession(root, config, launch.sessionRecord.sessionId, {
    provider: launch.provider,
  });
  if (child && !config.json) {
    success(`Prepared child session: ${child.child_session_id}`);
    log(`Resume: ${dim(child.resume_command)}`);
  }
  return child;
}

export { buildProviderTemplateCommand, loadAutomaticRunMemory, resolveCavemanLevel };
