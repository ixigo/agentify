export function buildManagerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["repo_summary", "shared_conventions", "module_focus"],
    properties: {
      repo_summary: { type: "string" },
      shared_conventions: {
        type: "array",
        items: { type: "string" }
      },
      module_focus: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["module_id", "focus"],
          properties: {
            module_id: { type: "string" },
            focus: { type: "string" }
          }
        }
      }
    }
  };
}

export function buildModuleSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "public_api", "start_here", "side_effects", "header_summaries"],
    properties: {
      summary: { type: "string" },
      public_api: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "kind", "path"],
          properties: {
            symbol: { type: "string" },
            kind: { type: "string" },
            path: { type: "string" }
          }
        }
      },
      start_here: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "why"],
          properties: {
            path: { type: "string" },
            why: { type: "string" }
          }
        }
      },
      side_effects: {
        type: "array",
        items: { type: "string" }
      },
      header_summaries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "summary"],
          properties: {
            path: { type: "string" },
            summary: { type: "string" }
          }
        }
      }
    }
  };
}

export function buildManagerPrompt(repoContext) {
  return `You are the Agentify manager agent. Produce a concise repo-level plan for downstream module sub-agents.

Constraints:
- Return only schema-valid JSON.
- Focus on conventions, architectural clues, and high-signal reading guidance.
- Do not propose code changes.
- Keep claims grounded in the provided repository summary.

Repository:
- Name: ${repoContext.repoName}
- Root: ${repoContext.root}
- Default stack: ${repoContext.defaultStack}
- Detected stacks: ${repoContext.stacks.map((item) => `${item.name}:${item.confidence}`).join(", ")}

Entrypoints:
${repoContext.entrypoints.map((item) => `- ${item}`).join("\n") || "- none"}

Modules:
${repoContext.modules.map((item) => `- ${item.id}: ${item.rootPath}`).join("\n")}

Top files:
${repoContext.sampleFiles.map((item) => `- ${item.path}`).join("\n") || "- none"}

File snippets:
${repoContext.sampleFiles.map((item) => `\nFILE: ${item.path}\n\`\`\`\n${item.content}\n\`\`\``).join("\n")}`;
}

export function buildModulePrompt(moduleInfo, context) {
  return `You are an Agentify module sub-agent. Analyze exactly one module and return ONLY schema-valid JSON.

Rules:
- Do not propose business logic changes.
- Keep descriptions factual, bounded, and repo-specific.
- Keep the summary compact and high-signal. Agentify will render the markdown itself.
- Header summaries must be safe top-of-file descriptions only.
- Only reference module-local paths for public_api, start_here, and header_summaries.

Manager guidance:
- Repo summary: ${context.managerPlan.repo_summary || "none"}
- Shared conventions:
${context.managerPlan.shared_conventions.map((item) => `  - ${item}`).join("\n") || "  - none"}
- Module focus: ${context.managerFocus || "none"}

Module context:
- Module id: ${moduleInfo.id}
- Module name: ${moduleInfo.name}
- Module root: ${moduleInfo.rootPath}
- Stack: ${moduleInfo.stack}
- Head commit: ${context.headCommit}
- Depends on modules: ${context.dependsOn.join(", ") || "none"}
- Used by modules: ${context.usedBy.join(", ") || "none"}

Key files:
${context.keyFiles.map((file) => `- ${file}`).join("\n") || "- none"}

Candidate files:
${context.files.map((file) => `- ${file.path}`).join("\n") || "- none"}

File snippets:
${context.files.map((file) => `\nFILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``).join("\n")}`;
}
