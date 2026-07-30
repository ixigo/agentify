#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<\?[\s\S]*?\?>/g, " {{php}} ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectMatches(source, regex, mapper) {
  const results = [];
  for (const match of source.matchAll(regex)) {
    results.push(mapper(match));
  }
  return results;
}

function collectPhpMatches(source, regex, mapper) {
  const results = [];
  const phpBlockRegex = /<\?(?:php|=)?([\s\S]*?)\?>/gi;

  for (const blockMatch of source.matchAll(phpBlockRegex)) {
    const blockSource = blockMatch[1];
    const blockOffset =
      blockMatch.index + blockMatch[0].indexOf(blockSource);

    for (const match of blockSource.matchAll(regex)) {
      match.index += blockOffset;
      results.push(mapper(match));
    }
  }

  return results;
}

export function inventoryPhpSource(source, { filePath = "" } = {}) {
  const includes = collectPhpMatches(
    source,
    /\b(include|include_once|require|require_once)\s*(?:\(\s*)?["']([^"']+)["']/g,
    (match) => ({
      kind: match[1],
      path: match[2],
      line: lineNumberAt(source, match.index),
    })
  );

  const requestInputs = collectMatches(
    source,
    /\$_(GET|POST|REQUEST|COOKIE|SERVER)\s*\[\s*["']([^"']+)["']\s*\]/g,
    (match) => `${match[1].toLowerCase()}.${match[2]}`
  );

  const functions = collectMatches(
    source,
    /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    (match) => ({
      name: match[1],
      line: lineNumberAt(source, match.index),
    })
  );

  const headings = collectMatches(
    source,
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (match) => ({
      level: Number(match[1]),
      text: stripMarkup(match[2]),
      line: lineNumberAt(source, match.index),
    })
  );

  const absoluteUrls = collectMatches(
    source,
    /https?:\/\/[^\s"'<>\\)]+/g,
    (match) => match[0].replace(/[;,]+$/, "")
  );

  const apiPaths = collectMatches(
    source,
    /["']([^"'\r\n]*\/api\/[^"'\r\n]*)["']/gi,
    (match) => match[1]
  );

  const dataKeys = collectMatches(
    source,
    /\$([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*["']([A-Za-z0-9_.-]+)["']\s*\]/g,
    (match) => `${match[1]}.${match[2]}`
  );

  const schemaTypes = collectMatches(
    source,
    /["']@type["']\s*:\s*["']([^"']+)["']/g,
    (match) => match[1]
  );

  const redirectHeaders = collectMatches(
    source,
    /\bheader\s*\(([\s\S]*?Location[\s\S]*?)\)\s*;/gi,
    (match) => ({
      expression: stripMarkup(match[1]).slice(0, 240),
      line: lineNumberAt(source, match.index),
    })
  );

  const metaNames = collectMatches(
    source,
    /<meta\b[^>]*(?:name|property)\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (match) => match[1].toLowerCase()
  );

  const linkRelations = collectMatches(
    source,
    /<link\b[^>]*rel\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (match) => match[1].toLowerCase()
  );

  const ampTags = collectMatches(
    source,
    /<(amp-[a-z0-9-]+)\b/gi,
    (match) => match[1].toLowerCase()
  );

  const inventory = {
    schema_version: 1,
    source: {
      path: filePath ? path.resolve(filePath) : "",
      lines: source.split(/\r?\n/).length,
      bytes: Buffer.byteLength(source),
    },
    php: {
      includes,
      request_inputs: unique(requestInputs),
      functions,
      data_keys: unique(dataKeys),
      curl_calls: (source.match(/\bcurl_(?:init|setopt|exec)\s*\(/g) || [])
        .length,
      redirect_headers: redirectHeaders,
    },
    document: {
      doctype_present: /<!doctype\s+html/i.test(source),
      html_language_dynamic:
        /<html\b[^>]*lang\s*=\s*["'][^"']*<\?php/i.test(source),
      amp_enabled:
        /<html\b[^>]*(?:⚡|\bamp(?:\s|=|>))/i.test(source) ||
        ampTags.length > 0,
      headings,
      h1_count: headings.filter((heading) => heading.level === 1).length,
      meta_names: unique(metaNames),
      link_relations: unique(linkRelations),
      schema_types: unique(schemaTypes),
      image_count:
        (source.match(/<img\b/gi) || []).length +
        (source.match(/<amp-img\b/gi) || []).length,
      script_count: (source.match(/<script\b/gi) || []).length,
      style_block_count: (source.match(/<style\b/gi) || []).length,
      inline_style_attribute_count: (source.match(/\sstyle\s*=/gi) || [])
        .length,
      amp_tags: unique(ampTags),
    },
    network: {
      absolute_urls: unique(absoluteUrls),
      api_paths: unique([
        ...apiPaths,
        ...absoluteUrls.filter((value) => /\/api\//i.test(value)),
      ]),
    },
  };

  inventory.review_hints = [
    includes.length > 0
      ? "Trace included files; the inventory does not inline their behavior."
      : "",
    inventory.php.curl_calls > 0
      ? "Replace cURL with a server-only, timeout-bounded Astro data adapter."
      : "",
    inventory.document.amp_enabled
      ? "Preserve AMP-era behavior, not AMP runtime markup or boilerplate."
      : "",
    inventory.document.h1_count !== 1
      ? `Legacy source contains ${inventory.document.h1_count} h1 blocks; verify conditional rendering and produce one h1 in the migrated response.`
      : "",
  ].filter(Boolean);

  return inventory;
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
  const inputPath = args.positional[0];
  if (!inputPath) {
    throw new Error(
      "Usage: inventory-php-page.mjs <php-file> [--output <json-file>] [--pretty]"
    );
  }

  const resolvedInput = path.resolve(inputPath);
  const source = await fs.readFile(resolvedInput, "utf8");
  const inventory = inventoryPhpSource(source, { filePath: resolvedInput });
  const payload = JSON.stringify(inventory, null, args.pretty ? 2 : 0);
  const outputPath = args.output || args.out;

  if (outputPath) {
    await writeOutput(path.resolve(outputPath), payload);
  }
  process.stdout.write(`${payload}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
