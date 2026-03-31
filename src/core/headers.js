import fs from "node:fs/promises";
import path from "node:path";

import { relative } from "./fs.js";

export const AGENTIFY_HEADER_START = "/** @agentify";

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

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

export function splitLicense(text, eol = "\n") {
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
        prefix: `${licenseLines.join(eol)}${eol}`,
        rest: lines.slice(index).join(eol)
      };
    }
  }
  return { prefix: "", rest: text };
}

export function stripLeadingAgentifyHeader(text) {
  const match = text.match(/^((?:[ \t]*\r?\n)*)(?:\/\*\*\s*@agentify[\s\S]*?\*\/|\/\*\s*@agentify[\s\S]*?\*\/|"""@agentify[\s\S]*?""")(?:\r?\n){1,2}/);
  return match ? `${match[1]}${text.slice(match[0].length)}` : text;
}

export function renderHeader({ moduleName, summary, relativePath, stack, eol = "\n" }) {
  const summaryPayload = summary && typeof summary === "object" ? summary : { summary };
  const summaryLines = [
    `module: ${moduleName}`,
    `path: ${relativePath}`,
  ];

  if (summaryPayload.schema) {
    summaryLines.push(`schema: ${summaryPayload.schema}`);
  }
  if (summaryPayload.project) {
    summaryLines.push(`project: ${summaryPayload.project}`);
  }
  if (summaryPayload.surface?.kind) {
    summaryLines.push(`surface: ${summaryPayload.surface.kind}`);
  }
  if (summaryPayload.surface?.role) {
    summaryLines.push(`role: ${summaryPayload.surface.role}`);
  }
  if (summaryPayload.surface?.surfaceKey) {
    summaryLines.push(`surfaceKey: ${summaryPayload.surface.surfaceKey}`);
  }
  if (Array.isArray(summaryPayload.exports) && summaryPayload.exports.length > 0) {
    summaryLines.push(`exports: ${summaryPayload.exports.join(", ")}`);
  }
  if (Array.isArray(summaryPayload.runtimeDeps) && summaryPayload.runtimeDeps.length > 0) {
    summaryLines.push(`runtimeDeps: ${summaryPayload.runtimeDeps.join(", ")}`);
  }
  if (Array.isArray(summaryPayload.typeDeps) && summaryPayload.typeDeps.length > 0) {
    summaryLines.push(`typeDeps: ${summaryPayload.typeDeps.join(", ")}`);
  }
  if (summaryPayload.freshness) {
    summaryLines.push(`freshness: ${summaryPayload.freshness}`);
  }
  summaryLines.push(`summary: ${summaryPayload.summary || ""}`);

  if (stack === "python") {
    return [
      "\"\"\"@agentify",
      ...summaryLines,
      "\"\"\"",
      "",
      ""
    ].join(eol);
  }

  if (stack === "dotnet") {
    return [
      "/* @agentify",
      ...summaryLines.map((line) => ` * ${line}`),
      " */",
      "",
      ""
    ].join(eol);
  }

  return [
    "/** @agentify",
    ...summaryLines.map((line) => ` * ${line}`),
    " */",
    "",
    ""
  ].join(eol);
}

export function applyHeaderToSource(source, header) {
  const eol = detectEol(source);
  const normalizedHeader = header.replace(/\r?\n/g, eol);
  const shebangMatch = source.match(/^#!.*\n/);
  const shebang = shebangMatch ? shebangMatch[0] : "";
  let body = shebang ? source.slice(shebang.length) : source;
  const { prefix, rest } = splitLicense(body, eol);
  return `${shebang}${prefix}${normalizedHeader}${stripLeadingAgentifyHeader(rest)}`;
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
    stack: syntax === "jsdoc" ? "ts" : syntax === "python" ? "python" : "dotnet",
    eol: detectEol(source)
  });
  const next = applyHeaderToSource(source, header);
  if (next === source) {
    return { changed: false, skipped: false };
  }

  await fs.writeFile(absolutePath, next, "utf8");
  return { changed: true, skipped: false };
}
