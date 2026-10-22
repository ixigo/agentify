import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const KB = 1024;
const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

export function viteStatsWrapper(projectConfigPath) {
  return `import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeConfig } from "vite";
import projectConfig from ${JSON.stringify(projectConfigPath)};

function statsPlugin(statsFile) {
  return {
    name: "agentify-visual-stats",
    enforce: "post",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).map((output) => output.type === "asset"
        ? { type: "asset", fileName: output.fileName }
        : {
            type: "chunk",
            fileName: output.fileName,
            isEntry: output.isEntry,
            isDynamicEntry: output.isDynamicEntry,
            facadeModuleId: output.facadeModuleId,
            imports: output.imports,
            dynamicImports: output.dynamicImports,
            importedCss: [...(output.viteMetadata?.importedCss ?? [])],
            modules: Object.fromEntries(Object.entries(output.modules).map(([id, info]) => [id, info.renderedLength])),
          });
      writeFileSync(statsFile, JSON.stringify({ chunks }));
    },
  };
}

export default async (env) => {
  const base = typeof projectConfig === "function" ? await projectConfig(env) : projectConfig;
  const { test: _test, ...rest } = base ?? {};
  const outDir = process.env.AGENTIFY_VISUAL_OUT;
  return mergeConfig(rest, {
    plugins: [statsPlugin(resolve(outDir, "..", "stats.json"))],
    build: { outDir, emptyOutDir: true, reportCompressedSize: false },
    logLevel: "warn",
  });
};
`;
}

function findViteConfig(root, explicit) {
  if (explicit) return path.resolve(root, explicit);
  const found = VITE_CONFIGS.map((name) => path.join(root, name)).find((file) => fs.existsSync(file));
  if (!found) throw new Error(`build.vite is set but no vite.config.* exists in ${root}`);
  return found;
}

export function runBuild({ label, root, build, outRoot, log = () => {}, spawn = spawnSync }) {
  const targetDir = path.join(outRoot, label);
  const dist = path.join(targetDir, "dist");
  fs.mkdirSync(targetDir, { recursive: true });
  const startedAt = Date.now();
  let result;
  if (build.vite) {
    const projectConfig = findViteConfig(root, build.vite.config);
    const wrapper = path.join(root, ".agentify", "visual", "vite.stats.config.mts");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, viteStatsWrapper(path.relative(path.dirname(wrapper), projectConfig).split(path.sep).join("/").replace(/^(?!\.)/, "./")));
    const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
    if (!fs.existsSync(viteBin)) throw new Error(`vite is not installed in ${root}`);
    log(`Building ${label} with vite`);
    result = spawn(process.execPath, [viteBin, "build", "--config", wrapper, "--mode", build.vite.mode ?? "production"], {
      cwd: root, encoding: "utf8", env: { ...process.env, AGENTIFY_VISUAL_OUT: dist, NODE_ENV: "production" },
    });
  } else {
    log(`Building ${label}: ${build.command.join(" ")}`);
    result = spawn(build.command[0], build.command.slice(1), { cwd: build.cwd, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } });
  }
  if (result.status !== 0) throw new Error(`${label} build failed:\n${String(result.stderr || result.stdout || "").slice(-2000)}`);
  const outputDir = build.vite ? dist : path.resolve(build.cwd, build.outDir);
  if (!fs.existsSync(outputDir)) throw new Error(`${label} build produced no ${outputDir}`);
  if (!build.vite) fs.cpSync(outputDir, dist, { recursive: true });
  const statsFile = path.join(targetDir, "stats.json");
  return {
    label,
    root,
    dist,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    stats: fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile, "utf8")) : null,
  };
}

function walk(dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return fs.statSync(full).isDirectory() ? walk(full) : [full];
  });
}

export function normalizeAssetName(file) {
  return file.replace(/\\/g, "/").replace(/[-.][A-Za-z0-9_-]{8,}(?=\.(js|mjs|css)$)/, "");
}

