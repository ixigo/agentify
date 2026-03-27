import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sanitizeManagerPlan, sanitizeModuleResponse } from "./agent-contract.js";
import { buildManagerPrompt, buildManagerSchema, buildModulePrompt, buildModuleSchema } from "./prompts.js";

function summarizeModule(moduleInfo, files) {
  const examples = files.slice(0, 5).join(", ");
  return `${moduleInfo.name} owns code under ${moduleInfo.rootPath} and is indexed from ${examples || "its module root"}.`;
}

function inferPublicApi(files) {
  return files
    .filter((file) => /(index|public|exports|main|appdelegate|scenedelegate|application|mainactivity)\.(ts|tsx|js|jsx|py|cs|java|kt|kts|swift)$/i.test(file))
    .slice(0, 8)
    .map((file) => ({
      symbol: file.split("/").pop(),
      kind: "module",
      path: file
    }));
}

function fallbackArtifacts(moduleInfo, context) {
  const summary = summarizeModule(moduleInfo, context.files);
  const metadata = {
    schema_version: "1.0",
    module: {
      id: moduleInfo.id,
      name: moduleInfo.name,
      root_path: moduleInfo.rootPath,
      stack: moduleInfo.stack
    },
    summary,
    public_api: inferPublicApi(context.files),
    start_here: context.keyFiles.slice(0, 5).map((file) => ({
      path: file,
      why: "High-signal file selected by Agentify key-file ranking."
    })),
    dependencies: {
      depends_on: context.dependsOn.map((moduleId) => ({
        module_id: moduleId,
        reason: "Observed through deterministic graph scan."
      })),
      used_by: context.usedBy.map((moduleId) => ({
        module_id: moduleId,
        reason: "Observed through deterministic graph scan."
      }))
    },
    side_effects: ["none"],
    tests: context.files.filter((file) => /test|spec/.test(file)).slice(0, 10),
    docs: [`docs/modules/${moduleInfo.slug}.md`],
    tags: [moduleInfo.stack],
    freshness: {
      last_indexed_at: context.now,
      last_indexed_commit: context.headCommit
    }
  };

  const markdown = `# ${moduleInfo.name}

## Purpose
${summary}

## Boundaries
- Root: \`${moduleInfo.rootPath}\`
- Stack: \`${moduleInfo.stack}\`

## Public Surface
${metadata.public_api.length > 0 ? metadata.public_api.map((item) => `- \`${item.path}\``).join("\n") : "- No explicit export surface detected."}

## Start Reading Here
${metadata.start_here.length > 0 ? metadata.start_here.map((item) => `- \`${item.path}\`: ${item.why}`).join("\n") : "- No key files selected."}

## Dependencies
- Depends on: ${context.dependsOn.length > 0 ? context.dependsOn.join(", ") : "none"}
- Used by: ${context.usedBy.length > 0 ? context.usedBy.join(", ") : "none"}

## Tests and Config
${metadata.tests.length > 0 ? metadata.tests.map((item) => `- \`${item}\``).join("\n") : "- No tests detected in module scan."}
`;

  const headers = context.keyFiles.map((file) => ({
    path: file,
    summary
  }));

  return {
    markdown,
    metadata,
    headers,
    tokenUsage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    }
  };
}

export function parseCodexJsonl(text) {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) {
        usage.input_tokens = event.usage.input_tokens || 0;
        usage.output_tokens = event.usage.output_tokens || 0;
        usage.total_tokens = usage.input_tokens + usage.output_tokens;
      }
    } catch {
      // Ignore non-JSON noise from the CLI.
    }
  }

  return usage;
}

export function parseClaudeJson(text) {
  const payload = JSON.parse(text.trim());
  const usage = payload.usage || {};
  return {
    output: payload.structured_output,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
    }
  };
}

export function parseGeminiJson(text) {
  const trimmed = text.trim();
  const startIndex = trimmed.indexOf("{");
  if (startIndex === -1) {
    throw new Error("gemini output did not contain JSON");
  }
  const payload = JSON.parse(trimmed.slice(startIndex));
  const responseText = payload.response;
  const output = typeof responseText === "string" ? JSON.parse(responseText) : responseText;

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const models = payload.stats?.models || {};
  for (const modelStats of Object.values(models)) {
    inputTokens += modelStats?.tokens?.input || 0;
    outputTokens += modelStats?.tokens?.candidates || 0;
    totalTokens += modelStats?.tokens?.total || 0;
  }

  return {
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens || inputTokens + outputTokens
    }
  };
}

export function parseOpenCodeJsonl(text) {
  let output = null;
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        output = JSON.parse(event.part.text);
      }
      if (event.type === "step_finish" && event.part?.tokens) {
        usage.input_tokens = event.part.tokens.input || 0;
        usage.output_tokens = event.part.tokens.output || 0;
        usage.total_tokens = event.part.tokens.total || usage.input_tokens + usage.output_tokens;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  if (!output) {
    throw new Error("opencode output did not contain JSON text payload");
  }

  return { output, usage };
}

async function runChild(command, args, { cwd, env = {} } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      }
    });

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with code ${code}: ${stderrChunks.join("") || stdoutChunks.join("")}`));
    });
  });

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join("")
  };
}

async function runCodexExec({ root, prompt, schema, model }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-codex-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "result.json");
  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--sandbox",
    "workspace-write",
    "--cd",
    root,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath
  ];

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  const { stdout } = await runChild("codex", args, { cwd: root });

  const output = JSON.parse(await fs.readFile(outputPath, "utf8"));
  const usage = parseCodexJsonl(stdout);
  return { output, usage };
}

