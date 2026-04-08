import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { getChangedFiles, getHeadCommit } from "./git.js";
import { runScan, runDoc } from "./commands.js";
import { validateRepo } from "./validate.js";
import { finalizeSessionMemoryRun, normalizeInteractiveCapture, prepareSessionMemoryRun } from "./session-memory.js";
import * as ui from "./ui.js";

const AGENTIFY_EXIT_VALIDATE_FAILED = 80;
const AGENTIFY_EXIT_REFRESH_ERROR = 81;
const DEFAULT_CAPTURE_MAX_KB = 48;

function diffSnapshots(preFiles, postFiles) {
  const preSet = new Set(preFiles.map((f) => `${f.status}:${f.path}`));
  return postFiles.filter((f) => !preSet.has(`${f.status}:${f.path}`));
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

function getCaptureBufferMaxBytes(config) {
  const maxKb = Number(config?.session?.captureMaxKb);
  const normalizedKb = Number.isFinite(maxKb) && maxKb > 0 ? maxKb : DEFAULT_CAPTURE_MAX_KB;
  return normalizedKb * 1024;
}

function createBoundedCaptureBuffer(maxBytes) {
  const chunks = [];
  let totalBytes = 0;

  return {
    append(chunk) {
      if (maxBytes <= 0 || totalBytes >= maxBytes || !chunk?.length) {
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - totalBytes;
      const slice = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
      chunks.push(Buffer.from(slice));
      totalBytes += slice.length;
    },
    toString() {
      return totalBytes > 0 ? Buffer.concat(chunks, totalBytes).toString("utf8") : "";
    },
  };
}

function runWrappedCommand(argv, options) {
  return new Promise((resolve, reject) => {
    const captureMode = options.captureOutputMode || "inherit";
    const command = captureMode === "pty"
      ? buildScriptCommand(argv, options.capturePath)
      : { cmd: argv[0], args: argv.slice(1) };
    const stdio = captureMode === "pipe"
      ? ["inherit", "pipe", "pipe"]
      : captureMode === "pty" && !process.stdin.isTTY
        ? ["ignore", "inherit", "inherit"]
        : "inherit";
    const stdoutCapture = createBoundedCaptureBuffer(options.captureBufferMaxBytes || 0);
    const stderrCapture = createBoundedCaptureBuffer(options.captureBufferMaxBytes || 0);
    const child = spawn(command.cmd, command.args, {
      cwd: options.cwd,
      stdio,
      env: process.env,
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
    if (options.timeout) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, options.timeout);
    }

    child.on("error", reject);
    child.on("close", async (code) => {
      if (timer) clearTimeout(timer);
      try {
        let interactiveTranscript = "";
        if (captureMode === "pty" && options.capturePath) {
          const raw = await fs.readFile(options.capturePath, "utf8");
          interactiveTranscript = normalizeInteractiveCapture(raw);
        }

        resolve({
          exitCode: code ?? 1,
          stdout: captureMode === "pipe" ? stdoutCapture.toString() : "",
          stderr: captureMode === "pipe" ? stderrCapture.toString() : "",
          interactiveTranscript,
          rawInteractiveLogPath: captureMode === "pty" ? options.capturePath : null,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function runExec(root, config, agentCommand, flags) {
  const preHeadCommit = await getHeadCommit(root);
  const preFiles = await getChangedFiles(root);
  const preparedSessionMemory = flags.sessionRecord
    ? await prepareSessionMemoryRun(root, flags.sessionRecord)
    : null;

  let commandResult;
  try {
    commandResult = await runWrappedCommand(agentCommand, {
      cwd: root,
      timeout: flags.timeout ? flags.timeout * 1000 : undefined,
      captureOutputMode: flags.captureOutputMode || (flags.captureOutput ? "pipe" : "inherit"),
      captureBufferMaxBytes: getCaptureBufferMaxBytes(config),
      capturePath: preparedSessionMemory?.paths.rawInteractiveLogPath || null,
    });
  } catch (error) {
    if (flags.captureOutputMode === "pty" && error?.code === "ENOENT") {
      if (flags.sessionRecord) {
        flags.sessionRecord.captureMode = "interactive-fallback";
      }
      commandResult = await runWrappedCommand(agentCommand, {
        cwd: root,
        timeout: flags.timeout ? flags.timeout * 1000 : undefined,
        captureOutputMode: "inherit",
        captureBufferMaxBytes: getCaptureBufferMaxBytes(config),
      });
    } else {
      if (preparedSessionMemory) {
        await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, {
          phase: "spawn-error",
          exitCode: 1,
          stderr: error.message,
        }, config);
      }
      throw error;
    }
  }
  const exitCode = commandResult.exitCode;

  if (exitCode !== 0) {
    process.exitCode = exitCode;
    const result = {
      phase: "command",
      exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      interactiveTranscript: commandResult.interactiveTranscript,
      rawInteractiveLogPath: commandResult.rawInteractiveLogPath,
    };
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
    }
    return result;
  }

  if (flags.skipRefresh) {
    const result = {
      phase: "complete",
      exitCode: 0,
      skippedRefresh: true,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      interactiveTranscript: commandResult.interactiveTranscript,
      rawInteractiveLogPath: commandResult.rawInteractiveLogPath,
    };
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
    }
    return result;
  }

  const postHeadCommit = await getHeadCommit(root);
  const postFiles = await getChangedFiles(root);
  const agentChanges = diffSnapshots(preFiles, postFiles);
  const headChanged = postHeadCommit !== preHeadCommit;
  if (agentChanges.length === 0 && !headChanged) {
    const validation = await validateRepo(root, config);
    if (!validation.passed && flags.failOnStale) {
      process.exitCode = AGENTIFY_EXIT_VALIDATE_FAILED;
    } else if (!validation.passed) {
      for (const f of validation.failures) {
        process.stderr.write(ui.formatFailure(f) + "\n");
      }
    }
    const result = {
      phase: "complete",
      exitCode: process.exitCode || 0,
      validation,
      skippedRefresh: true,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      interactiveTranscript: commandResult.interactiveTranscript,
      rawInteractiveLogPath: commandResult.rawInteractiveLogPath,
    };
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
    }
    return result;
  }

  try {
    await runScan(root, config, { skipFinalize: true });
    await runDoc(root, config, { skipFinalize: true });
  } catch (error) {
    ui.error(`refresh error: ${error.message}`);
    if (flags.failOnStale) {
      process.exitCode = AGENTIFY_EXIT_REFRESH_ERROR;
      const result = {
        phase: "refresh-error",
        exitCode: AGENTIFY_EXIT_REFRESH_ERROR,
        stdout: commandResult.stdout,
        stderr: `${commandResult.stderr}${commandResult.stderr ? "\n" : ""}${error.message}`,
        interactiveTranscript: commandResult.interactiveTranscript,
        rawInteractiveLogPath: commandResult.rawInteractiveLogPath,
      };
      if (preparedSessionMemory) {
        await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
      }
      return result;
    }
  }

  const validation = await validateRepo(root, config);

  if (!validation.passed) {
    if (flags.failOnStale) {
      process.exitCode = AGENTIFY_EXIT_VALIDATE_FAILED;
    } else {
      for (const f of validation.failures) {
        process.stderr.write(ui.formatFailure(f) + "\n");
      }
    }
  }

  const result = {
    phase: "complete",
    exitCode: process.exitCode || 0,
    validation,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    interactiveTranscript: commandResult.interactiveTranscript,
    rawInteractiveLogPath: commandResult.rawInteractiveLogPath,
  };
  if (preparedSessionMemory) {
    await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
  }
  return result;
}
