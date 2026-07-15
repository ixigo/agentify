import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function browserOpenCommand(targetPath, platform = process.platform) {
  const targetUrl = pathToFileURL(path.resolve(targetPath)).href;
  if (platform === "darwin") {
    return { command: "open", args: [targetUrl] };
  }
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", targetUrl],
    };
  }
  return { command: "xdg-open", args: [targetUrl] };
}

export async function openInBrowser(targetPath, options = {}) {
  const invocation = browserOpenCommand(targetPath, options.platform);
  const execFileImpl = options.execFileImpl || execFile;
  await new Promise((resolve, reject) => {
    execFileImpl(
      invocation.command,
      invocation.args,
      { timeout: options.timeoutMs || 5_000, windowsHide: true },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
  return invocation;
}
