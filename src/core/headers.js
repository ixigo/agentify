import fs from "node:fs/promises";
import path from "node:path";

import { relative } from "./fs.js";

export const AGENTIFY_HEADER_START = "/** @agentify";

function detectCommentSyntax(filePath) {
  if (filePath.endsWith(".py")) {
    return "python";
  }
  if (
    filePath.endsWith(".cs")
    || filePath.endsWith(".java")
    || filePath.endsWith(".kt")
    || filePath.endsWith(".kts")
    || filePath.endsWith(".swift")
  ) {
    return "csharp";
  }
  return "jsdoc";
}

function isGenerated(text) {
  return /@generated|do not edit/i.test(text);
}

function splitLicense(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("/*") || trimmed.startsWith("//")) {
    const lines = text.split(/\r?\n/);
    const licenseLines = [];
    let index = 0;
    let inBlock = false;
    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("/*")) {
        inBlock = true;
      }
      if (line.startsWith("//") || inBlock || line.startsWith("*")) {
        licenseLines.push(line);
      } else {
        break;
      }
      if (inBlock && line.endsWith("*/")) {
        index += 1;
        break;
      }
    }
    if (/copyright|license/i.test(licenseLines.join("\n"))) {
      return {
        prefix: `${licenseLines.join("\n")}\n`,
        rest: lines.slice(index).join("\n")
      };
    }
  }
  return { prefix: "", rest: text };
}

export function renderHeader({ moduleName, summary, relativePath, stack }) {
  if (stack === "python") {
    return `"""@agentify
module: ${moduleName}
path: ${relativePath}
summary: ${summary}
"""

`;
  }

  if (stack === "dotnet") {
    return `/* @agentify
 * module: ${moduleName}
 * path: ${relativePath}
 * summary: ${summary}
 */

`;
  }

  return `/** @agentify
 * module: ${moduleName}
 * path: ${relativePath}
 * summary: ${summary}
 */

`;
}

export function applyHeaderToSource(source, header) {
  const shebangMatch = source.match(/^#!.*\n/);
  const shebang = shebangMatch ? shebangMatch[0] : "";
  let body = shebang ? source.slice(shebang.length) : source;

  const existingHeader = body.match(/^\/\*\*\s*@agentify[\s\S]*?\*\/\n\n?/);
  if (existingHeader) {
    return `${shebang}${header}${body.slice(existingHeader[0].length)}`;
  }

  const existingBlockHeader = body.match(/^\/\*\s*@agentify[\s\S]*?\*\/\n\n?/);
  if (existingBlockHeader) {
    return `${shebang}${header}${body.slice(existingBlockHeader[0].length)}`;
  }

  const existingPyHeader = body.match(/^"""@agentify[\s\S]*?"""\n\n?/);
  if (existingPyHeader) {
    return `${shebang}${header}${body.slice(existingPyHeader[0].length)}`;
  }

  const { prefix, rest } = splitLicense(body);
  return `${shebang}${prefix}${header}${rest}`;
}

export async function updateFileHeader(root, moduleName, filePath, summary, stack) {
  const absolutePath = path.join(root, filePath);
  const source = await fs.readFile(absolutePath, "utf8");
  if (isGenerated(source)) {
    return { changed: false, skipped: true };
  }

  const syntax = detectCommentSyntax(filePath);
  const header = renderHeader({
    moduleName,
    summary,
    relativePath: relative(root, absolutePath),
    stack: syntax === "jsdoc" ? "ts" : syntax === "python" ? "python" : "dotnet"
  });
  const next = applyHeaderToSource(source, header);
  if (next === source) {
    return { changed: false, skipped: false };
  }

  await fs.writeFile(absolutePath, next, "utf8");
  return { changed: true, skipped: false };
}
