import path from "node:path";
import { readJson, exists } from "./fs.js";
import { getChangedFilesSince } from "./git.js";

export async function queryOwner(root, filePath) {
  const index = await readJson(path.join(root, ".agents", "index.json"));
  const normalized = filePath.split(path.sep).join("/");

  const sorted = [...index.modules].sort(
    (a, b) => b.root_path.length - a.root_path.length
  );

  for (const mod of sorted) {
    if (
      mod.root_path === "." ||
      normalized.startsWith(`${mod.root_path}/`) ||
      normalized === mod.root_path
    ) {
      return {
        file: normalized,
        module_id: mod.id,
        module_name: mod.name,
        module_root: mod.root_path,
        doc_path: mod.doc_path,
        metadata_path: mod.metadata_path,
      };
    }
  }
  return { file: normalized, module_id: null, message: "No owning module found" };
}

export async function queryDeps(root, moduleId) {
  const index = await readJson(path.join(root, ".agents", "index.json"));
  const graphPath = path.join(root, ".agents", "graphs", "deps.json");

  if (!(await exists(graphPath))) {
    return { module_id: moduleId, error: "Dependency graph not found" };
  }

  const graph = await readJson(graphPath);
  const mod = index.modules.find((m) => m.id === moduleId);
  if (!mod) return { module_id: moduleId, error: "Module not found" };

  const dependsOn = new Set();
  const usedBy = new Set();

  for (const edge of graph.edges) {
    const fromMod = index.modules.find(
      (m) => edge.from === m.root_path || edge.from.startsWith(`${m.root_path}/`)
    );
    const toMod = index.modules.find(
      (m) => edge.to === m.root_path || edge.to.startsWith(`${m.root_path}/`)
    );
    if (fromMod?.id === moduleId && toMod && toMod.id !== moduleId) {
      dependsOn.add(toMod.id);
    }
    if (toMod?.id === moduleId && fromMod && fromMod.id !== moduleId) {
      usedBy.add(fromMod.id);
    }
  }

  return {
    module_id: moduleId,
    depends_on: Array.from(dependsOn),
    used_by: Array.from(usedBy),
  };
}

export async function queryChanged(root, sinceCommit) {
  const index = await readJson(path.join(root, ".agents", "index.json"));
  const changed = await getChangedFilesSince(root, sinceCommit);

  const affectedModules = new Map();
  for (const entry of changed) {
    for (const mod of index.modules) {
      if (
        mod.root_path === "." ||
        entry.path.startsWith(`${mod.root_path}/`)
      ) {
        if (!affectedModules.has(mod.id)) {
          affectedModules.set(mod.id, { module_id: mod.id, changed_files: [] });
        }
        affectedModules.get(mod.id).changed_files.push({
          status: entry.status,
          path: entry.path,
        });
      }
    }
  }

  return {
    since: sinceCommit,
    affected_modules: Array.from(affectedModules.values()),
  };
}
