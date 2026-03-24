const ALLOWED_SIDE_EFFECTS = new Set(["db", "network", "filesystem", "cache", "none"]);
const ALLOWED_PUBLIC_API_KINDS = new Set(["function", "class", "type", "const", "module"]);

function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid ${fieldName}`);
  }
  return value.trim();
}

function clip(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
}

function isAllowedModulePath(moduleRoot, candidatePath) {
  if (typeof candidatePath !== "string") {
    return false;
  }
  if (candidatePath.startsWith("/") || candidatePath.includes("..")) {
    return false;
  }
  if (moduleRoot === ".") {
    return true;
  }
  return candidatePath === moduleRoot || candidatePath.startsWith(`${moduleRoot}/`);
}

function sanitizePathList(items, moduleRoot, maxItems, mapper) {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      const mapped = mapper(item);
      if (!isAllowedModulePath(moduleRoot, mapped.path)) {
        continue;
      }
      result.push(mapped);
    } catch {
      // Drop invalid items.
    }
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

export function sanitizeManagerPlan(input, moduleIds) {
  const plan = {
    repo_summary: "",
    shared_conventions: [],
    module_focus: []
  };

  if (input && typeof input.repo_summary === "string") {
    plan.repo_summary = clip(input.repo_summary.trim(), 1200);
  }

  if (Array.isArray(input?.shared_conventions)) {
    plan.shared_conventions = input.shared_conventions
      .filter((item) => typeof item === "string" && item.trim() !== "")
      .slice(0, 12)
      .map((item) => clip(item.trim(), 240));
  }

  if (Array.isArray(input?.module_focus)) {
    plan.module_focus = input.module_focus
      .filter((item) => item && typeof item.module_id === "string" && moduleIds.has(item.module_id))
      .slice(0, 100)
      .map((item) => ({
        module_id: item.module_id,
        focus: clip(typeof item.focus === "string" ? item.focus.trim() : "", 320)
      }));
  }

  return plan;
}

export function sanitizeModuleResponse(input, moduleInfo, allowedKeyFiles) {
  if (!input || typeof input !== "object") {
    throw new Error("invalid module response");
  }

  const markdown = clip(ensureString(input.markdown, "markdown"), 30000);
  const summary = clip(ensureString(input.summary, "summary"), 1000);
  const publicApi = sanitizePathList(input.public_api, moduleInfo.rootPath, 20, (item) => ({
    symbol: clip(ensureString(item?.symbol, "public_api.symbol"), 200),
    kind: ALLOWED_PUBLIC_API_KINDS.has(item?.kind) ? item.kind : "module",
    path: ensureString(item?.path, "public_api.path")
  }));
  const startHere = sanitizePathList(input.start_here, moduleInfo.rootPath, 5, (item) => ({
    path: ensureString(item?.path, "start_here.path"),
    why: clip(ensureString(item?.why, "start_here.why"), 300)
  }));

  const sideEffects = Array.isArray(input.side_effects)
    ? input.side_effects.filter((item) => typeof item === "string" && ALLOWED_SIDE_EFFECTS.has(item)).slice(0, 5)
    : [];

  const headerMap = new Map();
  for (const item of Array.isArray(input.header_summaries) ? input.header_summaries : []) {
    if (!item || typeof item.path !== "string" || typeof item.summary !== "string") {
      continue;
    }
    if (!allowedKeyFiles.has(item.path)) {
      continue;
    }
    headerMap.set(item.path, clip(item.summary.trim(), 240));
  }

  const headerSummaries = Array.from(allowedKeyFiles).map((path) => ({
    path,
    summary: headerMap.get(path) || summary
  }));

  return {
    markdown,
    summary,
    public_api: publicApi,
    start_here: startHere.length > 0 ? startHere : Array.from(allowedKeyFiles).slice(0, 3).map((path) => ({
      path,
      why: "High-signal file selected by Agentify key-file ranking."
    })),
    side_effects: sideEffects.length > 0 ? sideEffects : ["none"],
    header_summaries: headerSummaries
  };
}
