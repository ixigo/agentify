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

export function buildProviderTemplateCommand(provider, prompt, {
  root,
  interactive = false,
  bypassPermissions = false,
} = {}) {
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
      if (bypassPermissions) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
      args.push(normalizedPrompt);
      return args;
    }
    const args = ["codex", "exec"];
    if (bypassPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(normalizedPrompt);
    return args;
  }
  if (provider === "claude") {
    if (interactive) {
      const args = ["claude"];
      if (bypassPermissions) {
        args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
      }
      args.push(normalizedPrompt);
      return args;
    }
    const args = ["claude"];
    if (bypassPermissions) {
      args.push("--dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
    }
    args.push("-p", normalizedPrompt);
    return args;
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
