import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getChangedFiles, getChangedFilesSince, getHeadCommit } from "./git.js";
import { runScan, runDoc } from "./commands.js";
import { buildGenericWrappedCommandEnv, buildProviderEnv } from "./provider-env.js";
import { createRunReporter } from "./run-report.js";
import { validateRepo } from "./validate.js";
import {
  finalizeSessionMemoryRun,
  normalizeInteractiveCapture,
  prepareSessionMemoryRun,
  redactSensitiveText,
} from "./session-memory.js";
import { createBoundedCaptureBuffer, DEFAULT_CAPTURE_MAX_KB, normalizeCaptureMaxBytes } from "./capture-buffer.js";
import * as ui from "./ui.js";

const AGENTIFY_EXIT_VALIDATE_FAILED = 80;
const AGENTIFY_EXIT_REFRESH_ERROR = 81;
const FORCE_KILL_TIMEOUT_MS = 5000;
const REFRESH_NEUTRAL_PATH_PATTERNS = [
  /^\.agentify(\/|$)/,
  /^\.current_session(\/|$)/,
  /^docs\/repo-map\.md$/,
  /^docs\/modules(\/|$)/,
  /^output\.txt$/,
  /^agentify-report\.html$/,
  /(^|\/)AGENTIFY\.md$/,
];

