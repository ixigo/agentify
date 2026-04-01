export const SUPPORTED_PROVIDERS = ["local", "codex", "claude", "gemini", "opencode"];

export function assertSupportedProvider(provider) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(`unsupported provider "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`);
  }
}

function normalizePrompt(prompt) {
  const text = (prompt || "").trim();
  if (text.length > 0) {
    return text;
  }
  return "Continue the task in this repository and keep changes minimal, tested, and documented.";
}

export function buildProviderTemplateCommand(provider, prompt, { root, interactive = false } = {}) {
  assertSupportedProvider(provider);
  const normalizedPrompt = normalizePrompt(prompt);

  if (provider === "local") {
    throw new Error('provider "local" cannot execute agent commands. Pass --provider codex|claude|gemini|opencode.');
  }

  if (provider === "codex") {
    if (interactive) {
      const args = ["codex"];
      if (root) {
        args.push("--cd", root);
      }
      args.push(normalizedPrompt);
      return args;
    }
    return ["codex", "exec", normalizedPrompt];
  }
  if (provider === "claude") {
    if (interactive) {
      return ["claude", normalizedPrompt];
    }
    return ["claude", "-p", normalizedPrompt];
  }
  if (provider === "gemini") {
    if (interactive) {
      return ["gemini", normalizedPrompt];
    }
    return ["gemini", "-p", normalizedPrompt];
  }
  if (provider === "opencode") {
    if (interactive) {
      const args = ["opencode"];
      if (root) {
        args.push("--dir", root);
      }
      args.push(normalizedPrompt);
      return args;
    }
    const args = ["opencode", "run", normalizedPrompt];
    if (root) {
      args.push("--dir", root);
    }
    return args;
  }

  throw new Error(`unsupported provider "${provider}"`);
}
