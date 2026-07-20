#!/usr/bin/env bash
# Oracle solution: lets `harbor run` with the oracle agent smoke the task
# end-to-end without any provider tokens.
set -euo pipefail
cd /app

# Change the value in the file the loader actually reads.
perl -pi -e 's/^retry_limit:.*/retry_limit: 5/' settings.yaml

node --test
