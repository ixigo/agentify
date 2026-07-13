import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { ensureAgentifyGitignore } from "./gitignore.js";
import {
  addNote,
  clearContext,
  contextStatus,
  isContextPaused,
  listDecisions,
  loadContextSnapshot,
  latestSessionId,
  matchContext,
  normalizeInjectionMode,
  pauseContext,
  precheckCommand,
  readHookPayload,
  renderContextDigest,
  renderMatchDigest,
  renderPrecheckWarning,
  resolveSummaryMode,
  resumeContext,
  summarizeSession,
  trackEvent,
  writeHandoff,
} from "./ctx.js";
import { getPromptFromArgs } from "./cli-args.js";
import { bold, dim, log, success } from "./ui.js";

async function resolveInjectionMode(root) {
  try {
    const config = await loadConfig(root, {});
    return normalizeInjectionMode(config.context?.injection);
  } catch {
    return "relevant";
  }
}

export async function runCtxHook(action, root) {
  // Hook-invoked paths must never fail or pollute the transcript with errors.
  try {
    const payload = await readHookPayload();
    if (action === "track") {
      const result = await trackEvent(root, payload);
      if (
        result.tracked
        && payload?.hook_event_name === "SessionEnd"
        && payload?.session_id
      ) {
        await maybeSpawnSessionSummary(root, String(payload.session_id));
      }
      return;
    }

    if (await isContextPaused(root)) {
      return;
    }
    const mode = await resolveInjectionMode(root);
    if (mode === "off") {
      return;
    }

    if (action === "load") {
      const snapshot = await loadContextSnapshot(root);
      if (mode === "digest") {
        const digest = renderContextDigest(snapshot);
        if (digest) {
          process.stdout.write(`${digest}\n`);
        }
        return;
      }
      // relevant mode: a one-line pointer only — matched context arrives with
      // each prompt via the UserPromptSubmit hook.
      if (snapshot.summary.eventCount > 0 || snapshot.notes.length > 0) {
        process.stdout.write(`Agentify is tracking context here (${snapshot.notes.length} note(s), ${snapshot.summary.eventCount} recent event(s)). Related notes are injected per task; run \`agentify ctx load\` for the full digest.\n`);
      }
      return;
    }

    if (action === "match") {
      if (mode !== "relevant") {
        return;
      }
      const prompt = String(payload?.prompt || "");
      if (!prompt.trim()) {
        return;
      }
      const matches = await matchContext(root, prompt, { sessionId: payload?.session_id });
      const digest = renderMatchDigest(matches);
      if (digest) {
        process.stdout.write(`${digest}\n`);
      }
      return;
    }

    if (action === "precheck") {
      const warning = await precheckCommand(root, payload);
      if (warning) {
        // PreToolUse hooks inject via structured JSON; plain stdout is ignored.
        process.stdout.write(`${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: renderPrecheckWarning(warning),
          },
        })}\n`);
      }
    }
  } catch {
    // Swallow all hook errors: a broken hook must not block the agent.
  }
}

