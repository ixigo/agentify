#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function decodeText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAttributes(rawAttributes) {
  const attributes = {};
  const expression =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of rawAttributes.matchAll(expression)) {
    attributes[match[1].toLowerCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function collectTags(html, tagName) {
  const expression = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  return [...html.matchAll(expression)].map((match) => ({
    attributes: parseAttributes(match[1]),
  }));
}

function firstMetaContent(html, key, value) {
  for (const meta of collectTags(html, "meta")) {
    if (meta.attributes[key] === value) {
      return meta.attributes.content || "";
    }
  }
  return "";
}

function canonicalHref(html) {
  for (const link of collectTags(html, "link")) {
    const relations = String(link.attributes.rel || "")
      .toLowerCase()
      .split(/\s+/);
    if (relations.includes("canonical")) {
      return link.attributes.href || "";
    }
  }
  return "";
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function extractJsonLd(html) {
  const blocks = [];
  const expression = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(expression)) {
    const attributes = parseAttributes(match[1]);
    if ((attributes.type || "").toLowerCase() !== "application/ld+json") {
      continue;
    }
    try {
      const schema = JSON.parse(match[2].trim());
      blocks.push({
        ok: true,
        type: schema?.["@type"] || "",
        schema,
      });
    } catch (error) {
      blocks.push({
        ok: false,
        type: "",
        error: error.message,
      });
    }
  }
  return blocks;
}

function headingOutline(html) {
  const headings = [];
  const expression = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of html.matchAll(expression)) {
    headings.push({
      level: Number(match[1]),
      text: decodeText(match[2]),
    });
  }
  return headings;
}

function visibleWordCount(html) {
  const text = decodeText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
  );
  return text ? text.split(/\s+/).length : 0;
}

export function auditHtml(
  html,
  { expectCanonical = "", status = null, finalUrl = "" } = {}
) {
  const errors = [];
  const warnings = [];
  const title = decodeText(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  );
  const description = firstMetaContent(html, "name", "description");
  const robots = firstMetaContent(html, "name", "robots");
  const canonical = canonicalHref(html);
  const htmlAttributes = parseAttributes(
    html.match(/<html\b([^>]*)>/i)?.[1] || ""
  );
  const headings = headingOutline(html);
  const h1Count = headings.filter((heading) => heading.level === 1).length;
  const schemas = extractJsonLd(html);
  const images = collectTags(html, "img").map(({ attributes }) => attributes);
  const anchors = collectTags(html, "a").map(({ attributes }) => attributes);

  if (status !== null && status >= 400) {
    errors.push(`Route returned HTTP ${status}.`);
  }
  if (!title) {
    errors.push("Missing non-empty title.");
  }
  if (!description) {
    errors.push("Missing non-empty meta description.");
  }
  if (!canonical) {
    errors.push("Missing canonical link.");
  }
  if (
    expectCanonical &&
    normalizeUrl(canonical) !== normalizeUrl(expectCanonical)
  ) {
    errors.push(
      `Canonical mismatch: expected ${expectCanonical}, received ${canonical || "(missing)"}.`
    );
  }
  if (!htmlAttributes.lang) {
    errors.push("Missing html lang attribute.");
  }
  if (h1Count !== 1) {
    errors.push(`Expected exactly one h1, found ${h1Count}.`);
  }
  if (!/<main\b/i.test(html)) {
    errors.push("Missing main landmark.");
  }

  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index].level > headings[index - 1].level + 1) {
      warnings.push(
        `Heading level jumps from h${headings[index - 1].level} to h${headings[index].level}.`
      );
    }
  }

  const invalidSchemas = schemas.filter((schema) => !schema.ok);
  for (const schema of invalidSchemas) {
    errors.push(`Invalid JSON-LD: ${schema.error}`);
  }
  if (schemas.length === 0) {
    warnings.push("No JSON-LD blocks found.");
  }

  images.forEach((image, index) => {
    if (!Object.hasOwn(image, "alt")) {
      errors.push(`Image ${index + 1} is missing an alt attribute.`);
    }
    if (!image.width || !image.height) {
      warnings.push(`Image ${index + 1} is missing explicit width or height.`);
    }
  });

  if (robots.toLowerCase().includes("noindex")) {
    warnings.push("Route is marked noindex.");
  }
  if (visibleWordCount(html) < 100) {
    warnings.push(
      "Rendered document has fewer than 100 visible words; review thin content."
    );
  }

  return {
    schema_version: 1,
    ok: errors.length === 0,
    target: {
      final_url: finalUrl,
      status,
    },
    metadata: {
      title,
      description,
      robots,
      canonical,
      lang: htmlAttributes.lang || "",
    },
    content: {
      visible_word_count: visibleWordCount(html),
      headings,
      h1_count: h1Count,
      image_count: images.length,
      anchor_count: anchors.length,
      landmarks: {
        header: collectTags(html, "header").length,
        nav: collectTags(html, "nav").length,
        main: collectTags(html, "main").length,
        footer: collectTags(html, "footer").length,
      },
    },
    structured_data: {
      count: schemas.length,
      types: schemas.filter((schema) => schema.ok).map((schema) => schema.type),
      invalid_count: invalidSchemas.length,
    },
    errors,
    warnings: [...new Set(warnings)],
  };
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Agentify-PHP-Astro-Audit/1.0",
      },
    });
    return {
      html: await response.text(),
      finalUrl: response.url,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadHtml(target) {
  if (/^https?:\/\//i.test(target)) {
    return fetchHtml(target);
  }
  const filePath = path.resolve(target);
  return {
    html: await fs.readFile(filePath, "utf8"),
    finalUrl: pathToFileURL(filePath).href,
    status: null,
  };
}

function parseArgs(argv) {
  const result = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result.positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

async function writeOutput(outputPath, payload) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${payload}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.positional[0];
  if (!target) {
    throw new Error(
      "Usage: audit-rendered-route.mjs <url-or-html-file> [--expect-canonical <url>] [--output <json-file>] [--pretty]"
    );
  }

  const loaded = await loadHtml(target);
  const report = auditHtml(loaded.html, {
    expectCanonical:
      args["expect-canonical"] || args["expected-canonical"] || "",
    finalUrl: loaded.finalUrl,
    status: loaded.status,
  });
  const payload = JSON.stringify(report, null, args.pretty ? 2 : 0);
  const outputPath = args.output || args.out;

  if (outputPath) {
    await writeOutput(path.resolve(outputPath), payload);
  }
  process.stdout.write(`${payload}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
