import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writePrivateJson } from "../fs.js";
import { getGitIdentity } from "../project-store.js";
import {
  cacheKey,
  cacheSignature,
  cloneCached,
  readAnalysisCache,
  resolveAnalysisCachePath,
  writeAnalysisCache,
} from "./cache.js";
import { auditGlobalConfig } from "./config-audit.js";
import { applyInsights } from "./insights.js";
import { aggregateUsage, SESSION_ANALYSIS_SCHEMA_VERSION, stableHash, USAGE_FIELDS } from "./normalize.js";
import { buildRecommendations } from "./opportunities.js";
import { probeSessionCwd } from "./project-probe.js";
import { parseClaudeSession } from "./providers/claude.js";
import { parseCodexSession } from "./providers/codex.js";

const PROVIDERS = ["claude", "codex"];

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalPath(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function knownWorktreeRoots(identity, fallbackRoot) {
  if (!identity) return [await canonicalPath(fallbackRoot)];
  const roots = new Set([await canonicalPath(identity.topLevel)]);
  if (path.basename(identity.commonDir) === ".git") {
    roots.add(await canonicalPath(path.dirname(identity.commonDir)));
  }
  const worktreesRoot = path.join(identity.commonDir, "worktrees");
  const entries = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const gitDirFile = path.join(worktreesRoot, entry.name, "gitdir");
    const gitDir = await fs.readFile(gitDirFile, "utf8").catch(() => "");
    if (gitDir.trim()) roots.add(await canonicalPath(path.dirname(path.resolve(gitDir.trim()))));
  }
  return [...roots].sort();
}

async function* walkJsonl(root) {
  let directory;
  try {
    directory = await fs.opendir(root);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return;
    throw error;
  }
  for await (const entry of directory) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      yield { path: fullPath, size: stat.size, mtime_ms: stat.mtimeMs };
    }
  }
}

function selectedProviders(value) {
  const provider = String(value || "all").toLowerCase();
  if (provider === "all") return PROVIDERS;
  if (!PROVIDERS.includes(provider)) throw new Error("analyze --provider must be one of: claude, codex, all");
  return [provider];
}

function parseSourceRoots(values, providers, homeDir) {
  const roots = {
    claude: [path.join(homeDir, ".claude", "projects")],
    codex: [path.join(homeDir, ".codex", "sessions")],
  };
  const overrides = values === undefined ? [] : [].concat(values);
  if (overrides.length === 0) return roots;
  roots.claude = [];
  roots.codex = [];
  for (const value of overrides) {
    const raw = String(value);
    const separator = raw.indexOf("=");
    if (separator > 0 && PROVIDERS.includes(raw.slice(0, separator))) {
      roots[raw.slice(0, separator)].push(path.resolve(raw.slice(separator + 1)));
      continue;
    }
    if (providers.length !== 1) {
      throw new Error("analyze --source-root requires claude=<path> or codex=<path> when multiple providers are selected");
    }
    roots[providers[0]].push(path.resolve(raw));
  }
  return roots;
}

function addCoverage(target, provider, file, coverage, included) {
  const bucket = target.providers[provider];
  bucket.files += 1;
  bucket.bytes += file.size;
  bucket.records += coverage.records || 0;
  bucket.malformed_records += coverage.malformed || 0;
  bucket.oversized_records += coverage.oversized || 0;
  bucket.sidechain_records_deduplicated += coverage.sidechain_records_deduplicated || 0;
  if (coverage.project_probe_only === true) bucket.project_probe_only_files += 1;
  if (included) bucket.sessions += 1;
}

function withCoverageRatios(report) {
  const sessions = report.sessions;
  const count = sessions.length;
  report.coverage.ratios = {
    model: count === 0 ? 0 : sessions.filter((session) => session.models.length > 0).length / count,
    tokens: Object.fromEntries(USAGE_FIELDS.map((field) => [
      field,
      count === 0 ? 0 : sessions.filter((session) => session.usage[field] !== null).length / count,
    ])),
    cost: count === 0 ? 0 : sessions.filter((session) => session.cost.basis !== "unavailable").length / count,
    file_access: count === 0 ? 0 : sessions.filter((session) => session.file_access.length > 0).length / count,
  };
  return report;
}

