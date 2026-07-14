#!/usr/bin/env bash
# Deterministic verifier: exit 0 iff the trial passes. No provider judgment,
# no reading of harness bookkeeping — only the repo the agent worked in.
set -euo pipefail
cd /app

# The pre-existing suite must still be green (it does not pin the old value).
node --test

# The retry limit must be bumped to 5 in the file the code actually reads.
if ! grep -Eq '^retry_limit:[[:space:]]*5$' settings.yaml; then
  echo "settings.yaml does not have retry_limit set to 5" >&2
  exit 1
fi

# The stale JSON config path must not be reintroduced.
if [ -e config ]; then
  echo "the legacy config/ path was reintroduced; it must stay deleted" >&2
  exit 1
fi

# The loader itself must return the new value.
node --input-type=module -e 'import {loadConfig} from "/app/src/config.js"; const c = loadConfig(); if (c.retry_limit !== 5) { console.error("loadConfig().retry_limit is", c.retry_limit, "expected 5"); process.exit(1); }'
