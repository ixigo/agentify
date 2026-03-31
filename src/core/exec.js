import { spawn } from "node:child_process";
import { getChangedFiles } from "./git.js";
import { runScan, runDoc } from "./commands.js";
import { validateRepo } from "./validate.js";
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
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: process.env,
    });

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
      resolve(code ?? 1);
    });
  });
}

export async function runExec(root, config, agentCommand, flags) {
  const preFiles = await getChangedFiles(root);

  const exitCode = await runWrappedCommand(agentCommand, {
    cwd: root,
    timeout: flags.timeout ? flags.timeout * 1000 : undefined,
  });

  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return { phase: "command", exitCode };
  }

  if (flags.skipRefresh) {
    return { phase: "complete", exitCode: 0, skippedRefresh: true };
  }

  const postFiles = await getChangedFiles(root);
  const agentChanges = diffSnapshots(preFiles, postFiles);
  if (agentChanges.length === 0) {
    const validation = await validateRepo(root, config);
    if (!validation.passed && flags.failOnStale) {
      process.exitCode = AGENTIFY_EXIT_VALIDATE_FAILED;
    } else if (!validation.passed) {
      for (const f of validation.failures) {
        process.stderr.write(ui.formatFailure(f) + "\n");
      }
    }
    return { phase: "complete", exitCode: process.exitCode || 0, validation, skippedRefresh: true };
  }

  try {
    await runScan(root, config, { skipFinalize: true });
    await runDoc(root, config, { skipFinalize: true });
  } catch (error) {
    ui.error(`refresh error: ${error.message}`);
    if (flags.failOnStale) {
      process.exitCode = AGENTIFY_EXIT_REFRESH_ERROR;
      return { phase: "refresh-error", exitCode: AGENTIFY_EXIT_REFRESH_ERROR };
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

  return { phase: "complete", exitCode: process.exitCode || 0, validation };
}
