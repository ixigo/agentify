#!/usr/bin/env node
// Managed by Agentify: plan-to-html hook.
// Renders a Claude Code plan (markdown) to a standalone HTML file in <project>/plans/.
//
// Entry points:
//   1. PostToolUse hook on ExitPlanMode: reads hook JSON on stdin, extracts .tool_input.plan
//   2. Manual use: node plan-to-html.mjs --md <file.md> [--cwd <projectDir>]
//
// Always exits 0 so it can never block the plan flow.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}

function inline(md) {
  let s = esc(md);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text, href) => `<a href="${escAttr(href)}">${text}</a>`);
  return s;
}

// Minimal, dependency-free markdown -> HTML (headings, lists, code, tables, quotes, hr).
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  const listStack = [];

  const closeLists = (depth = 0) => {
    while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
      } else {
        closeLists();
      }
      inCode = !inCode;
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeLists();
      out.push("<hr/>");
      i++;
      continue;
    }

    if (
      line.includes("|")
      && i + 1 < lines.length
      && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
      && lines[i + 1].includes("-")
    ) {
      closeLists();
      const cells = (r) =>
        r
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => inline(c.trim()));
      const rows = [`<tr>${cells(line).map((c) => `<th>${c}</th>`).join("")}</tr>`];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(`<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`);
        i++;
      }
      out.push(`<div class="tw"><table>${rows.join("")}</table></div>`);
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2) + 1;
      const kind = /^\d/.test(li[2]) ? "ol" : "ul";
      while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
      while (listStack.length < depth) {
        listStack.push(kind);
        out.push(`<${kind}>`);
      }
      out.push(`<li>${inline(li[3])}</li>`);
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      closeLists();
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(inline(lines[i].replace(/^>\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${buf.join("<br/>")}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      closeLists();
      i++;
      continue;
    }

    closeLists();
    const buf = [line];
    while (
      i + 1 < lines.length
      && lines[i + 1].trim() !== ""
      && !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>|\||\s*---)/.test(lines[i + 1])
    ) {
      i++;
      buf.push(lines[i]);
    }
    out.push(`<p>${buf.map(inline).join(" ")}</p>`);
    i++;
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  closeLists();
  return out.join("\n");
}

const CSS = `
:root{--fg:#1a1a1a;--bg:#fdfdfb;--muted:#5f6368;--accent:#0b57d0;--border:#e0e0dc;--code:#f4f4f0}
@media(prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#161618;--muted:#9aa0a6;--accent:#8ab4f8;--border:#33343a;--code:#232327}}
*{box-sizing:border-box}body{margin:0 auto;max-width:60rem;padding:2rem 1.5rem 5rem;font:16px/1.65 -apple-system,'Segoe UI',Roboto,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:1.9rem;line-height:1.25;border-bottom:2px solid var(--accent);padding-bottom:.5rem}
h2{font-size:1.4rem;margin-top:2.2rem;border-bottom:1px solid var(--border);padding-bottom:.3rem}
h3{font-size:1.15rem;margin-top:1.6rem}
a{color:var(--accent)}code{background:var(--code);border:1px solid var(--border);border-radius:4px;padding:.1em .35em;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:1rem;overflow-x:auto}
pre code{background:none;border:none;padding:0}
blockquote{margin:1rem 0;padding:.5rem 1rem;border-left:4px solid var(--accent);background:var(--code);border-radius:0 6px 6px 0;color:var(--muted)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid var(--border);padding:.5rem .75rem;text-align:left;vertical-align:top}th{background:var(--code)}
hr{border:none;border-top:1px solid var(--border);margin:2rem 0}
.meta{color:var(--muted);font-size:.85rem;margin-bottom:2rem}
li{margin:.25rem 0}
`;

function render(planMd, cwd) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const firstHeading = (planMd.match(/^#{1,6}\s+(.+)$/m) || [])[1] || "plan";
  const slug =
    firstHeading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";

  const dir = join(cwd, "plans");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ts}-${slug}.html`);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(firstHeading)}</title><style>${CSS}</style></head>
<body>
<div class="meta">Plan generated ${now.toLocaleString()} - ${esc(cwd)}</div>
${mdToHtml(planMd)}
</body></html>`;
  writeFileSync(file, html);
  return file;
}

try {
  const args = process.argv.slice(2);
  let planMd;
  let cwd;

  const mdIdx = args.indexOf("--md");
  if (mdIdx !== -1) {
    planMd = readFileSync(resolve(args[mdIdx + 1]), "utf8");
    const cwdIdx = args.indexOf("--cwd");
    cwd = cwdIdx !== -1 ? resolve(args[cwdIdx + 1]) : process.cwd();
  } else {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) process.exit(0);
    const payload = JSON.parse(raw);
    planMd = payload?.tool_input?.plan;
    cwd = payload?.cwd || process.cwd();
  }

  if (!planMd || !planMd.trim()) process.exit(0);

  const file = render(planMd, cwd);
  const rel = relative(cwd, file);
  const displayPath = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
  console.log(
    JSON.stringify({
      systemMessage: `Plan saved as HTML: ${displayPath} (open in a browser)`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `The approved plan was rendered to a standalone HTML document at ${file}. Mention this path to the user.`,
      },
    }),
  );
} catch {
  // Never block the plan flow.
  process.exit(0);
}