async function maybeSpawnSessionSummary(root, sessionId) {
  try {
    const config = await loadConfig(root, {});
    if (resolveSummaryMode(config) === "off") {
      return;
    }
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
    // Detached so the SessionEnd hook returns immediately; the summary lands
    // asynchronously via a delegated fast-model call.
    const child = spawn(process.execPath, [cliPath, "ctx", "summarize", "--session", sessionId, "--hook", "--root", root], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Best-effort: never block the hook.
  }
}

export async function runCtxCommand(root, config, args, subcommand) {
  const isHookMode = args.hook === true;

  switch (subcommand) {
    case "track": {
      if (isHookMode) {
        await runCtxHook("track", root);
        return;
      }
      const payload = await readHookPayload();
      const result = await trackEvent(root, payload);
      console.log(JSON.stringify({ command: "ctx track", ...result }, null, 2));
      return;
    }

    case "match": {
      if (isHookMode) {
        await runCtxHook("match", root);
        return;
      }
      const prompt = getPromptFromArgs(args, 2);
      if (!prompt) {
        throw new Error('ctx match requires a prompt: agentify ctx match "<task>"');
      }
      const matches = await matchContext(root, prompt, { sessionId: args.session, recordInjection: false });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx match", ...matches }, null, 2));
      } else {
        log(renderMatchDigest(matches) || "No related context found.");
      }
      return;
    }

    case "precheck": {
      if (isHookMode) {
        await runCtxHook("precheck", root);
        return;
      }
      const command = getPromptFromArgs(args, 2);
      if (!command) {
        throw new Error('ctx precheck requires a command: agentify ctx precheck "<command>"');
      }
      const warning = await precheckCommand(root, {
        tool_name: "Bash",
        tool_input: { command },
        session_id: args.session,
      }, { recordInjection: false });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx precheck", warning }, null, 2));
      } else {
        log(warning ? renderPrecheckWarning(warning) : "No prior failure recorded for this command.");
      }
      return;
    }

    case "load": {
      if (isHookMode) {
        await runCtxHook("load", root);
        return;
      }
      const snapshot = await loadContextSnapshot(root);
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx load", ...snapshot }, null, 2));
      } else {
        const digest = renderContextDigest(snapshot);
        log(digest || "No tracked context yet. Context accrues automatically once `agentify install` hooks are active.");
      }
      return;
    }

    case "note": {
      const text = getPromptFromArgs(args, 2);
      const result = await addNote(root, text, { session: args.session, type: args.type });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx note", ...result }, null, 2));
      } else {
        success(result.record.type === "decision" ? "Decision recorded." : "Noted.");
      }
      return;
    }

    case "decision": {
      // Shorthand: `agentify ctx decision "<text>"` === `ctx note --type decision`.
      const text = getPromptFromArgs(args, 2);
      const result = await addNote(root, text, { session: args.session, type: "decision" });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx decision", ...result }, null, 2));
      } else {
        success("Decision recorded.");
      }
      return;
    }

    case "decisions": {
      const result = await listDecisions(root, getPromptFromArgs(args, 2));
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx decisions", ...result }, null, 2));
        return;
      }
      if (result.decisions.length === 0) {
        log(result.query
          ? `No decisions matching "${result.query}". Run \`agentify ctx decisions\` to list all.`
          : 'No decisions recorded yet. Record one with `agentify ctx decision "chose X over Y because Z"`.');
        return;
      }
      log(result.query ? `Decisions matching "${result.query}":` : "Decisions on record:");
      for (const decision of result.decisions) {
        const stale = Array.isArray(decision.stale_refs) && decision.stale_refs.length > 0
          ? ` ${dim(`(stale? missing: ${decision.stale_refs.join(", ")})`)}`
          : "";
        log(`- [${String(decision.ts || "").slice(0, 10)}] ${decision.note}${stale}`);
      }
      return;
    }

    case "status": {
      const result = await contextStatus(root);
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.paused) {
          log(`${bold("Tracking: paused")} — resume with \`agentify ctx resume\``);
        }
        log(`Events: ${bold(String(result.event_count))} across ${bold(String(result.session_count))} session(s)`);
        log(`Notes:  ${bold(String(result.note_count))}`);
        log(`Log:    ${dim(result.events_path)} (${result.event_log_bytes} bytes)`);
        if (result.last_event_at) {
          log(`Last activity: ${result.last_event_at}`);
        }
        for (const item of result.hot_files.slice(0, 5)) {
          log(`  ${item.file} ${dim(`(${item.edits} edits)`)}`);
        }
      }
      return;
    }

    case "handoff": {
      const result = await writeHandoff(root, { task: getPromptFromArgs(args, 2) });
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success(`Handoff written: ${result.relative_path}`);
      }
      return;
    }

    case "summarize": {
      if (isHookMode) {
        try {
          await summarizeSession(root, config, args.session, {});
        } catch {
          // Hook-spawned: never fail.
        }
        return;
      }
      const sessionId = args.session || await latestSessionId(root);
      if (!sessionId) {
        throw new Error("ctx summarize found no tracked sessions; pass --session <id>");
      }
      const result = await summarizeSession(root, config, sessionId, {});
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.status === "written") {
        success(`Session ${result.sid} summarized.`);
        log(result.record.summary);
      } else {
        log(`No summary written (${result.status}).`);
      }
      return;
    }

    case "share": {
      const enable = args.off !== true;
      const result = await ensureAgentifyGitignore(root, { shared: enable, dryRun: config.dryRun });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx share", shared: result.shared, gitignore: result.path, status: result.status }, null, 2));
      } else if (enable) {
        success("Team-shared notes enabled.");
        log(".agentify/context/notes.jsonl is now committable — commit it and teammates' agents pick your notes up.");
        log(dim("Everything else under .agentify/ stays local. Disable with `agentify ctx share --off`."));
      } else {
        success("Team-shared notes disabled; .agentify/ is fully local again.");
      }
      return;
    }

    case "pause": {
      const result = await pauseContext(root);
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success("Context tracking paused. New sessions start clean; nothing is tracked until `agentify ctx resume`.");
      }
      return;
    }

    case "resume": {
      const result = await resumeContext(root);
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        success(result.was_paused ? "Context tracking resumed." : "Context tracking was not paused.");
      }
      return;
    }

    case "clear": {
      const result = await clearContext(root, { archive: args.archive !== false });
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.archived.length > 0) {
        success("Context cleared.");
        for (const item of result.archived) {
          log(`archived: ${dim(item)}`);
        }
      } else {
        success("Context cleared (nothing to archive).");
      }
      return;
    }

    default:
      throw new Error("ctx requires a subcommand: track, note, decision, decisions, load, match, precheck, status, summarize, share, handoff, pause, resume, or clear");
  }
}
