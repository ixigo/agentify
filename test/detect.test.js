import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectModules, detectStacks } from "../src/core/detect.js";

async function withTempDir(setup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-detect-"));
  await setup(root);
  return root;
}

test("detectStacks identifies TypeScript repo", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src", "index.ts"), "export const ok = true;\n");
  });

  const stacks = await detectStacks(root, { languages: "auto" });
  assert.equal(stacks[0].name, "ts");
});

test("detectModules uses src subfolders for TS modules", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    await fs.mkdir(path.join(dir, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(dir, "src", "payments"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "auth", "index.ts"), "export {};\n");
    await fs.writeFile(path.join(dir, "src", "payments", "index.ts"), "export {};\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "ts");
  assert.deepEqual(
    modules.map((item) => item.rootPath).sort(),
    ["src/auth", "src/payments"]
  );
});

test("detectModules identifies Python package modules", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname='demo'\n");
    await fs.mkdir(path.join(dir, "src", "demo"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "demo", "__init__.py"), "\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "python");
  assert.equal(modules[0].rootPath, "src/demo");
});

test("detectStacks identifies Kotlin Android repo", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "settings.gradle.kts"), "include(\":app\")\n");
    await fs.writeFile(path.join(dir, "build.gradle.kts"), "plugins {}\n");
    await fs.mkdir(path.join(dir, "app", "src", "main", "kotlin", "com", "demo"), { recursive: true });
    await fs.writeFile(path.join(dir, "app", "src", "main", "kotlin", "com", "demo", "MainActivity.kt"), "class MainActivity\n");
  });

  const stacks = await detectStacks(root, { languages: "auto" });
  assert.equal(stacks[0].name, "kotlin");
});

test("detectModules identifies Gradle modules for Kotlin repos", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "settings.gradle.kts"), "include(\":app\", \":feature:payments\")\n");
    await fs.mkdir(path.join(dir, "app"), { recursive: true });
    await fs.mkdir(path.join(dir, "feature", "payments"), { recursive: true });
    await fs.writeFile(path.join(dir, "app", "build.gradle.kts"), "plugins {}\n");
    await fs.writeFile(path.join(dir, "feature", "payments", "build.gradle.kts"), "plugins {}\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "kotlin");
  assert.deepEqual(
    modules.map((item) => item.rootPath).sort(),
    ["app", "feature/payments"]
  );
});

test("detectStacks identifies Swift repo", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "Package.swift"), "// swift-tools-version: 5.9\n");
    await fs.mkdir(path.join(dir, "Sources", "App"), { recursive: true });
    await fs.writeFile(path.join(dir, "Sources", "App", "main.swift"), "print(\"hi\")\n");
  });

  const stacks = await detectStacks(root, { languages: "auto" });
  assert.equal(stacks[0].name, "swift");
});

test("detectModules identifies Swift package modules", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "Package.swift"), "// swift-tools-version: 5.9\n");
    await fs.mkdir(path.join(dir, "Sources", "Core"), { recursive: true });
    await fs.mkdir(path.join(dir, "Sources", "UI"), { recursive: true });
    await fs.writeFile(path.join(dir, "Sources", "Core", "App.swift"), "struct App {}\n");
    await fs.writeFile(path.join(dir, "Sources", "UI", "Screen.swift"), "struct Screen {}\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "swift");
  assert.deepEqual(
    modules.map((item) => item.rootPath).sort(),
    ["Sources/Core", "Sources/UI"]
  );
});

test("detectStacks identifies Go repo", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "go.mod"), "module example.com/agentify-go\n\ngo 1.22\n");
    await fs.mkdir(path.join(dir, "cmd", "server"), { recursive: true });
    await fs.writeFile(path.join(dir, "cmd", "server", "main.go"), "package main\n\nfunc main() {}\n");
  });

  const stacks = await detectStacks(root, { languages: "auto" });
  assert.equal(stacks[0].name, "go");
});

test("detectModules identifies Go package modules", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "go.mod"), "module example.com/agentify-go\n\ngo 1.22\n");
    await fs.mkdir(path.join(dir, "cmd", "server"), { recursive: true });
    await fs.mkdir(path.join(dir, "internal", "auth"), { recursive: true });
    await fs.mkdir(path.join(dir, "pkg", "billing"), { recursive: true });
    await fs.writeFile(path.join(dir, "cmd", "server", "main.go"), "package main\n\nfunc main() {}\n");
    await fs.writeFile(path.join(dir, "internal", "auth", "token.go"), "package auth\n");
    await fs.writeFile(path.join(dir, "pkg", "billing", "client.go"), "package billing\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "go");
  assert.deepEqual(
    modules.map((item) => item.rootPath).sort(),
    ["cmd/server", "internal/auth", "pkg/billing"]
  );
});

test("detectStacks identifies Rust repo", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "Cargo.toml"), "[package]\nname = \"agentify-rust\"\nversion = \"0.1.0\"\n");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "lib.rs"), "pub fn parse_token() -> String { String::new() }\n");
  });

  const stacks = await detectStacks(root, { languages: "auto" });
  assert.equal(stacks[0].name, "rust");
});

test("detectModules identifies Rust workspace crates", async () => {
  const root = await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "Cargo.toml"),
      "[workspace]\nmembers = [\"crates/core\", \"crates/api\"]\n",
      "utf8",
    );
    await fs.mkdir(path.join(dir, "crates", "core", "src"), { recursive: true });
    await fs.mkdir(path.join(dir, "crates", "api", "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "crates", "core", "Cargo.toml"),
      "[package]\nname = \"agentify-core\"\nversion = \"0.1.0\"\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "crates", "api", "Cargo.toml"),
      "[package]\nname = \"agentify-api\"\nversion = \"0.1.0\"\n",
      "utf8",
    );
    await fs.writeFile(path.join(dir, "crates", "core", "src", "lib.rs"), "pub fn parse_token() {}\n");
    await fs.writeFile(path.join(dir, "crates", "api", "src", "lib.rs"), "pub fn handle_login() {}\n");
  });

  const modules = await detectModules(root, { moduleStrategy: "auto" }, "rust");
  assert.deepEqual(
    modules.map((item) => item.rootPath).sort(),
    ["crates/api", "crates/core"]
  );
});
