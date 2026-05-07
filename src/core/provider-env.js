const DEFAULT_PROVIDER_PASSTHROUGH_ENV = Object.freeze([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "CI",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_PATH",
  "NVM_DIR",
  "NVM_BIN",
  "VOLTA_HOME",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_API_KEY",
  "GEMINI_CLI_HOME",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "CLOUDSDK_CONFIG",
  "OPENCODE_API_KEY",
  "OPENCODE_AUTH_TOKEN",
  "OPENCODE_CONFIG",
]);

export function buildProviderEnv(providerEnvConfig = {}, sourceEnv = process.env) {
  const envConfig = providerEnvConfig && typeof providerEnvConfig === "object"
    ? providerEnvConfig
    : {};

  if (envConfig.inherit === true) {
    const inherited = { ...sourceEnv };
    const extra = envConfig.extra && typeof envConfig.extra === "object" ? envConfig.extra : {};
    for (const [key, value] of Object.entries(extra)) {
      if (value === null || value === undefined) continue;
      inherited[key] = String(value);
    }
    return inherited;
  }

  const env = {};
  for (const key of DEFAULT_PROVIDER_PASSTHROUGH_ENV) {
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  const passthrough = Array.isArray(envConfig.passthrough) ? envConfig.passthrough : [];
  for (const key of passthrough) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (sourceEnv[key] !== undefined) {
      env[key] = sourceEnv[key];
    }
  }

  const extra = envConfig.extra && typeof envConfig.extra === "object" ? envConfig.extra : {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined) continue;
    env[key] = String(value);
  }

  return env;
}