function normalizeRepoPath(value) {
  return String(value || "")
    .split(path.sep)
    .join("/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

function isRefreshNeutralPath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  return Boolean(normalized) && REFRESH_NEUTRAL_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isRefreshNeutralChange(file) {
  const paths = [file?.path, file?.origPath].filter(Boolean);
  return paths.length > 0 && paths.every(isRefreshNeutralPath);
}

function getRefreshRelevantChanges(files) {
  return (files || []).filter((file) => !isRefreshNeutralChange(file));
}

function getSnapshotKey(file) {
  return `${file.status}:${file.path}`;
}

function getTrackedDirtyPaths(files) {
  return [...new Set(files.filter((file) => file?.path && file.status !== "??").map((file) => file.path))];
}

async function hashFile(root, filePath) {
  const fullPath = path.join(root, filePath);
  try {
    const stats = await fs.lstat(fullPath);
    if (stats.isSymbolicLink()) {
      return `symlink:${await fs.readlink(fullPath)}`;
    }
    if (!stats.isFile()) {
      return `kind:${stats.mode}`;
    }

    const content = await fs.readFile(fullPath);
    return `file:${createHash("sha1").update(content).digest("hex")}`;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function captureDirtyFileDigests(root, files) {
  const filePaths = getTrackedDirtyPaths(files);
  if (filePaths.length === 0) {
    return new Map();
  }

  const digestEntries = await Promise.all(
    filePaths.map(async (filePath) => [filePath, await hashFile(root, filePath)]),
  );
  return new Map(digestEntries);
}

function diffSnapshots(preFiles, postFiles, preDigests = new Map(), postDigests = new Map()) {
  const preSet = new Set(preFiles.map(getSnapshotKey));
  const changes = [];
  const seen = new Set();

  function recordChange(file) {
    const key = getSnapshotKey(file);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    changes.push(file);
  }

  for (const file of postFiles) {
    const key = getSnapshotKey(file);
    if (!preSet.has(key)) {
      recordChange(file);
      continue;
    }

    if (file.status === "??") {
      continue;
    }

    if (preDigests.get(file.path) !== postDigests.get(file.path)) {
      recordChange(file);
    }
  }

  return changes;
}

function combineChanges(...groups) {
  const seen = new Set();
  const changes = [];
  for (const group of groups) {
    for (const file of group || []) {
      const key = getSnapshotKey(file);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      changes.push(file);
    }
  }
  return changes;
}

function posixShellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function buildScriptCommand(argv, capturePath) {
  const [cmd, ...args] = argv;
  if (process.platform === "darwin") {
    return {
      cmd: "script",
      args: ["-q", capturePath, cmd, ...args],
    };
  }

  return {
    cmd: "script",
    args: ["-q", "-e", "-c", argv.map(posixShellQuote).join(" "), capturePath],
  };
}

function killChildProcess(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between timeout scheduling and signal delivery.
  }
}

async function removeRawInteractiveLog(capturePath, raw) {
  try {
    await fs.rm(capturePath, { force: true });
    return "";
  } catch (removeError) {
    try {
      await fs.writeFile(capturePath, redactSensitiveText(raw), "utf8");
      return `Unable to remove PTY transcript log; redacted it in place instead: ${removeError.message}`;
    } catch (redactError) {
      return `Unable to remove PTY transcript log: ${removeError.message}; unable to redact it in place: ${redactError.message}`;
    }
  }
}

function getCaptureBufferMaxBytes(config) {
  return normalizeCaptureMaxBytes(config?.session?.captureMaxKb, DEFAULT_CAPTURE_MAX_KB);
}

function summarizeProviderCommand(argv) {
  const parts = Array.isArray(argv) ? argv.map(String) : [];
  const executable = parts[0] || null;
  const argc = parts.length;

  return {
    executable,
    argc,
    argv_redacted: true,
    display: executable ? `${executable} [argv redacted; argc=${argc}]` : `[argv redacted; argc=${argc}]`,
  };
}

function summarizeChangedFiles(files) {
  return files.map((file) => ({
    status: file.status,
    path: file.path,
    ...(file.origPath ? { orig_path: file.origPath } : {}),
  }));
}

function normalizeTimeoutMs(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildTimeoutOutcomeFields(source) {
  const timedOut = Boolean(source?.timedOut);
  const timeoutMs = normalizeTimeoutMs(source?.timeoutMs);
  const signal = source?.signal || null;
  return {
    timedOut,
    timeoutMs,
    signal,
    ...(timedOut ? { reason: "timeout" } : {}),
  };
}

function buildTimeoutTelemetryFields(source) {
  const timeout = buildTimeoutOutcomeFields(source);
  return {
    timed_out: timeout.timedOut,
    timeout_ms: timeout.timeoutMs,
    signal: timeout.signal,
    ...(timeout.timedOut ? { reason: "timeout" } : {}),
  };
}

function buildCommandResultOutcomeFields(commandResult) {
  return {
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    interactiveTranscript: commandResult.interactiveTranscript,
    interactiveCaptureError: commandResult.interactiveCaptureError,
    rawInteractiveLogPath: commandResult.rawInteractiveLogPath,
    ...buildTimeoutOutcomeFields(commandResult),
  };
}

function getPostProviderValidationOptions(flags) {
  const providerMayChangeRepoFiles = flags.skipCodeBodyChanges === true;
  return {
    skipCodeBodyChanges: providerMayChangeRepoFiles,
    skipChangedFiles: providerMayChangeRepoFiles,
  };
}

function buildExecutionTelemetry({
  runId,
  startedAt,
  finishedAt,
  durationMs,
  result,
  config,
  agentCommand,
  commandResult,
  agentChanges,
  headChanged,
  flags,
}) {
  const changedFiles = summarizeChangedFiles(agentChanges || []);
  const captureMode =
    commandResult?.captureMode || flags.captureOutputMode || (flags.captureOutput ? "pipe" : "inherit");
  const transcript = commandResult?.interactiveTranscript || result.interactiveTranscript || "";
  const rawLogPath = commandResult?.rawInteractiveLogPath || result.rawInteractiveLogPath || null;

  return {
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    phase: result.phase,
    exit_code: result.exitCode,
    ...buildTimeoutTelemetryFields(commandResult || result),
    skipped_refresh: Boolean(result.skippedRefresh),
    provider: config.provider || null,
    provider_model: config.providerModel || config.provider_model || null,
    provider_command: summarizeProviderCommand(agentCommand),
    capture: {
      mode: flags.sessionRecord?.captureMode || captureMode,
      output_mode: captureMode,
      transcript_available: transcript.length > 0,
      transcript_bytes: Buffer.byteLength(transcript, "utf8"),
      raw_log_available: Boolean(rawLogPath),
      raw_log_path: rawLogPath,
    },
    changed_files_count: changedFiles.length,
    changed_paths: changedFiles.map((file) => file.path),
    changed_files: changedFiles,
    head_changed: Boolean(headChanged),
    session: flags.sessionRecord
      ? {
          session_id: flags.sessionRecord.sessionId || null,
          provider: flags.sessionRecord.provider || null,
          capture_mode: flags.sessionRecord.captureMode || null,
        }
      : null,
  };
}

function runWrappedCommand(argv, options) {
  return new Promise((resolve, reject) => {
    const captureMode = options.captureOutputMode || "inherit";
    const command =
      captureMode === "pty" ? buildScriptCommand(argv, options.capturePath) : { cmd: argv[0], args: argv.slice(1) };
    const stdio =
      captureMode === "pipe"
        ? ["inherit", "pipe", "pipe"]
        : captureMode === "pty" && !process.stdin.isTTY
          ? ["ignore", "inherit", "inherit"]
          : "inherit";
    const stdoutCapture = createBoundedCaptureBuffer(options.captureBufferMaxBytes || 0);
    const stderrCapture = createBoundedCaptureBuffer(options.captureBufferMaxBytes || 0);
    const child = spawn(command.cmd, command.args, {
      cwd: options.cwd,
      stdio,
      env: options.env,
    });

    if (captureMode === "pipe") {
      child.stdout.on("data", (chunk) => {
        stdoutCapture.append(chunk);
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrCapture.append(chunk);
        process.stderr.write(chunk);
      });
    }

    let timer;
    let killTimer;
    let timedOut = false;
    function clearTimers() {
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    }
    if (options.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        killChildProcess(child, "SIGTERM");
        killTimer = setTimeout(() => killChildProcess(child, "SIGKILL"), FORCE_KILL_TIMEOUT_MS);
      }, options.timeout);
    }

    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimers();
      let interactiveTranscript = "";
      let interactiveCaptureError = "";
      if (captureMode === "pty" && options.capturePath) {
        try {
          const raw = await fs.readFile(options.capturePath, "utf8");
          interactiveTranscript = normalizeInteractiveCapture(raw);
          interactiveCaptureError = await removeRawInteractiveLog(options.capturePath, raw);
        } catch (error) {
          interactiveCaptureError = `Unable to read PTY transcript log: ${error.message}`;
        }
      }

      resolve({
        exitCode: code ?? 1,
        timedOut,
        timeoutMs: normalizeTimeoutMs(options.timeout),
        signal: signal || null,
        ...(timedOut ? { reason: "timeout" } : {}),
        stdout: captureMode === "pipe" ? stdoutCapture.toString() : "",
        stderr: captureMode === "pipe" ? stderrCapture.toString() : "",
        interactiveTranscript,
        interactiveCaptureError,
        rawInteractiveLogPath: null,
      });
    });
  });
}

