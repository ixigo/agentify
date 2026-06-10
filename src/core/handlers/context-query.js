import {
  fetchContext,
  searchContext,
} from "../context.js";
import {
  queryCallers,
  queryChanged,
  queryDef,
  queryDeps,
  queryImpacts,
  queryOwner,
  queryRefs,
  querySearch,
} from "../query.js";
import { buildRiskReport, renderRiskReport } from "../risk.js";
import { compactSessionContext } from "../session-memory.js";
import { resolveSessionProvider, resumeSession, validateSessionId } from "../session.js";
import { log } from "../ui.js";
import {
  getSearchTerm,
  normalizeOptionalSince,
  throwWithIndexGuidance,
} from "./shared.js";
import { getPromptFromArgs } from "../run-prompts.js";

const CONTEXT_SUBCOMMANDS = {
  async search({ root, config, args }) {
    const term = args.term || getPromptFromArgs(args, 2);
    return searchContext(root, term, { config, artifactPaths: config._agentifyPaths });
  },
  async fetch({ root, config, args }) {
    const target = args._[2] || args.file || args.path;
    if (!target) {
      throw new Error("context fetch requires <path>");
    }
    return fetchContext(root, target, {
      config,
      artifactPaths: config._agentifyPaths,
      lines: args.lines,
      symbol: args.symbol,
    });
  },
  async compact({ root, config, args }) {
    if (!args.session) {
      throw new Error("context compact requires --session <id>");
    }
    return compactSessionContext(root, validateSessionId(String(args.session), "--session id"), config);
  },
  async status({ root, args }) {
    if (!args.session) {
      throw new Error("context status requires --session <id>");
    }
    const sessionId = validateSessionId(String(args.session), "--session id");
    const session = await resumeSession(root, sessionId);
    return {
      command: "context status",
      session_id: sessionId,
      provider: resolveSessionProvider(session.manifest, null),
      context_bytes: Buffer.byteLength(JSON.stringify(session.context, null, 2), "utf8"),
      run_history_count: Array.isArray(session.context.run_history) ? session.context.run_history.length : 0,
      has_context_facts: Boolean(session.context.context_facts),
      prepared_child_session: session.manifest.prepared_child_session || null,
    };
  },
};

const QUERY_SUBCOMMANDS = {
  async owner({ root, config, args }) {
    if (!args.file) throw new Error("query owner requires --file <path>");
    return queryOwner(root, args.file, { config, artifactPaths: config._agentifyPaths });
  },
  async deps({ root, config, args }) {
    if (!args.module) throw new Error("query deps requires --module <id>");
    return queryDeps(root, args.module, { config, artifactPaths: config._agentifyPaths });
  },
  async changed({ root, config, args }) {
    if (!args.since) throw new Error("query changed requires --since <commit>");
    return queryChanged(root, args.since, { config, artifactPaths: config._agentifyPaths });
  },
  async search({ root, config, args }) {
    return querySearch(root, getSearchTerm(args, "query"), { config, artifactPaths: config._agentifyPaths });
  },
  async def({ root, config, args }) {
    if (!args.symbol) throw new Error("query def requires --symbol <name>");
    return queryDef(root, args.symbol, { config, artifactPaths: config._agentifyPaths });
  },
  async refs({ root, config, args }) {
    if (!args.symbol) throw new Error("query refs requires --symbol <name>");
    return queryRefs(root, args.symbol, { config, artifactPaths: config._agentifyPaths });
  },
  async callers({ root, config, args }) {
    if (!args.symbol) throw new Error("query callers requires --symbol <name>");
    return queryCallers(root, args.symbol, { config, artifactPaths: config._agentifyPaths });
  },
  async impacts({ root, config, args }) {
    if (!args.file) throw new Error("query impacts requires --file <path>");
    return queryImpacts(root, args.file, { config, artifactPaths: config._agentifyPaths, depth: args.depth });
  },
};

export async function handleContext({ root, config, args, subcommand }) {
  let result;
  const handler = CONTEXT_SUBCOMMANDS[subcommand];
  if (!handler) {
    throw new Error("context requires a subcommand: search, fetch, compact, or status");
  }
  try {
    result = await handler({ root, config, args });
  } catch (error) {
    throwWithIndexGuidance(error, root);
  }
  console.log(JSON.stringify(result, null, 2));
}

export async function handleQuery({ root, config, args, subcommand }) {
  let result;
  const handler = QUERY_SUBCOMMANDS[subcommand];
  if (!handler) {
    throw new Error("query requires a subcommand: owner, deps, changed, search, def, refs, callers, or impacts");
  }
  try {
    result = await handler({ root, config, args });
  } catch (error) {
    throwWithIndexGuidance(error, root);
  }
  console.log(JSON.stringify(result, null, 2));
}

export async function handleRisk({ root, config, args }) {
  let result;
  try {
    result = await buildRiskReport(root, {
      since: normalizeOptionalSince(args, "risk"),
      config,
      artifactPaths: config._agentifyPaths,
    });
  } catch (error) {
    throwWithIndexGuidance(error, root);
  }
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log(renderRiskReport(result));
  }
}
