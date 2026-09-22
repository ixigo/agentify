import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { migrationHomes } from "./migrate.js";

const execFileAsync = promisify(execFile);

export function validateDesktopOpen(options, platform = process.platform) {
  if (options.targetSurface !== "desktop") throw new Error("--open requires --to claude-desktop (the default)");
  if (options.dryRun) return;
  if (platform !== "darwin") throw new Error("--open currently supports macOS; omit it and use Claude Desktop's /resume picker");
  if (migrationHomes(options).claude !== path.join(os.homedir(), ".claude")) {
    throw new Error("--open requires the default ~/.claude directory used by Claude Desktop");
  }
}

// Same local deep link used by Claude Code's /desktop command. Let the app
// adopt each transcript itself; never edit its private session registry.
export async function openMigratedSessions(result, open = execFileAsync) {
  for (const project of result.projects || [result]) {
    if (project.dry_run) continue;
    project.desktop_open = { requested: 0, failed: 0 };
    for (const session of project.sessions) {
      const url = `claude://resume?session=${encodeURIComponent(session.native.id)}`;
      try {
        await open("/usr/bin/open", ["-a", "/Applications/Claude.app", url], { timeout: 15_000 });
        session.native.desktop.status = "desktop-open-requested";
        project.desktop_open.requested++;
      } catch (error) {
        project.desktop_open.failed++;
        project.warnings.push(`Could not open ${session.native.id} in Claude Desktop: ${error.message}. The imported thread is saved; use /resume.`);
      }
    }
  }
}