export function measure(buffer) {
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

function cssFacts(text) {
  return {
    rules: (text.match(/\{/g) ?? []).length,
    customProperties: new Set(text.match(/--[a-zA-Z0-9-]+(?=\s*:)/g) ?? []).size,
  };
}

export function ownerOf(id, root) {
  if (id.startsWith("\0") || id.includes("vite/preload-helper") || id.includes("commonjsHelpers")) return { key: "bundler runtime", kind: "runtime" };
  const clean = id.split("?")[0].replace(/\\/g, "/");
  const marker = clean.lastIndexOf("node_modules/");
  if (marker >= 0) {
    const rest = clean.slice(marker + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    const pnpm = clean.match(/\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^_/]+)/);
    let version = pnpm && pnpm[1].replace("+", "/") === name ? pnpm[2] : undefined;
    if (!version) {
      try {
        version = JSON.parse(fs.readFileSync(path.join(clean.slice(0, marker), "node_modules", name, "package.json"), "utf8")).version;
      } catch {}
    }
    return { key: name, kind: "package", version };
  }
  const relative = path.relative(root, clean).replace(/\\/g, "/").split("/");
  if (relative[0] === "src") {
    const depth = ["pages", "components", "features", "routes", "views", "app"].includes(relative[1]) ? 3 : 2;
    const parts = relative.slice(0, depth);
    if (parts.length === depth && parts[depth - 1]?.includes(".")) parts.pop();
    return { key: parts.join("/"), kind: "source" };
  }
  return { key: relative.slice(0, 2).join("/"), kind: "other" };
}

function chunkClosure(byName, roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !byName.has(file)) continue;
    seen.add(file);
    stack.push(...(byName.get(file).imports ?? []));
  }
  return seen;
}

function moduleKey(root, id) {
  return path.relative(root, id.split("?")[0]).replace(/\\/g, "/").replace(/\.(tsx?|jsx?|mjs|mts)$/, "");
}

export function pageCosts({ stats, root, byFile, pages }) {
  if (!stats || !pages.length) return [];
  const chunks = stats.chunks.filter((entry) => entry.type === "chunk");
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const shell = chunkClosure(byName, chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName));
  const pageModules = new Set(pages.map((page) => page.module).filter(Boolean));
  const holds = (chunk, module) => (chunk.facadeModuleId && moduleKey(root, chunk.facadeModuleId) === module)
    || Object.keys(chunk.modules).some((id) => moduleKey(root, id) === module);
  const isRouteChunk = (chunk) => [...pageModules].some((module) => chunk.isDynamicEntry && holds(chunk, module));
  const gzipOf = (files) => [...files].reduce((sum, file) => sum + (byFile.get(file)?.gzip ?? 0), 0);
  return pages.map((page) => {
    const pageChunk = page.module ? chunks.find((chunk) => chunk.isDynamicEntry && holds(chunk, page.module)) : null;
    const own = pageChunk ? new Set([...chunkClosure(byName, [pageChunk.fileName])].filter((file) => !shell.has(file))) : new Set();
    const loaded = new Set([...shell, ...own]);
    const later = new Set();
    for (const file of loaded) {
      for (const dynamic of byName.get(file)?.dynamicImports ?? []) {
        const target = byName.get(dynamic);
        if (!target || isRouteChunk(target)) continue;
        for (const lazy of chunkClosure(byName, [dynamic])) if (!loaded.has(lazy)) later.add(lazy);
      }
    }
    const css = new Set([...loaded].flatMap((file) => byName.get(file)?.importedCss ?? []));
    return {
      id: page.id,
      label: page.label ?? page.id,
      route: page.route ?? null,
      found: !page.module || Boolean(pageChunk),
      shellJs: gzipOf(shell),
      pageJs: gzipOf(own),
      totalJs: gzipOf(loaded),
      laterJs: gzipOf(later),
      css: gzipOf(css),
    };
  });
}

