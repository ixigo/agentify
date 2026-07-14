import path from "node:path";

const RTK_SUPPORTED_COMMANDS = new Set([
  "aws", "cargo", "curl", "diff", "docker", "dotnet", "find", "git", "gh", "glab", "go", "golangci-lint",
  "gradlew", "grep", "gt", "jest", "kubectl", "mvn", "mypy", "next", "npm", "npx", "oc", "pip", "playwright",
  "pnpm", "prettier", "prisma", "psql", "pytest", "rake", "rg", "rspec", "rubocop", "ruff", "tsc", "vitest", "wc", "wget",
]);

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeReportedPath(rawPath, options = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
    return null;
  }
  const projectRoot = path.resolve(options.projectRoot || options.cwd || process.cwd());
  const cwd = path.resolve(options.cwd || projectRoot);
  const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
  if (!isWithin(projectRoot, candidate)) {
    return "<external>";
  }
  const relative = path.relative(projectRoot, candidate).split(path.sep).join("/");
  return relative || ".";
}

export function createToolFacts() {
  return {
    calls: 0,
    by_name: {},
    patterns: {
      shell_calls: 0,
      opaque_shell_calls: 0,
      rtk_wrapped_calls: 0,
      rtk_supported_calls: 0,
      unwrapped_rtk_supported_calls: 0,
      rg_calls: 0,
      grep_calls: 0,
      find_calls: 0,
      cat_calls: 0,
      test_calls: 0,
      broad_test_calls: 0,
      read_calls: 0,
      search_calls: 0,
      write_calls: 0,
      failed_calls: 0,
    },
  };
}

function increment(bucket, key, amount = 1) {
  bucket[key] = (bucket[key] || 0) + amount;
}

export function observeCommand(command, patterns) {
  if (typeof command !== "string") {
    patterns.opaque_shell_calls += 1;
    return;
  }
  patterns.shell_calls += 1;
  const compact = command.trim().replace(/\s+/g, " ");
  if (!compact) {
    patterns.opaque_shell_calls += 1;
    return;
  }
  let wrapped = false;
  let supported = false;
  let unwrappedSupported = false;
  for (const segment of compact.split(/(?:&&|\|\||;|\|)/)) {
    const match = segment.trim().match(/^(?:\w+=\S+\s+)*(?:(rtk)\s+)?([^\s]+)/);
    if (!match) continue;
    const isWrapped = match[1] === "rtk";
    const executable = path.basename(match[2]);
    wrapped ||= isWrapped;
    if (RTK_SUPPORTED_COMMANDS.has(executable)) {
      supported = true;
      if (!isWrapped) unwrappedSupported = true;
    }
  }
  if (wrapped) patterns.rtk_wrapped_calls += 1;
  if (supported) patterns.rtk_supported_calls += 1;
  if (unwrappedSupported) patterns.unwrapped_rtk_supported_calls += 1;
  if (/(?:^|[;&|]\s*|\brtk\s+)rg(?:\s|$)/.test(compact)) patterns.rg_calls += 1;
  if (/(?:^|[;&|]\s*)grep(?:\s|$)/.test(compact)) patterns.grep_calls += 1;
  if (/(?:^|[;&|]\s*)find(?:\s|$)/.test(compact)) patterns.find_calls += 1;
  if (/(?:^|[;&|]\s*)cat(?:\s|$)/.test(compact)) patterns.cat_calls += 1;
  if (/\b(?:pnpm|npm|yarn)\s+test\b|\bnode\s+--test\b|\bpytest\b|\bcargo\s+test\b/.test(compact)) {
    patterns.test_calls += 1;
    const focused = /(?:^|\s)--(?:filter|testNamePattern|testPathPattern)(?:=|\s)/.test(compact)
      || /(?:^|\s)-(?:t|k)(?:=|\s)/.test(compact)
      || /(?:^|\s)(?:\.{0,2}\/)?tests?\/\S+/.test(compact)
      || /(?:^|\s)\S+\.(?:test|spec)\.[A-Za-z0-9]+(?=\s|$)/.test(compact)
      || /\bcargo\s+test\s+(?!-)(?:\S+)/.test(compact);
    if (!focused) patterns.broad_test_calls += 1;
  }
}

export function observeTool(toolFacts, name, input, options = {}) {
  const toolName = String(name || "unknown");
  toolFacts.calls += 1;
  increment(toolFacts.by_name, toolName);
  const lower = toolName.toLowerCase();
  const paths = [];

  if (lower === "read" || lower.endsWith("view_image")) {
    toolFacts.patterns.read_calls += 1;
    paths.push({ raw: input?.file_path ?? input?.path, operation: "read" });
  } else if (["edit", "write", "multiedit", "artifact"].includes(lower)) {
    toolFacts.patterns.write_calls += 1;
    paths.push({ raw: input?.file_path ?? input?.path, operation: "write" });
  } else if (["grep", "glob", "search"].includes(lower)) {
    toolFacts.patterns.search_calls += 1;
    paths.push({ raw: input?.path, operation: "search" });
  } else if (lower === "bash" || lower === "exec_command") {
    observeCommand(input?.command ?? input?.cmd, toolFacts.patterns);
  } else if (lower === "apply_patch") {
    toolFacts.patterns.write_calls += 1;
    const patchText = typeof input?.patch === "string" ? input.patch : "";
    for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)) {
      const normalized = normalizeReportedPath(match[1], options);
      if (normalized) {
        paths.push({ normalized, operation: "write", source: "patch-header", confidence: "high" });
      }
    }
  } else if (lower === "functions.exec" || lower === "custom_tool_call") {
    toolFacts.patterns.shell_calls += 1;
    toolFacts.patterns.opaque_shell_calls += 1;
  }

  return paths.flatMap(({ raw, normalized: alreadyNormalized, operation, source = "structured-tool", confidence = "high" }) => {
    if (alreadyNormalized) return [{ path: alreadyNormalized, operation, source, confidence }];
    const normalized = normalizeReportedPath(raw, options);
    return normalized ? [{ path: normalized, operation, source, confidence }] : [];
  });
}

export function mergeFileEvents(events) {
  const merged = new Map();
  for (const event of events) {
    const key = `${event.path}\0${event.operation}\0${event.source}\0${event.confidence}`;
    const current = merged.get(key);
    if (current) {
      current.events += 1;
    } else {
      merged.set(key, { ...event, events: 1 });
    }
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path) || a.operation.localeCompare(b.operation));
}
