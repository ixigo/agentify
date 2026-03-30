#!/usr/bin/env node

import { runCli } from "./main.js";
import { banner, error, dim } from "./core/ui.js";

const args = process.argv.slice(2);
const isJson = args.includes("--json");
const isHelp = args.includes("--help") || args.includes("-h") || args[0] === "help" || args.length === 0;
const isVersion = args.includes("--version") || args.includes("-v") || args.includes("-V");

if (!isJson && !isHelp && !isVersion) {
  banner();
}

runCli(args).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  error(message);
  if (err instanceof Error && err.stack && !isJson) {
    process.stderr.write(`\n${dim(err.stack.split("\n").slice(1).join("\n"))}\n`);
  }
  process.exitCode = 1;
});
