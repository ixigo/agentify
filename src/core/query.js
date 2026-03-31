import path from "node:path";

import {
  closeIndexDatabase,
  loadModuleDependencies,
  loadModules,
  openIndexDatabase,
  searchIndex,
} from "./db.js";
import { getChangedFilesSince } from "./git.js";

function normalizePath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function findOwningModule(modules, filePath) {
  const normalized = normalizePath(filePath);
  const sorted = [...modules].sort((left, right) => right.root_path.length - left.root_path.length);
  for (const moduleInfo of sorted) {
    if (
      moduleInfo.root_path === "."
      || normalized === moduleInfo.root_path
      || normalized.startsWith(`${moduleInfo.root_path}/`)
    ) {
      return moduleInfo;
    }
  }
  return null;
}

export async function queryOwner(root, filePath) {
  const db = openIndexDatabase(root);
  try {
    const modules = loadModules(db);
    const owner = findOwningModule(modules, filePath);
    const normalized = normalizePath(filePath);

    if (!owner) {
      return { file: normalized, module_id: null, message: "No owning module found" };
    }

    return {
      file: normalized,
      module_id: owner.id,
      module_name: owner.name,
      module_root: owner.root_path,
      doc_path: owner.doc_path,
      stack: owner.stack,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryDeps(root, moduleId) {
  const db = openIndexDatabase(root);
  try {
    const modules = loadModules(db);
    const moduleInfo = modules.find((item) => item.id === moduleId);
    if (!moduleInfo) {
      return { module_id: moduleId, error: "Module not found" };
    }
    const deps = loadModuleDependencies(db, moduleId);
    return {
      module_id: moduleId,
      depends_on: deps.dependsOn,
      used_by: deps.usedBy,
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function queryChanged(root, sinceCommit) {
  const db = openIndexDatabase(root);
  try {
    const modules = loadModules(db);
    const changed = await getChangedFilesSince(root, sinceCommit);
    const affectedModules = new Map();

    for (const entry of changed) {
      const owner = findOwningModule(modules, entry.path);
      if (!owner) {
        continue;
      }
      if (!affectedModules.has(owner.id)) {
        affectedModules.set(owner.id, {
          module_id: owner.id,
          module_name: owner.name,
          changed_files: [],
        });
      }
      affectedModules.get(owner.id).changed_files.push({
        status: entry.status,
        path: entry.path,
      });
    }

    return {
      since: sinceCommit,
      affected_modules: Array.from(affectedModules.values()),
    };
  } finally {
    closeIndexDatabase(db);
  }
}

export async function querySearch(root, term) {
  const db = openIndexDatabase(root);
  try {
    return {
      term,
      ...searchIndex(db, term),
    };
  } finally {
    closeIndexDatabase(db);
  }
}
