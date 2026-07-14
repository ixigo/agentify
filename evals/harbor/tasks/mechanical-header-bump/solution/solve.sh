#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

# perl -pi is portable across GNU/BSD (macOS sed -i needs a backup suffix),
# so the oracle stays verifiable on any dev machine, not just the container.
perl -pi -e 's/Copyright 2025/Copyright 2026/' src/logger.js src/format.js src/levels.js src/index.js

node --test
