import path from "node:path";
import { migrateAllContexts, migrateContext } from "./migrate.js";
import { openMigratedSessions, validateDesktopOpen } from "./migration-desktop.js";

export const MIGRATE_HELP = `Usage: agentify migrate [folder] [options]

Copy saved Codex/Claude Code threads or ChatGPT exports into resumable destination
sessions. No source subscription, model call, or Agentify install is needed.
Select a folder and all its subfolders (default: current directory).
Defaults to Codex -> Claude Desktop's Code tab; original sessions stay intact.

  --from <provider>     codex, claude, or chatgpt (default: codex)
  --to <destination>    claude, claude-desktop (default), or codex
  --input <path>        ChatGPT conversations.json or extracted export directory
  --root <path>         Alternative to the positional folder; includes subfolders
  --open                Open imported threads in Claude Desktop (macOS)
  --all                 Migrate saved threads across all project directories
  --session <id>        Find a source session across projects (or within --root)
  --include-global      Also archive global instructions and memory
  --codex-home <path>   Codex data directory (default: CODEX_HOME or ~/.codex)
  --claude-home <path>  Claude data directory (default: CLAUDE_CONFIG_DIR or ~/.claude)
  --output <path>       New archive directory (with --all: parent of project archives)
  --dry-run             Preview sessions and files without writing or launching a CLI
  --json                Print the manifest as JSON
  --help                Show this help

Examples:
  agentify migrate .
  agentify migrate /path/to/project --dry-run
  agentify migrate /path/to/project --open
  agentify migrate --all --include-global --dry-run
  agentify migrate --all --include-global
  agentify migrate --session <codex-session-id>
  agentify migrate --from claude --to codex
  agentify migrate --from codex --to claude-desktop --all
  agentify migrate --from chatgpt --input ./conversations.json --to claude-desktop

Both directions write new local sessions without running either provider CLI.
Source files and existing destination conversations are preserved. Re-running
skips already imported threads; it does not merge subsequent source changes.
Use --open to hand threads to the installed Desktop app, or open the Code tab
and use /resume to select an imported session. Copying alone does not populate
the desktop sidebar. --dry-run never opens the app.
Regular Chat tab history, web collections, and channel integrations are not recreated.
`;

export async function runMigrateCommand(args) {
  if (args.help) { process.stdout.write(MIGRATE_HELP); return; }
  const positional = (args._ || []).slice(1);
  if (positional.length > 1) throw new Error("migrate accepts one folder; quote paths containing spaces");
  if (positional.length && args.root !== undefined) throw new Error("Use a folder argument or --root, not both");
  const root = positional[0] ?? args.root;
  const allowed = new Set(["_", "from", "to", "root", "all", "session", "includeGlobal", "codexHome", "claudeHome", "output", "dryRun", "json", "help", "input", "open"]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`Unknown migrate option: ${key}; use --help`);
  }
  const from = args.from ?? "codex";
  const destination = args.to ?? (from === "claude" ? "codex" : "claude-desktop");
  const options = { ...args, root, from, to: destination === "claude-desktop" ? "claude" : destination, targetSurface: destination === "claude-desktop" ? "desktop" : "cli" };
  if (root !== undefined && (typeof root !== "string" || !root.trim())) throw new Error("migrate folder or --root requires a path");
  if (args.all && root !== undefined) throw new Error("Use either --all or a folder/--root, not both");
  if (args.open) validateDesktopOpen(options);
  const result = from !== "chatgpt" && (args.all || (args.session && root === undefined))
    ? await migrateAllContexts(options)
    : await migrateContext(path.resolve(root || process.cwd()), options);
  if (args.open && !args.dryRun) await openMigratedSessions(result);
  if (args.json) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result; }
  const projects = result.projects || [result];
  for (const project of projects) {
    process.stdout.write(`${project.dry_run ? "Would migrate" : "Migrated"} ${project.sessions.length} ${project.from} thread(s) -> ${project.to}: ${project.root}\n`);
    process.stdout.write(`Archive: ${project.output}\nSaved context files: ${project.files.length}\n`);
    if (project.desktop_open) process.stdout.write(`Claude Desktop: ${project.desktop_open.requested} thread(s) sent to the app; ${project.desktop_open.failed} failed.\n`);
    if (project.target_surface === "desktop" && !project.dry_run) {
      process.stdout.write("Claude app: Code tab > Local > choose this project > type /resume > select an imported title.\n");
      process.stdout.write(`Instructions: ${path.join(project.output, "OPEN-IN-CLAUDE.md")}\n`);
    }
    for (const session of project.sessions) {
      if (session.native) {
        if (project.target_surface === "desktop") process.stdout.write(`Desktop title: ${session.native.desktop.title} (${session.native.id})\n`);
        process.stdout.write(`${session.native.already_imported ? "Already imported" : "Continue"}: ${session.native.resume_command}\n`);
      }
      else process.stdout.write(`  ${session.id}${session.title ? ` — ${session.title}` : ""}\n`);
    }
    if (!project.dry_run && !project.sessions.length) process.stdout.write(`Load context: ${project.launch_command}\n`);
    for (const warning of project.warnings) process.stdout.write(`Warning: ${warning}\n`);
  }
  if (result.skipped_without_cwd) process.stdout.write(`Skipped ${result.skipped_without_cwd} session(s) with no saved project directory.\n`);
  return result;
}
