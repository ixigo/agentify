import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { browserOpenCommand, openInBrowser } from "../src/core/browser.js";

test("browserOpenCommand uses platform-native launchers without a shell", () => {
  const reportPath = path.resolve("report output.html");
  const reportUrl = pathToFileURL(reportPath).href;

  assert.deepEqual(browserOpenCommand(reportPath, "darwin"), {
    command: "open",
    args: [reportUrl],
  });
  assert.deepEqual(browserOpenCommand(reportPath, "linux"), {
    command: "xdg-open",
    args: [reportUrl],
  });
  assert.deepEqual(browserOpenCommand(reportPath, "win32"), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", reportUrl],
  });
});

test("openInBrowser waits for the launcher and returns its invocation", async () => {
  let call;
  const execFileImpl = (command, args, options, callback) => {
    call = { command, args, options };
    callback(null);
  };

  const invocation = await openInBrowser("report.html", {
    platform: "darwin",
    execFileImpl,
    timeoutMs: 1234,
  });

  assert.deepEqual(invocation, { command: "open", args: [pathToFileURL(path.resolve("report.html")).href] });
  assert.equal(call.command, "open");
  assert.equal(call.options.timeout, 1234);
  assert.equal(call.options.windowsHide, true);
});

test("openInBrowser surfaces launcher failures for the CLI fallback", async () => {
  const failure = Object.assign(new Error("missing opener"), { code: "ENOENT" });
  await assert.rejects(
    () => openInBrowser("report.html", {
      platform: "linux",
      execFileImpl: (_command, _args, _options, callback) => callback(failure),
    }),
    /missing opener/,
  );
});
