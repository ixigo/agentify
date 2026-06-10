import { writeHandoffBundle } from "../handoff.js";
import { runExec } from "../exec.js";
import { forkSession, listSessions, resumeSession, resolveSessionProvider, validateSessionId } from "../session.js";
import { dim, success, bold, log } from "../ui.js";
import {
  getPromptFromArgs,
  maybePrintPreparedChild,
  prepareSessionLaunch,
  resolveSessionIdForResume,
} from "../run-prompts.js";

export async function handleHandoff({ root, config, args }) {
  let sessionId = args.session ? validateSessionId(String(args.session), "--session id") : null;
  let promptStartIndex = 1;
  if (!sessionId && args._[1]) {
    sessionId = validateSessionId(String(args._[1]), "session id");
    promptStartIndex = 2;
  }
  if (!sessionId) {
    const sessions = await listSessions(root);
    if (sessions.length === 0) {
      throw new Error("handoff requires --session <id> when no sessions exist");
    }
    sessionId = validateSessionId(String(sessions[0].session_id), "session id");
  }

  const task = getPromptFromArgs(args, promptStartIndex);
  const result = await writeHandoffBundle(root, config, sessionId, task);
  if (config.json) {
    console.log(JSON.stringify({
      command: "handoff",
      session_id: sessionId,
      markdown_path: result.relativeMarkdownPath,
      json_path: result.relativeJsonPath,
      bundle: result.bundle,
    }, null, 2));
  } else {
    success(`Handoff written for ${sessionId}`);
    log(`Markdown: ${dim(result.relativeMarkdownPath)}`);
    log(`JSON: ${dim(result.relativeJsonPath)}`);
  }
}

export async function handleSess({ root, config, args, subcommand }) {
  if (subcommand === "list") {
    const sessions = await listSessions(root);
    if (config.json) {
      console.log(JSON.stringify(sessions, null, 2));
    } else if (sessions.length === 0) {
      log("No sessions found.");
    } else {
      for (const s of sessions) {
        log(`${bold(s.session_id)} ${dim(resolveSessionProvider(s, ""))} ${dim(s.created_at || "")}`);
      }
    }
    return;
  }

  if (subcommand === "fork") {
    const fromId = args.from ? validateSessionId(String(args.from), "--from id") : null;
    const result = await forkSession(root, config, {
      from: fromId,
      provider: args.provider || null,
      name: args.name || null,
    });
    const task = getPromptFromArgs(args, 2);
    const launch = await prepareSessionLaunch(root, config, args, result, task);

    if (!config.json) {
      success(`Session forked: ${result.manifest.session_id}`);
      log(`Path: ${dim(result.sessionDir)}`);
    }

    await runExec(root, launch.runExecConfig, launch.agentCommand, launch.runExecFlags);
    await maybePrintPreparedChild(root, config, launch);
    return;
  }

  if (subcommand === "resume") {
    const { sessionId, promptStartIndex } = resolveSessionIdForResume(args);
    const result = await resumeSession(root, sessionId);
    const task = getPromptFromArgs(args, promptStartIndex);
    const launch = await prepareSessionLaunch(root, config, args, result, task);

    await runExec(root, launch.runExecConfig, launch.agentCommand, launch.runExecFlags);
    await maybePrintPreparedChild(root, config, launch);
    return;
  }

  if (subcommand === "run") {
    let sessionResult;
    let sessionDir;

    if (args.session) {
      sessionResult = await resumeSession(root, validateSessionId(String(args.session), "--session id"));
    } else {
      const fromId = args.from ? validateSessionId(String(args.from), "--from id") : null;
      const created = await forkSession(root, config, {
        from: fromId,
        provider: args.provider || null,
        name: args.name || null,
      });
      sessionResult = {
        manifest: created.manifest,
        context: created.context,
        bootstrap: created.bootstrap,
      };
      sessionDir = created.sessionDir;
      if (!config.json) {
        success(`Session created: ${created.manifest.session_id}`);
        log(`Path: ${dim(created.sessionDir)}`);
      }
    }

    const task = getPromptFromArgs(args, 2);
    const launch = await prepareSessionLaunch(root, config, args, sessionResult, task);

    if (config.json && sessionDir) {
      console.log(JSON.stringify({ ...sessionResult.manifest, session_dir: sessionDir }, null, 2));
    }

    await runExec(root, launch.runExecConfig, launch.agentCommand, launch.runExecFlags);
    await maybePrintPreparedChild(root, config, launch);
    return;
  }

  throw new Error("sess requires a subcommand: run, fork, list, or resume");
}
