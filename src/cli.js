#!/usr/bin/env node

import { runCli } from "./main.js";

runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentify: ${message}`);
  process.exitCode = 1;
});
