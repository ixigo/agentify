import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_CANDIDATES = ["agentify.visual.mjs", "agentify.visual.js", ".agentify/visual.config.mjs"];

export const DEFAULT_VIEWPORTS = {
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
};

const DEFAULT_BLOCKED_HOSTS = [
  "googletagmanager", "google-analytics", "doubleclick", "clevertap", "firebase",
  "facebook", "hotjar", "sentry", "branch.io", "segment",
];

export function findConfigFile(root, explicit) {
  if (explicit) {
    const resolved = path.resolve(root, explicit);
    if (!fs.existsSync(resolved)) throw new Error(`Visual config not found: ${resolved}`);
    return resolved;
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const resolved = path.join(root, candidate);
    if (fs.existsSync(resolved)) return resolved;
  }
  throw new Error(`No visual config found in ${root}. Create agentify.visual.mjs (see: agentify visual init) or pass --config <file>.`);
}

export async function loadVisualConfig(root, explicit) {
  const file = findConfigFile(root, explicit);
  const imported = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const raw = typeof imported.default === "function" ? await imported.default({ root }) : imported.default;
  return { file, config: normalizeVisualConfig(raw, { root, file }) };
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function requireId(item, kind, index) {
  if (!item || typeof item !== "object") throw new Error(`${kind}[${index}] must be an object`);
  if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(item.id)) {
    throw new Error(`${kind}[${index}].id must be a simple identifier (letters, digits, . _ -)`);
  }
}

function assertUnique(items, kind) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${kind} id: ${item.id}`);
    seen.add(item.id);
  }
}

function normalizeCommand(command, label) {
  if (command === undefined || command === null || command === false) return null;
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== "string")) {
    throw new Error(`${label} must be an array of strings, e.g. ["node", "server.mjs", "--port", "{port}"]`);
  }
  return command;
}

export function normalizeVisualConfig(raw, { root = process.cwd(), file = "agentify.visual.mjs" } = {}) {
  if (!raw || typeof raw !== "object") throw new Error(`${file} must export a config object (or a function returning one)`);

  const server = raw.server ? {
    command: normalizeCommand(raw.server.command, "server.command"),
    cwd: path.resolve(root, raw.server.cwd ?? "."),
    env: raw.server.env ?? {},
    readyPath: raw.server.readyPath ?? "/",
    timeoutMs: raw.server.timeoutMs ?? 90_000,
  } : null;
  if (!server?.command && !raw.baseUrl) throw new Error("Set server.command (started for you) or baseUrl (an already running app)");

  const clients = asArray(raw.clients).length ? asArray(raw.clients) : [{ id: "default", label: "Default" }];
  clients.forEach((client, index) => requireId(client, "clients", index));
  assertUnique(clients, "client");

  const flows = asArray(raw.flows);
  if (!flows.length) throw new Error("Define at least one flow in flows[]");
  flows.forEach((flow, index) => {
    requireId(flow, "flows", index);
    if (!flow.start) throw new Error(`flows[${index}] (${flow.id}) needs start: { path } or a function returning it`);
    const steps = asArray(flow.steps).length ? asArray(flow.steps) : [{ id: flow.id, title: flow.title ?? flow.id }];
    steps.forEach((step, stepIndex) => {
      requireId(step, `flows[${index}].steps`, stepIndex);
      if (step.run !== undefined && typeof step.run !== "function") throw new Error(`Step ${flow.id}/${step.id} run must be a function`);
    });
    assertUnique(steps, `step in flow ${flow.id}`);
    flow.steps = steps;
  });
  assertUnique(flows, "flow");

  const viewports = { ...DEFAULT_VIEWPORTS, ...(raw.viewports ?? {}) };
  const defaultViewports = asArray(raw.defaultViewports).length ? asArray(raw.defaultViewports) : ["mobile"];
  for (const name of defaultViewports) if (!viewports[name]) throw new Error(`defaultViewports lists unknown viewport: ${name}`);

  const build = raw.build ? {
    command: normalizeCommand(raw.build.command, "build.command"),
    outDir: raw.build.outDir ?? "dist",
    vite: raw.build.vite === true ? {} : raw.build.vite || null,
    pages: asArray(raw.build.pages),
    cwd: path.resolve(root, raw.build.cwd ?? "."),
  } : null;
  if (build && !build.command && !build.vite) throw new Error("build needs command (and outDir) or vite: true");

  return {
    root,
    file,
    baseUrl: raw.baseUrl ?? null,
    port: raw.port ?? 4391,
    server,
    clients: clients.map((client) => ({ label: client.id, query: {}, ...client })),
    flows: flows.map((flow) => ({ group: "Flows", title: flow.id, ...flow })),
    viewports,
    defaultViewports,
    query: raw.query ?? {},
    waitForApp: raw.waitForApp ?? null,
    network: {
      block: [...DEFAULT_BLOCKED_HOSTS, ...asArray(raw.network?.block)],
      cacheExternal: raw.network?.cacheExternal ?? true,
      ignoreConsole: asArray(raw.network?.ignoreConsole),
      track: raw.network?.track ?? null,
    },
    fullPage: raw.fullPage ?? true,
    dpr: raw.dpr ?? 1,
    maxShotHeight: raw.maxShotHeight ?? 12_000,
    diffThreshold: raw.diffThreshold ?? 0.001,
    stepTimeoutMs: raw.stepTimeoutMs ?? 10_000,
    install: normalizeCommand(raw.install, "install"),
    baseline: { copy: asArray(raw.baseline?.copy), ref: raw.baseline?.ref ?? null },
    build,
  };
}

export function pickById(all, value, kind) {
  if (!value || value === "all" || value === true) return all;
  const wanted = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.some((item) => item.id === id));
  if (unknown.length) throw new Error(`Unknown ${kind}: ${unknown.join(", ")}. Known: ${all.map((item) => item.id).join(", ")}`);
  return all.filter((item) => wanted.includes(item.id));
}

export function pickViewports(config, value) {
  if (!value) return config.defaultViewports;
  const names = value === "all" ? Object.keys(config.viewports) : String(value).split(",").map((entry) => entry.trim());
  for (const name of names) if (!config.viewports[name]) throw new Error(`Unknown viewport: ${name}. Known: ${Object.keys(config.viewports).join(", ")}`);
  return names;
}
