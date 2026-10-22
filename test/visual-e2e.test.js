import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runVisual } from "../src/core/visual/run.js";
import { resolvePlaywright } from "../src/core/visual/server.js";

const fixture = path.resolve("test/fixtures/visual-app");

function playwrightAvailable() {
  try {
    resolvePlaywright([fixture]);
    return true;
  } catch {
    return false;
  }
}

function commit(root, message) {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=agentify", "-c", "user.email=agentify@example.com", "commit", "-qm", message], { cwd: root });
}

test("visual compares a dummy app against its previous commit", { skip: !playwrightAvailable() && "Playwright is not installed (set AGENTIFY_PLAYWRIGHT_FROM to run)", timeout: 240_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentify-visual-e2e-")));
  t.after(() => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", path.join(root, ".agentify", "visual", "baseline", "repo")], { cwd: root, stdio: "ignore" });
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(fixture, root, { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n.agentify/\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  commit(root, "before");
  const css = path.join(root, "src", "style.css");
  fs.writeFileSync(css, fs.readFileSync(css, "utf8").replace("#fc790d", "#0770e4"));
  const cart = path.join(root, "src", "cart.js");
  fs.appendFileSync(cart, `\nexport const promo = ${JSON.stringify(Array.from({ length: 600 }, (_, i) => `offer-${i}`))};\n`);
  commit(root, "after");

  const lines = [];
  const result = await runVisual({ root, baseline: "HEAD~1", workers: 2, port: 4471, log: (line) => lines.push(line) });

  assert.equal(result.summary.failed, 0, lines.join("\n"));
  assert.equal(result.manifest.results.length, 6);
  assert.equal(result.summary.beforeFailed, 0);
  assert.ok(result.summary.changed >= 3, `expected the recolour to change screens: ${JSON.stringify(result.summary)}`);
  const greenHome = result.manifest.results.find((entry) => entry.client === "green" && entry.flow === "home");
  assert.ok(greenHome.diffs.home.ratio < 0.001, "the green partner overrides the brand colour, so its home is unchanged");
  const menuError = result.manifest.results.find((entry) => entry.client === "default" && entry.flow === "menu-error");
  assert.deepEqual(menuError.after.steps[0].networkErrors, ["500 GET /api/menu"]);
  assert.match(result.manifest.build.why[0], /^Total JavaScript grew by \+/);
  assert.ok(result.manifest.build.fileDiff.find((file) => file.name === "assets/cart.js").delta > 0);
  for (const entry of result.manifest.results) {
    for (const step of entry.after.steps.filter((candidate) => candidate.shot)) {
      assert.ok(fs.existsSync(path.join(result.outDir, step.shot)), step.shot);
      assert.ok(fs.existsSync(path.join(result.outDir, entry.diffs[step.id].diffShot)));
    }
  }
  assert.match(fs.readFileSync(result.report, "utf8"), /Visual Review/);
});
