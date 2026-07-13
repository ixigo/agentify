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
  explainContext,
  isContextPaused,
  listDecisions,
  loadContextSnapshot,
  latestSessionId,
  matchContext,
  normalizeInjectionMode,
  pauseContext,
  precheckCommand,
  recordContextDigestInjection,
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

async function loadConfigSafe(root) {
  try {
    return await loadConfig(root, {});
  } catch {
    return {};
  }
}

function resolveInjectionMode(config, env = process.env) {
  // Env override first: eval context ablations flip the mode per attempt
  // without touching the workspace's committed config.
  const envMode = String(env.AGENTIFY_CTX_INJECTION || "").trim();
  if (envMode) {
    return normalizeInjectionMode(envMode);
  }
  return normalizeInjectionMode(config.context?.injection);
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
    const config = await loadConfigSafe(root);
    const mode = resolveInjectionMode(config);
    if (mode === "off") {
      return;
    }

    if (action === "load") {
      const snapshot = await loadContextSnapshot(root);
      if (mode === "digest") {
        const digest = renderContextDigest(snapshot);
        if (digest) {
          await recordContextDigestInjection(root, snapshot, digest, { sessionId: payload?.session_id });
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
      const matches = await matchContext(root, prompt, { sessionId: payload?.session_id, config });
      if (matches.digest) {
        process.stdout.write(`${matches.digest}\n`);
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
      const matches = await matchContext(root, prompt, { sessionId: args.session, recordInjection: false, config });
      if (config.json) {
        console.log(JSON.stringify({ command: "ctx match", ...matches }, null, 2));
      } else {
        log(renderMatchDigest(matches) || "No related context found.");
      }
      return;
    }

    case "explain": {
      const prompt = getPromptFromArgs(args, 2);
      if (!prompt) {
        throw new Error('ctx explain requires a task: agentify ctx explain "<task>"');
      }
      const result = await explainContext(root, config, prompt, { sessionId: args.session, profile: args.profile });
      if (config.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const policy = result.policy;
      log(`${bold("Context policy")} ${dim(`(${policy.policy_version})`)}`);
      log(`Profile: ${bold(policy.resolved_profile)} ${dim(`(${policy.profile_source})`)}`);
      log(`Budget:  ${bold(String(policy.max_injected_tokens))} tokens ${dim(`(${policy.budget_source}: ${policy.budget_reason})`)} — reserves: decisions ${policy.reserves.decisions}, failures ${policy.reserves.failures}`);
      if (policy.min_score !== null) log(`Min score: ${policy.min_score}`);
      if (policy.max_age_days !== null) log(`Max age: ${policy.max_age_days} day(s)`);
      log(`Match:   ${result.candidates.length} candidate(s), ${result.selected_items} selected, ~${result.budget.rendered_tokens} rendered token(s), ${result.match_ms}ms`);
      if (result.candidates.length === 0) {
        log(dim("No related context found — nothing would be injected."));
        return;
      }
      log("");
      for (const candidate of result.candidates) {
        const status = candidate.selected ? (candidate.truncated ? "TRUNC " : "inject") : "skip  ";
        const detail = candidate.selected && !candidate.truncated ? "" : ` — ${candidate.reason}`;
        log(`  [${status}] ${candidate.type.padEnd(8)} ${dim(`score ${candidate.score} · ~${candidate.tokens} tok${candidate.age_days !== null ? ` · ${candidate.age_days}d old` : ""}`)} ${candidate.key}${detail}`);
      }
      if (result.digest) {
        log("");
        log(dim("Would inject:"));
        log(result.digest);
      }
      log("");
      log(dim("Dry run: nothing was recorded as seen and no telemetry was written."));
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
        await recordContextDigestInjection(root, snapshot, digest, { sessionId: args.session });
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
      throw new Error("ctx requires a subcommand: track, note, decision, decisions, load, match, explain, precheck, status, summarize, share, handoff, pause, resume, or clear");
  }
}