async function runClaudeExec({ root, prompt, schema, model }) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    "--json-schema",
    JSON.stringify(schema)
  ];

  if (model) {
    args.push("--model", model);
  }

  args.push(prompt);

  const { stdout } = await runChild("claude", args, { cwd: root });
  return parseClaudeJson(stdout);
}

async function runGeminiExec({ root, prompt, model }) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json"
  ];

  if (model) {
    args.push("--model", model);
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentify-gemini-home-"));
  const { stdout } = await runChild("gemini", args, {
    cwd: root,
    env: {
      HOME: home
    }
  });
  return parseGeminiJson(stdout);
}

async function runOpenCodeExec({ root, prompt, model }) {
  const args = [
    "run",
    prompt,
    "--format",
    "json",
    "--dir",
    root
  ];

  if (model) {
    args.push("--model", model);
  }

  const { stdout } = await runChild("opencode", args, { cwd: root });
  return parseOpenCodeJsonl(stdout);
}

function buildMetadataFromCodex(moduleInfo, context, response) {
  return {
    schema_version: "1.0",
    module: {
      id: moduleInfo.id,
      name: moduleInfo.name,
      root_path: moduleInfo.rootPath,
      stack: moduleInfo.stack
    },
    summary: response.summary,
    public_api: response.public_api,
    start_here: response.start_here,
    dependencies: {
      depends_on: context.dependsOn.map((moduleId) => ({
        module_id: moduleId,
        reason: "Observed through deterministic graph scan."
      })),
      used_by: context.usedBy.map((moduleId) => ({
        module_id: moduleId,
        reason: "Observed through deterministic graph scan."
      }))
    },
    side_effects: response.side_effects.length > 0 ? response.side_effects : ["none"],
    tests: context.files.map((file) => file.path).filter((file) => /test|spec/.test(file)).slice(0, 10),
    docs: [`docs/modules/${moduleInfo.slug}.md`],
    tags: [moduleInfo.stack],
    freshness: {
      last_indexed_at: context.now,
      last_indexed_commit: context.headCommit
    }
  };
}

function createLocalProvider() {
  return {
    name: "local",
    providerModel: "local-deterministic",
    async buildManagerPlan() {
      return {
        plan: {
          repo_summary: "",
          shared_conventions: [],
          module_focus: []
        },
        tokenUsage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
        }
      };
    },
    async generateModuleArtifacts(moduleInfo, context) {
      return fallbackArtifacts(moduleInfo, {
        ...context,
        files: context.files.map((item) => item.path)
      });
    }
  };
}

function createExternalProvider(config, options) {
  return {
    name: options.name,
    providerModel: config.model || options.defaultModel,
    async buildManagerPlan(repoContext) {
      try {
        const result = await options.run({
          root: repoContext.root,
          prompt: buildManagerPrompt(repoContext),
          schema: buildManagerSchema(),
          model: config.model
        });

        return {
          plan: sanitizeManagerPlan(result.output, new Set(repoContext.modules.map((item) => item.id))),
          tokenUsage: result.usage
        };
      } catch {
        return {
          plan: {
            repo_summary: "",
            shared_conventions: [],
            module_focus: []
          },
          tokenUsage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0
          }
        };
      }
    },
    async generateModuleArtifacts(moduleInfo, context) {
      const fallback = fallbackArtifacts(moduleInfo, {
        ...context,
        files: context.files.map((item) => item.path)
      });

      try {
        const prompt = buildModulePrompt(moduleInfo, context);
        const result = await options.run({
          root: context.root,
          prompt,
          schema: buildModuleSchema(),
          model: config.model
        });
        const sanitized = sanitizeModuleResponse(result.output, moduleInfo, new Set(context.keyFiles));

        const metadata = buildMetadataFromCodex(moduleInfo, context, result.output);
        return {
          markdown: sanitized.markdown,
          metadata: {
            ...metadata,
            summary: sanitized.summary,
            public_api: sanitized.public_api,
            start_here: sanitized.start_here,
            side_effects: sanitized.side_effects
          },
          headers: sanitized.header_summaries,
          tokenUsage: result.usage
        };
      } catch (error) {
        return {
          ...fallback,
          metadata: {
            ...fallback.metadata,
            summary: `${fallback.metadata.summary} Codex fallback reason: ${error.message}`
          }
        };
      }
    }
  };
}

export function createProvider(name, config = {}) {
  if (name === "local") {
    return createLocalProvider();
  }
  if (name === "codex") {
    return createExternalProvider(config, {
      name: "codex",
      defaultModel: "codex-default",
      run: runCodexExec
    });
  }
  if (name === "claude") {
    return createExternalProvider(config, {
      name: "claude",
      defaultModel: "claude-default",
      run: runClaudeExec
    });
  }
  if (name === "gemini") {
    return createExternalProvider(config, {
      name: "gemini",
      defaultModel: "gemini-default",
      run: async ({ root, prompt, model }) => runGeminiExec({ root, prompt: `${prompt}\n\nReturn only valid JSON matching the requested structure.`, model })
    });
  }
  if (name === "opencode") {
    return createExternalProvider(config, {
      name: "opencode",
      defaultModel: "opencode-default",
      run: async ({ root, prompt, model }) => runOpenCodeExec({ root, prompt: `${prompt}\n\nReturn only valid JSON matching the requested structure.`, model })
    });
  }
  throw new Error(`unsupported provider "${name}"`);
}