export function analyzeBuild(result, { pages = [] } = {}) {
  const files = walk(result.dist).map((full) => {
    const file = path.relative(result.dist, full).replace(/\\/g, "/");
    const kind = /\.(m?js)$/.test(file) ? "js" : file.endsWith(".css") ? "css" : "asset";
    const body = fs.readFileSync(full);
    return { file, name: normalizeAssetName(file), kind, ...measure(body), ...(kind === "css" ? cssFacts(body.toString("utf8")) : {}) };
  });
  const byFile = new Map(files.map((entry) => [entry.file, entry]));
  const htmlFiles = files.filter((entry) => entry.file.endsWith(".html"));
  const initialFiles = new Set();
  for (const html of htmlFiles.length ? [htmlFiles.find((entry) => entry.file === "index.html") ?? htmlFiles[0]] : []) {
    const text = fs.readFileSync(path.join(result.dist, html.file), "utf8");
    for (const match of text.matchAll(/(?:src|href)="\.?\/?([^"?#]+\.(?:m?js|css))"/g)) initialFiles.add(match[1]);
  }
  if (result.stats) {
    const entries = result.stats.chunks.filter((chunk) => chunk.type === "chunk" && chunk.isEntry);
    const byName = new Map(result.stats.chunks.filter((chunk) => chunk.type === "chunk").map((chunk) => [chunk.fileName, chunk]));
    for (const file of chunkClosure(byName, entries.map((chunk) => chunk.fileName))) {
      initialFiles.add(file);
      for (const css of byName.get(file)?.importedCss ?? []) initialFiles.add(css);
    }
  }

  const groups = new Map();
  for (const chunk of result.stats?.chunks.filter((entry) => entry.type === "chunk") ?? []) {
    const measured = byFile.get(chunk.fileName);
    if (!measured) continue;
    const entries = Object.entries(chunk.modules);
    const total = entries.reduce((sum, [, length]) => sum + length, 0) || 1;
    for (const [id, length] of entries) {
      const owner = ownerOf(id, result.root);
      const share = length / total;
      const group = groups.get(owner.key) ?? { key: owner.key, kind: owner.kind, version: owner.version, gzip: 0, initialGzip: 0 };
      group.gzip += measured.gzip * share;
      if (initialFiles.has(chunk.fileName)) group.initialGzip += measured.gzip * share;
      group.version ??= owner.version;
      groups.set(owner.key, group);
    }
  }

  const sum = (list, field) => list.reduce((total, entry) => total + (entry[field] ?? 0), 0);
  const js = files.filter((entry) => entry.kind === "js");
  const css = files.filter((entry) => entry.kind === "css");
  const initial = files.filter((entry) => initialFiles.has(entry.file));
  return {
    label: result.label,
    seconds: result.seconds,
    attributed: Boolean(result.stats),
    files: files.map((entry) => ({ ...entry, initial: initialFiles.has(entry.file) })),
    groups: [...groups.values()],
    pages: pageCosts({ stats: result.stats, root: result.root, byFile, pages }),
    totals: {
      jsRaw: sum(js, "raw"), jsGzip: sum(js, "gzip"), jsBrotli: sum(js, "brotli"),
      cssRaw: sum(css, "raw"), cssGzip: sum(css, "gzip"), cssBrotli: sum(css, "brotli"),
      initialJsGzip: sum(initial.filter((entry) => entry.kind === "js"), "gzip"),
      initialCssGzip: sum(initial.filter((entry) => entry.kind === "css"), "gzip"),
      jsFiles: js.length,
      cssRules: sum(css, "rules"),
      cssCustomProperties: css.reduce((max, entry) => Math.max(max, entry.customProperties ?? 0), 0),
      otherRaw: sum(files.filter((entry) => entry.kind === "asset"), "raw"),
    },
  };
}

export const kb = (bytes) => (Math.abs(bytes) < KB ? `${Math.round(bytes)} B` : `${(bytes / KB).toFixed(1)} KB`);
export const signedKb = (bytes) => `${bytes >= 0 ? "+" : "−"}${kb(Math.abs(bytes))}`;
const pct = (before, after) => (before ? `${(((after - before) / before) * 100).toFixed(1)}%` : "new");

export function compareBuilds(before, after) {
  const keys = new Set([...before.groups, ...after.groups].map((group) => group.key));
  const groupDiff = [...keys].map((key) => {
    const b = before.groups.find((group) => group.key === key);
    const a = after.groups.find((group) => group.key === key);
    return {
      key,
      kind: (a ?? b).kind,
      versionBefore: b?.version,
      versionAfter: a?.version,
      gzipBefore: b?.gzip ?? 0,
      gzipAfter: a?.gzip ?? 0,
      initialBefore: b?.initialGzip ?? 0,
      initialAfter: a?.initialGzip ?? 0,
      delta: (a?.gzip ?? 0) - (b?.gzip ?? 0),
      status: !b ? "added" : !a ? "removed" : "changed",
    };
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const names = new Set([...before.files, ...after.files].filter((file) => file.kind !== "asset").map((file) => file.name));
  const fileDiff = [...names].map((name) => {
    const b = before.files.find((file) => file.name === name);
    const a = after.files.find((file) => file.name === name);
    return { name, kind: (a ?? b).kind, initial: Boolean(a?.initial || b?.initial), gzipBefore: b?.gzip ?? 0, gzipAfter: a?.gzip ?? 0, delta: (a?.gzip ?? 0) - (b?.gzip ?? 0) };
  }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const pageDiff = after.pages.map((page) => {
    const old = before.pages.find((candidate) => candidate.id === page.id) ?? {};
    return {
      id: page.id, label: page.label, route: page.route,
      totalBefore: old.totalJs ?? 0, totalAfter: page.totalJs,
      pageBefore: old.pageJs ?? 0, pageAfter: page.pageJs,
      laterBefore: old.laterJs ?? 0, laterAfter: page.laterJs,
      cssBefore: old.css ?? 0, cssAfter: page.css,
      delta: page.totalJs - (old.totalJs ?? 0),
    };
  });

  return { before, after, groupDiff, fileDiff, pageDiff, why: explainChange({ before, after, groupDiff, fileDiff, pageDiff }) };
}

export function explainChange({ before, after, groupDiff, fileDiff, pageDiff }) {
  const t0 = before.totals;
  const t1 = after.totals;
  const why = [];
  const jsDelta = t1.jsGzip - t0.jsGzip;
  why.push(`Total JavaScript ${jsDelta >= 0 ? "grew" : "shrank"} by ${signedKb(jsDelta)} gzip (${pct(t0.jsGzip, t1.jsGzip)}), from ${kb(t0.jsGzip)} to ${kb(t1.jsGzip)}.`);
  if (t0.initialJsGzip || t1.initialJsGzip) {
    why.push(`JavaScript loaded on first paint went from ${kb(t0.initialJsGzip)} to ${kb(t1.initialJsGzip)} gzip (${signedKb(t1.initialJsGzip - t0.initialJsGzip)}).`);
  }
  if (pageDiff.length) {
    const movers = [...pageDiff].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 3);
    why.push(`Biggest per-page changes: ${movers.map((page) => `${page.label} ${signedKb(page.delta)} (now ${kb(page.totalAfter)})`).join(", ")}.`);
  }
  const packages = groupDiff.filter((group) => group.kind === "package"
    && Math.abs(group.delta) >= (group.status === "changed" && group.versionBefore === group.versionAfter ? 2 : 0.5) * KB);
  for (const group of packages.slice(0, 8)) {
    const versions = group.versionBefore && group.versionAfter && group.versionBefore !== group.versionAfter
      ? ` (${group.versionBefore} → ${group.versionAfter})`
      : group.status === "added" && group.versionAfter ? ` (${group.versionAfter})`
        : group.status === "removed" && group.versionBefore ? ` (${group.versionBefore})` : "";
    const sameVersion = group.status === "changed" && group.versionBefore === group.versionAfter;
    const verb = group.status === "added" ? "is new in the bundle"
      : group.status === "removed" ? "is no longer bundled"
        : sameVersion ? `${group.delta > 0 ? "grew" : "shrank"} at the same version (more or fewer of its modules are imported)`
          : group.delta > 0 ? "grew" : "shrank";
    const firstPaint = Math.abs(group.initialAfter - group.initialBefore) >= 0.5 * KB ? `; first-paint share ${signedKb(group.initialAfter - group.initialBefore)}` : "";
    why.push(`${group.key}${versions} ${verb}: ${signedKb(group.delta)} gzip${firstPaint}.`);
  }
  const sources = groupDiff.filter((group) => group.kind === "source" && Math.abs(group.delta) >= 0.5 * KB);
  if (sources.length) why.push(`App source: ${sources.slice(0, 6).map((group) => `${group.key} ${signedKb(group.delta)}`).join(", ")}.`);
  if (!before.attributed || !after.attributed) {
    const files = fileDiff.filter((file) => Math.abs(file.delta) >= 0.5 * KB).slice(0, 5);
    if (files.length) why.push(`Largest file changes: ${files.map((file) => `${file.name} ${signedKb(file.delta)}`).join(", ")}.`);
  }
  const cssDelta = t1.cssGzip - t0.cssGzip;
  if (t0.cssGzip || t1.cssGzip) {
    why.push(`CSS ${cssDelta >= 0 ? "grew" : "shrank"} by ${signedKb(cssDelta)} gzip; rule count ${t0.cssRules} → ${t1.cssRules}, custom properties ${t0.cssCustomProperties} → ${t1.cssCustomProperties}.`);
  }
  const added = fileDiff.filter((file) => !file.gzipBefore).length;
  const removed = fileDiff.filter((file) => !file.gzipAfter).length;
  if (added || removed) why.push(`Code splitting: ${t0.jsFiles} → ${t1.jsFiles} JS files (${added} new names, ${removed} gone).`);
  return why;
}
