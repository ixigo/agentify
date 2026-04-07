import { spawn } from "node:child_process";
import { getChangedFiles, getHeadCommit } from "./git.js";
import { runScan, runDoc } from "./commands.js";
import { validateRepo } from "./validate.js";
import { finalizeSessionMemoryRun, prepareSessionMemoryRun } from "./session-memory.js";
import * as ui from "./ui.js";

const AGENTIFY_EXIT_VALIDATE_FAILED = 80;
const AGENTIFY_EXIT_REFRESH_ERROR = 81;

function diffSnapshots(preFiles, postFiles) {
  const preSet = new Set(preFiles.map((f) => `${f.status}:${f.path}`));
  return postFiles.filter((f) => !preSet.has(`${f.status}:${f.path}`));
}

function runWrappedCommand(argv, options) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: options.captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
      env: process.env,
    });

    if (options.captureOutput) {
      child.stdout.on("data", (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(Buffer.from(chunk));
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
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: options.captureOutput ? Buffer.concat(stdoutChunks).toString("utf8") : "",
        stderr: options.captureOutput ? Buffer.concat(stderrChunks).toString("utf8") : "",
      });
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
      captureOutput: flags.captureOutput || false,
    });
  } catch (error) {
    if (preparedSessionMemory) {
      await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, {
        phase: "spawn-error",
        exitCode: 1,
        stderr: error.message,
      }, config);
    }
    throw error;
  }
  const exitCode = commandResult.exitCode;

  if (exitCode !== 0) {
    process.exitCode = exitCode;
    const result = { phase: "command", exitCode, stdout: commandResult.stdout, stderr: commandResult.stderr };
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
  };
  if (preparedSessionMemory) {
    await finalizeSessionMemoryRun(root, flags.sessionRecord, preparedSessionMemory, result, config);
  }
  return result;
}
