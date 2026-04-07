import { spawn } from "node:child_process";
import path from "node:path";

import { exists, readJson } from "./fs.js";

async function runChildCommand(command, args, { cwd } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];

  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", reject);
    child.on("close", resolve);
  });

  return {
    code: Number(code ?? 1),
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

export async function detectTestCommand(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return null;
  }
  try {
    const packageJson = await readJson(packageJsonPath);
    if (packageJson?.scripts?.test) {
      const packageManager = typeof packageJson.packageManager === "string"
        ? packageJson.packageManager.split("@")[0]
        : null;
      if (packageManager === "pnpm") {
        return { command: "pnpm", args: ["test"] };
      }
      if (packageManager === "yarn") {
        return { command: "yarn", args: ["test"] };
      }
      if (packageManager === "bun") {
        return { command: "bun", args: ["test"] };
      }
      if (await exists(path.join(root, "pnpm-lock.yaml"))) {
        return { command: "pnpm", args: ["test"] };
      }
      if (await exists(path.join(root, "yarn.lock"))) {
        return { command: "yarn", args: ["test"] };
      }
      if (await exists(path.join(root, "bun.lockb")) || await exists(path.join(root, "bun.lock"))) {
        return { command: "bun", args: ["test"] };
      }
      return { command: "npm", args: ["test"] };
    }
  } catch {
    return null;
  }
  return null;
}

export async function runProjectTests(root, reporter) {
  const testCommand = await detectTestCommand(root);
  if (!testCommand) {
    const result = {
      status: "skipped",
      passed: false,
      command: null,
      stdout: "",
      stderr: "",
      exit_code: null,
    };
    reporter.log("tests: skipped because no package.json test script was found");
    reporter.setTests(result);
    return result;
  }

  reporter.log(`tests: running ${testCommand.command} ${testCommand.args.join(" ")}`);
  const outcome = await runChildCommand(testCommand.command, testCommand.args, { cwd: root });
  if (outcome.stdout) {
    reporter.appendSection("[tests stdout]", outcome.stdout);
  }
  if (outcome.stderr) {
    reporter.appendSection("[tests stderr]", outcome.stderr);
  }

  const result = {
    status: outcome.code === 0 ? "passed" : "failed",
    passed: outcome.code === 0,
    command: `${testCommand.command} ${testCommand.args.join(" ")}`,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exit_code: outcome.code,
  };
  reporter.log(`tests: ${result.status}`);
  reporter.setTests(result);
  return result;
}
