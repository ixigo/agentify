import pc from "picocolors";
import Table from "cli-table3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json");

let _silent = false;

export function setSilent(value) {
  _silent = value;
}

export async function withSilent(value, action) {
  const previousSilent = _silent;
  _silent = value;
  try {
    return await action();
  } finally {
    _silent = previousSilent;
  }
}

function isSilent() {
  return _silent;
}

function hasColor() {
  return !process.env.NO_COLOR && process.stderr.isTTY;
}

export const VERSION = pkg.version;

export function banner() {
  if (isSilent()) return;
  const v = hasColor() ? pc.dim(`v${VERSION}`) : `v${VERSION}`;
  const name = hasColor() ? pc.bold(pc.cyan("agentify")) : "agentify";
  process.stderr.write(`\n  ${name} ${v}\n\n`);
}

export function log(msg) {
  if (isSilent()) return;
  const prefix = hasColor() ? pc.dim("  >") : "  >";
  process.stderr.write(`${prefix} ${msg}\n`);
}

export function step(msg) {
  if (isSilent()) return;
  const prefix = hasColor() ? pc.cyan("  ~") : "  ~";
  process.stderr.write(`${prefix} ${msg}\n`);
}

export function success(msg) {
  if (isSilent()) return;
  const icon = hasColor() ? pc.green("  +") : "  +";
  const text = hasColor() ? pc.green(msg) : msg;
  process.stderr.write(`${icon} ${text}\n`);
}

export function warn(msg) {
  if (isSilent()) return;
  const icon = hasColor() ? pc.yellow("  !") : "  !";
  const text = hasColor() ? pc.yellow(msg) : msg;
  process.stderr.write(`${icon} ${text}\n`);
}

export function error(msg) {
  const icon = hasColor() ? pc.red("  x") : "  x";
  const text = hasColor() ? pc.red(msg) : msg;
  process.stderr.write(`${icon} ${text}\n`);
}

export function dim(msg) {
  return hasColor() ? pc.dim(msg) : msg;
}

export function bold(msg) {
  return hasColor() ? pc.bold(msg) : msg;
}

export function cyan(msg) {
  return hasColor() ? pc.cyan(msg) : msg;
}

export function green(msg) {
  return hasColor() ? pc.green(msg) : msg;
}

export function red(msg) {
  return hasColor() ? pc.red(msg) : msg;
}

export function yellow(msg) {
  return hasColor() ? pc.yellow(msg) : msg;
}

export function label(key, value) {
  const k = hasColor() ? pc.dim(key + ":") : key + ":";
  const v = hasColor() ? pc.bold(value) : value;
  return `${k} ${v}`;
}

export async function createSpinner(text) {
  if (isSilent() || !process.stderr.isTTY) {
    return {
      start() { return this; },
      stop() {},
      success(msg) { if (!isSilent()) process.stderr.write(`  ${pc.green("+")} ${msg || text}\n`); },
      error(msg) { process.stderr.write(`  ${pc.red("x")} ${msg || text}\n`); },
      message: text,
    };
  }
  const { default: yoctoSpinner } = await import("yocto-spinner");
  return yoctoSpinner({ text, stream: process.stderr });
}

export function table(headers, rows) {
  const t = new Table({
    head: hasColor() ? headers.map((h) => pc.bold(pc.cyan(h))) : headers,
    style: {
      head: [],
      border: [],
      "padding-left": 1,
      "padding-right": 1,
    },
    chars: {
      top: hasColor() ? pc.dim("-") : "-",
      "top-mid": hasColor() ? pc.dim("+") : "+",
      "top-left": hasColor() ? pc.dim("+") : "+",
      "top-right": hasColor() ? pc.dim("+") : "+",
      bottom: hasColor() ? pc.dim("-") : "-",
      "bottom-mid": hasColor() ? pc.dim("+") : "+",
      "bottom-left": hasColor() ? pc.dim("+") : "+",
      "bottom-right": hasColor() ? pc.dim("+") : "+",
      left: hasColor() ? pc.dim("|") : "|",
      "left-mid": hasColor() ? pc.dim("+") : "+",
      mid: hasColor() ? pc.dim("-") : "-",
      "mid-mid": hasColor() ? pc.dim("+") : "+",
      right: hasColor() ? pc.dim("|") : "|",
      "right-mid": hasColor() ? pc.dim("+") : "+",
      middle: hasColor() ? pc.dim("|") : "|",
    },
  });
  for (const row of rows) {
    t.push(row);
  }
  return t.toString();
}

export function box(title, lines) {
  if (isSilent()) return;
  const heading = hasColor() ? pc.bold(pc.cyan(title)) : title;
  const rule = hasColor() ? pc.dim("  " + "-".repeat(40)) : "  " + "-".repeat(40);
  process.stderr.write(`\n${rule}\n  ${heading}\n${rule}\n`);
  for (const line of lines) {
    process.stderr.write(`  ${line}\n`);
  }
  process.stderr.write(`${rule}\n\n`);
}

export function formatFailure(failure) {
  if (typeof failure === "string") {
    return hasColor() ? `  ${pc.red("x")} ${failure}` : `  x ${failure}`;
  }
  const cat = hasColor()
    ? pc.bgRed(pc.white(pc.bold(` ${failure.category} `)))
    : `[${failure.category}]`;
  const filePath = hasColor() ? pc.bold(failure.path) : failure.path;
  const msg = failure.message;
  const rem = failure.remediation
    ? `\n      ${hasColor() ? pc.dim(failure.remediation) : failure.remediation}`
    : "";
  return `  ${cat} ${filePath}\n      ${msg}${rem}`;
}

export function newline() {
  if (isSilent()) return;
  process.stderr.write("\n");
}

export function createInlineProgress({ enabled = !isSilent() && process.stderr.isTTY } = {}) {
  let active = false;

  function render(prefix, message, finalize = false) {
    if (!enabled) {
      return;
    }
    process.stderr.write(`\r\x1b[2K${prefix} ${message}${finalize ? "\n" : ""}`);
    active = !finalize;
  }

  return {
    update(percent, message) {
      const prefix = hasColor() ? pc.cyan(`  ~ ${percent}%`) : `  ~ ${percent}%`;
      render(prefix, message);
    },
    success(message) {
      const prefix = hasColor() ? pc.green("  +") : "  +";
      render(prefix, message, true);
    },
    warn(message) {
      const prefix = hasColor() ? pc.yellow("  !") : "  !";
      render(prefix, message, true);
    },
    error(message) {
      const prefix = hasColor() ? pc.red("  x") : "  x";
      render(prefix, message, true);
    },
    clear() {
      if (!enabled || !active) {
        return;
      }
      process.stderr.write("\r\x1b[2K");
      active = false;
    },
  };
}