export async function runExec(root, config, agentCommand, flags) {
  const commandName = flags.commandName || "exec";
  const runId = `${Date.now()}-${commandName.replace(/[^a-z0-9_.-]+/gi, "-")}`;
  const startedAt = new Date();
  const startMs = Date.now();
  const progress = flags.reporter || createRunReporter(root);
  progress.setCommand(commandName);
  const commandLabel = flags.providerEnvMode === "generic" ? "wrapped command" : "provider command";
  progress.log(`${commandName}: starting ${commandLabel}`);
  const captureOutputMode = flags.captureOutputMode || (flags.captureOutput ? "pipe" : "inherit");
  const commandEnv =
    flags.providerEnvMode === "generic"
      ? buildGenericWrappedCommandEnv(config.providerEnv)
      : buildProviderEnv(config.providerEnv);

  const preHeadCommit = await getHeadCommit(root);
  const preFiles = await getChangedFiles(root);
  const preFileDigests = await captureDirtyFileDigests(root, preFiles);
  const preparedSessionMemory = flags.sessionRecord
    ? await prepareSessionMemoryRun(root, flags.sessionRecord, config)
    : null;

  let commandResult;
  try {
    if (captureOutputMode !== "pipe") {
      progress.clear?.();
    }
    commandResult = await runWrappedCommand(agentCommand, {
      cwd: root,
      timeout: flags.timeout ? flags.timeout * 1000 : undefined,
      captureOutputMode,
      captureBufferMaxBytes: getCaptureBufferMaxBytes(config),
      capturePath: preparedSessionMemory?.paths.rawInteractiveLogPath || flags.capturePath || null,
      env: commandEnv,
    });
  } catch (error) {
    if (captureOutputMode === "pty" && error?.code === "ENOENT") {
      if (flags.sessionRecord) {
        flags.sessionRecord.captureMode = "interactive-fallback";
      }
      commandResult = await runWrappedCommand(agentCommand, {
        cwd: root,
        timeout: flags.timeout ? flags.timeout * 1000 : undefined,
        captureOutputMode: "inherit",
        captureBufferMaxBytes: getCaptureBufferMaxBytes(config),
        env: commandEnv,
      });
    } else {
      if (preparedSessionMemory) {
        await finalizeSessionMemoryRun(
          root,
          flags.sessionRecord,
          preparedSessionMemory,
          {
            phase: "spawn-error",
            exitCode: 1,
            stderr: error.message,
          },
          config,
        );
      }
      const finishedAt = new Date();
      const result = {
        phase: "spawn-error",
        exitCode: 1,
        stderr: error.message,
        stdout: "",
        interactiveTranscript: "",
        rawInteractiveLogPath: null,
      };
      const executionTelemetry = buildExecutionTelemetry({
        runId,
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
        result,
        config,
        agentCommand,
        commandResult: null,
        agentChanges: [],
        headChanged: false,
        flags,
      });
      progress.setCommand(commandName);
      progress.setExecution(executionTelemetry);
      await progress.finalize();
      throw error;
    }
  }
  let exitCode = commandResult.exitCode || 0;
  const commandFailed = exitCode !== 0;

  const postHeadCommit = await getHeadCommit(root);
  const postFiles = await getChangedFiles(root);
  const postFileDigests = await captureDirtyFileDigests(root, postFiles);
  const headChanged = postHeadCommit !== preHeadCommit;
  const committedChanges =
    headChanged && preHeadCommit !== "nogit" ? await getChangedFilesSince(root, preHeadCommit) : [];
  const agentChanges = combineChanges(
    diffSnapshots(preFiles, postFiles, preFileDigests, postFileDigests),
    committedChanges,
  );
  const refreshRelevantChanges = getRefreshRelevantChanges(agentChanges);

  async function finalizeResult(result) {
    const finishedAt = new Date();
    result.executionTelemetry = buildExecutionTelemetry({
      runId,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startMs,
      result,
      config,
      agentCommand,
      commandResult,
      agentChanges: refreshRelevantChanges,
      headChanged,
      flags,
    });
    progress.setCommand(commandName);
    progress.setExecution(result.executionTelemetry);
    await progress.finalize();
    return result;
  }

  if (flags.skipRefresh) {
    process.exitCode = exitCode;
    const result = {
      phase: commandFailed ? "command" : "complete",
      exitCode,
      skippedRefresh: true,
      ...buildCommandResultOutcomeFields(commandResult),
    };
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
    }
    return finalizeResult(result);
  }
  if (refreshRelevantChanges.length === 0) {
    const validation = await validateRepo(root, config, getPostProviderValidationOptions(flags));
    if (!validation.passed && flags.failOnStale && !commandFailed) {
      exitCode = AGENTIFY_EXIT_VALIDATE_FAILED;
    } else if (!validation.passed) {
      for (const f of validation.failures) {
        process.stderr.write(ui.formatFailure(f) + "\n");
      }
    }
    process.exitCode = exitCode;
    const result = {
      phase: "complete",
      exitCode,
      validation,
      skippedRefresh: true,
      ...buildCommandResultOutcomeFields(commandResult),
    };
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
    }
    progress.setValidation(validation);
    return finalizeResult(result);
  }

  try {
    await runScan(root, config, { reporter: progress, skipFinalize: true });
    await runDoc(root, config, { reporter: progress, skipFinalize: true });
  } catch (error) {
    ui.error(`refresh error: ${error.message}`);
    if (flags.failOnStale && !commandFailed) {
      exitCode = AGENTIFY_EXIT_REFRESH_ERROR;
    }
    process.exitCode = exitCode;
    const commandOutcome = buildCommandResultOutcomeFields(commandResult);
    const result = {
      phase: "refresh-error",
      exitCode,
      ...commandOutcome,
      stderr: `${commandOutcome.stderr}${commandOutcome.stderr ? "\n" : ""}${error.message}`,
    };
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
    }
    return finalizeResult(result);
  }

  const validation = await validateRepo(root, config, getPostProviderValidationOptions(flags));
  progress.setValidation(validation);

  if (!validation.passed) {
    if (flags.failOnStale && !commandFailed) {
      exitCode = AGENTIFY_EXIT_VALIDATE_FAILED;
    } else {
      for (const f of validation.failures) {
        process.stderr.write(ui.formatFailure(f) + "\n");
      }
    }
  }

  process.exitCode = exitCode;
  const result = {
    phase: "complete",
    exitCode,
    validation,
    ...buildCommandResultOutcomeFields(commandResult),
  };
  if (preparedSessionMemory) {
    await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
  }
  return finalizeResult(result);
}