function displaySourceRoot(sourceRoot, homeDir) {
  const resolved = path.resolve(sourceRoot);
  const relative = path.relative(homeDir, resolved);
  if (relative === "") return "~";
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return resolved;
}

export async function analyzeSessionHistory(root, options = {}) {
  const providers = selectedProviders(options.provider);
  const scope = String(options.scope || "current-repo");
  if (!["current-repo", "global"].includes(scope)) throw new Error("analyze --scope must be one of: current-repo, global");
  const contentMode = String(options.contentMode || "metadata-only");
  if (!["metadata-only", "local-extractive"].includes(contentMode)) {
    throw new Error("analyze --content must be one of: metadata-only, local-extractive");
  }
  const days = options.days === undefined ? 30 : Number(options.days);
  if (!Number.isInteger(days) || days <= 0) throw new Error("analyze --days requires a positive integer");
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const cutoff = now.getTime() - days * 86_400_000;
  const projectRoot = path.resolve(root);
  const targetGitIdentity = await getGitIdentity(projectRoot);
  const targetWorktreeRoots = await knownWorktreeRoots(targetGitIdentity, projectRoot);
  const targetRepoKey = targetGitIdentity?.repoKey || stableHash(`worktrees:${targetWorktreeRoots.join("\0")}`);
  const targetProjectBoundary = stableHash(JSON.stringify({
    repo_key: targetRepoKey,
    worktree_roots: targetWorktreeRoots,
  }), 32);
  const gitIdentityByPath = new Map();
  const homeDir = path.resolve(options.homeDir || os.homedir());
  if (options.includeConfig === true && scope !== "global") {
    throw new Error("analyze --include-config requires --scope global");
  }
  const roots = parseSourceRoots(options.sourceRoots, providers, homeDir);
  const filesByProvider = Object.fromEntries(PROVIDERS.map((provider) => [provider, []]));
  const sessions = [];
  const coverage = {
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, {
      files: 0,
      bytes: 0,
      sessions: 0,
      records: 0,
      malformed_records: 0,
      oversized_records: 0,
      sidechain_records_deduplicated: 0,
      skipped_files: 0,
      unreadable_files: 0,
      project_probe_only_files: 0,
    }])),
    cache: { hits: 0, misses: 0, writes: 0 },
    ratios: {},
  };

  for (const provider of providers) {
    const discoveredPaths = new Set();
    for (const sourceRoot of roots[provider]) {
      for await (const file of walkJsonl(sourceRoot)) {
        const fileKey = path.resolve(file.path);
        if (discoveredPaths.has(fileKey)) continue;
        discoveredPaths.add(fileKey);
        filesByProvider[provider].push(file);
        if (options.dryRun === true) addCoverage(coverage, provider, file, {}, false);
      }
    }
  }

  const cachePath = resolveAnalysisCachePath(projectRoot, options);
  const cache = await readAnalysisCache(cachePath, options);
  const useCache = options.noCache !== true && options.showProjectNames !== true && options.showPaths !== true;
  const consentKey = stableHash(JSON.stringify({
    scope,
    contentMode,
    include_config: options.includeConfig === true,
    providers,
    roots: providers.flatMap((provider) => roots[provider].map((sourceRoot) => stableHash(sourceRoot, 32))),
  }));
  const hadConsent = cache.consents.includes(consentKey);
  let consentAdded = false;
  let recordBodiesRead = false;
  if (options.dryRun !== true && !hadConsent) {
    const disclosure = {
      scope,
      content_mode: contentMode,
      files: providers.reduce((sum, provider) => sum + filesByProvider[provider].length, 0),
      bytes: providers.reduce((sum, provider) => sum + filesByProvider[provider].reduce((total, file) => total + file.size, 0), 0),
      providers,
      uploads: false,
      raw_transcript_retained: false,
    };
    const confirmed = options.yes === true || (typeof options.confirm === "function" && await options.confirm(disclosure));
    if (!confirmed) {
      throw new Error("agentify analyze requires explicit consent before reading session record bodies; rerun with --yes in non-interactive use");
    }
    cache.consents.push(consentKey);
    consentAdded = true;
  }

  if (options.dryRun !== true) {
    for (const provider of providers) {
      for (const file of filesByProvider[provider]) {
        const key = cacheKey(provider, file.path);
        const signature = cacheSignature(provider, file, {
          scope,
          contentMode,
          projectRoot,
          projectBoundary: scope === "current-repo" ? targetProjectBoundary : null,
        });
        let parsed;
        if (useCache && cache.entries[key]?.signature === signature) {
          parsed = cloneCached(cache.entries[key].parsed);
          coverage.cache.hits += 1;
        } else {
          try {
            let matchingWorktreeRoot = null;
            if (scope === "current-repo") {
              const candidateCwd = await probeSessionCwd(file.path, { signal: options.signal });
              const resolvedCwd = candidateCwd ? await canonicalPath(candidateCwd) : null;
              const canonicalWorktreeRoot = resolvedCwd
                ? targetWorktreeRoots.find((worktreeRoot) => isWithinRoot(worktreeRoot, resolvedCwd)) || null
                : null;
              if (canonicalWorktreeRoot) {
                const relativeCwd = path.relative(canonicalWorktreeRoot, resolvedCwd);
                const parentSegments = relativeCwd ? relativeCwd.split(path.sep).filter(Boolean).map(() => "..") : [];
                matchingWorktreeRoot = path.resolve(candidateCwd, ...parentSegments);
              }
              if (!matchingWorktreeRoot) {
                parsed = { session: null, coverage: { records: 0, malformed: 0, project_probe_only: true } };
              }
            }
            const parserOptions = {
              ...options,
              scope,
              contentMode,
              projectRoot: scope === "global" ? undefined : matchingWorktreeRoot || projectRoot,
            };
            if (!parsed) {
              recordBodiesRead = true;
              parsed = provider === "claude"
                ? await parseClaudeSession(file, parserOptions)
                : await parseCodexSession(file, parserOptions);
            }
          } catch (error) {
            if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
            addCoverage(coverage, provider, file, {}, false);
            coverage.providers[provider].skipped_files += 1;
            if (["EACCES", "EPERM"].includes(error.code)) coverage.providers[provider].unreadable_files += 1;
            options.onProgress?.({ provider, ...coverage.providers[provider] });
            continue;
          }
          const display = parsed.session?.project?.display;
          if (display) {
            if (scope === "current-repo") {
              parsed.session.project.repo_key = targetRepoKey;
            } else {
              if (!gitIdentityByPath.has(display)) {
                gitIdentityByPath.set(display, await getGitIdentity(display));
              }
              parsed.session.project.repo_key = gitIdentityByPath.get(display)?.repoKey || null;
            }
          }
          coverage.cache.misses += 1;
          if (useCache) {
            const safeParsed = cloneCached(parsed);
            if (safeParsed?.session?.project) delete safeParsed.session.project.display;
            cache.entries[key] = { signature, parsed: safeParsed };
            coverage.cache.writes += 1;
          }
        }
        const session = parsed.session;
        const inWindow = Boolean(session?.ended_at && Date.parse(session.ended_at) >= cutoff);
        const inProject = scope === "global"
          || session?.project.repo_key === targetRepoKey
          || (session?.project.display && targetWorktreeRoots.some((worktreeRoot) => isWithinRoot(worktreeRoot, path.resolve(session.project.display))))
          || session?.project.key === stableHash(projectRoot);
        const included = Boolean(session && inWindow && inProject);
        if (included) sessions.push(session);
        addCoverage(coverage, provider, file, parsed.coverage, included);
        options.onProgress?.({ provider, ...coverage.providers[provider] });
      }
    }
    if (useCache && (coverage.cache.writes > 0 || consentAdded)) {
      await writeAnalysisCache(cachePath, cache);
    } else if (useCache && options.yes === true && !(await fs.stat(cachePath).catch(() => null))) {
      await writeAnalysisCache(cachePath, cache);
    }
  }

  const displays = new Map(sessions.map((session) => [session.project.key, session.project.display]));
  const aliases = new Map([...new Set(sessions.map((session) => session.project.key))]
    .sort()
    .map((key, index) => {
      if (scope !== "global") return [key, path.basename(projectRoot)];
      const display = displays.get(key);
      if (options.showPaths === true && display) return [key, display];
      if (options.showProjectNames === true && display) return [key, path.basename(display)];
      return [key, `Project ${index + 1}`];
    }));
  const globalFileAliases = new Map(scope === "global" && options.showPaths !== true
    ? [...new Set(sessions.flatMap((session) => session.file_access
        .filter((event) => event.path !== "<external>")
        .map((event) => `${session.project.key}\0${event.path}`)))]
      .sort()
      .map((key, index) => [key, `File ${index + 1}`])
    : []);
  for (const session of sessions) {
    if (scope === "global" && options.showPaths !== true) {
      session.file_access = session.file_access.map((event) => ({
        ...event,
        path: event.path === "<external>"
          ? event.path
          : globalFileAliases.get(`${session.project.key}\0${event.path}`),
      }));
      session.project.branch = null;
    }
    session.project.alias = aliases.get(session.project.key);
    delete session.project.key;
    delete session.project.display;
    delete session.project.repo_key;
  }
  sessions.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.provider.localeCompare(b.provider));
  const recommendationResult = buildRecommendations(sessions, options.toolInventory || {});
  const configAudit = options.includeConfig === true
    ? await auditGlobalConfig(homeDir, { dryRun: options.dryRun === true })
    : null;

  const report = {
    schema_version: SESSION_ANALYSIS_SCHEMA_VERSION,
    command: "analyze",
    dry_run: options.dryRun === true,
    generated_at: now.toISOString(),
    window_days: days,
    scope,
    content_mode: contentMode,
    providers: providers.map((provider) => ({ provider, ...coverage.providers[provider] })),
    totals: {
      sessions: sessions.length,
      active_duration_ms: sessions.reduce((sum, session) => sum + (session.duration_ms || 0), 0),
      usage: aggregateUsage(sessions),
      reported_cost_usd: null,
      estimated_cost_usd: null,
      tool_calls: sessions.reduce((sum, session) => sum + session.tools.calls, 0),
      file_access_events: sessions.reduce((sum, session) => sum + session.file_access.reduce((events, item) => events + item.events, 0), 0),
    },
    sessions,
    recommendations: recommendationResult.recommendations,
    suppressed_recommendations: recommendationResult.suppressed,
    workflow_patterns: recommendationResult.patterns,
    capabilities: options.toolInventory || {},
    config_audit: configAudit,
    coverage,
    privacy: {
      record_bodies_read: recordBodiesRead,
      current_repo_boundary: scope === "current-repo" ? "bounded-cwd-probe-before-full-parse" : null,
      unrelated_project_records_read: scope === "current-repo" ? false : null,
      uploads: false,
      provider_processes_started: false,
      raw_transcript_retained: false,
      command_bodies_retained: false,
      source_roots: providers.flatMap((provider) => roots[provider].map((sourceRoot) => ({
        provider,
        category: "session-jsonl",
        ...(options.showPaths === true ? { display_path: displaySourceRoot(sourceRoot, homeDir) } : {}),
      }))),
      config_categories: configAudit ? ["global instructions", "allowlisted non-secret settings", "integration manifests"] : [],
    },
  };
  withCoverageRatios(report);
  report.insights = await applyInsights(report, options);
  if (options.keepInsightsPacket === true && options.insightsDryRun !== true && report.insights.packet) {
    const packetPath = path.join(options.artifactPaths?.cacheRoot || path.join(projectRoot, ".agentify", "cache"), "session-insights-packet.json");
    await writePrivateJson(packetPath, report.insights.packet);
    report.insights.packet_artifact = path.relative(projectRoot, packetPath).split(path.sep).join("/");
    delete report.insights.packet;
  }
  report.privacy.provider_processes_started = report.insights.mode === "cli" && report.insights.dry_run === false;
  report.privacy.uploads = report.insights.packet_sent === true;
  return report;
}
