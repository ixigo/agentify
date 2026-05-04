import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRepositoryIndex } from "../src/core/indexer.js";

async function withTempDir(setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-indexer-"));
  await setup(root);
  return root;
}

const entrypointCases = [
  {
    name: "python",
    entryPath: "src/demo/main.py",
    setup: async (root) => {
      await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"demo\"\n", "utf8");
      await fs.mkdir(path.join(root, "src", "demo"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "demo", "__init__.py"), "", "utf8");
      await fs.writeFile(path.join(root, "src", "demo", "main.py"), "def main():\n    return None\n", "utf8");
    },
  },
  {
    name: "dotnet",
    entryPath: "app/Program.cs",
    setup: async (root) => {
      await fs.mkdir(path.join(root, "app"), { recursive: true });
      await fs.writeFile(path.join(root, "app", "app.csproj"), "<Project />\n", "utf8");
      await fs.writeFile(path.join(root, "app", "Program.cs"), "public class Program {}\n", "utf8");
    },
  },
  {
    name: "java",
    entryPath: "app/src/main/java/com/demo/Application.java",
    setup: async (root) => {
      await fs.mkdir(path.join(root, "app", "src", "main", "java", "com", "demo"), { recursive: true });
      await fs.writeFile(path.join(root, "app", "build.gradle"), "plugins {}\n", "utf8");
      await fs.writeFile(path.join(root, "app", "src", "main", "java", "com", "demo", "Application.java"), "class Application {}\n", "utf8");
    },
  },
  {
    name: "kotlin",
    entryPath: "app/src/main/kotlin/com/demo/MainActivity.kt",
    setup: async (root) => {
      await fs.writeFile(path.join(root, "settings.gradle.kts"), "include(\":app\")\n", "utf8");
      await fs.mkdir(path.join(root, "app", "src", "main", "kotlin", "com", "demo"), { recursive: true });
      await fs.writeFile(path.join(root, "app", "build.gradle.kts"), "plugins {}\n", "utf8");
      await fs.writeFile(path.join(root, "app", "src", "main", "kotlin", "com", "demo", "MainActivity.kt"), "class MainActivity\n", "utf8");
    },
  },
  {
    name: "swift",
    entryPath: "Sources/App/App.swift",
    setup: async (root) => {
      await fs.writeFile(path.join(root, "Package.swift"), "// swift-tools-version: 5.9\n", "utf8");
      await fs.mkdir(path.join(root, "Sources", "App"), { recursive: true });
      await fs.writeFile(path.join(root, "Sources", "App", "App.swift"), "struct App {}\n", "utf8");
    },
  },
  {
    name: "go",
    entryPath: "cmd/server/main.go",
    setup: async (root) => {
      await fs.writeFile(path.join(root, "go.mod"), "module example.com/agentify-go\n\ngo 1.22\n", "utf8");
      await fs.mkdir(path.join(root, "cmd", "server"), { recursive: true });
      await fs.writeFile(path.join(root, "cmd", "server", "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    },
  },
  {
    name: "rust",
    entryPath: "src/lib.rs",
    setup: async (root) => {
      await fs.writeFile(path.join(root, "Cargo.toml"), "[package]\nname = \"agentify-rust\"\nversion = \"0.1.0\"\n", "utf8");
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "lib.rs"), "pub fn run() {}\n", "utf8");
    },
  },
];

for (const item of entrypointCases) {
  test(`buildRepositoryIndex marks ${item.name} entrypoints`, async () => {
    const root = await withTempDir(item.setup);
    const index = await buildRepositoryIndex(root, { languages: "auto", moduleStrategy: "auto" });
    const moduleInfo = index.modules.find((moduleRow) => moduleRow.stack === item.name);
    const fileInfo = index.files.find((fileRow) => fileRow.path === item.entryPath);

    assert.ok(moduleInfo, `expected ${item.name} module`);
    assert.ok(moduleInfo.entry_files.includes(item.entryPath));
    assert.equal(fileInfo?.is_entrypoint, 1);
  });
}
