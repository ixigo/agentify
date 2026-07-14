import { loadConfig } from "./config.js";

// Minimal client: builds a request plan from config, honoring the retry limit
// and timeout. No real network I/O — this is enough for tests and callers.
export function createClient(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  return {
    config,
    request(pathname) {
      return {
        url: `${config.base_url}${pathname}`,
        attempts: config.retry_limit,
        timeoutMs: config.timeout_ms,
      };
    },
  };
}
