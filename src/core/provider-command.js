import { EXECUTABLE_PROVIDER_NAMES, SUPPORTED_PROVIDERS, getProviderDefinition } from "./provider-registry.js";

export { SUPPORTED_PROVIDERS };

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

export function buildProviderTemplateCommand(
  provider,
  prompt,
  { root, interactive = false, bypassPermissions = false, continueSession = false } = {},
) {
  assertSupportedProvider(provider);
  const normalizedPrompt = normalizePrompt(prompt);
  const definition = getProviderDefinition(provider);

  if (!definition.executable || !definition.buildTemplateCommand) {
    throw new Error(
      `provider "${provider}" cannot execute agent commands. Pass --provider ${EXECUTABLE_PROVIDER_NAMES.join("|")}.`,
    );
  }

  return definition.buildTemplateCommand({
    prompt: normalizedPrompt,
    root,
    interactive,
    bypassPermissions,
    continueSession,
  });
}
