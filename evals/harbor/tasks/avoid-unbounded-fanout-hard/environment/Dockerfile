# Immutable base: pin the exact node tag so every trial builds byte-identical
# environments. Bump deliberately with a dataset version bump.
FROM node:22.12.0-bookworm-slim

# python3/make/g++ let npm compile native addons (better-sqlite3) when no
# prebuilt binary matches the container arch; both arms share this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY repo/ /app/

# Deterministic git history: the agents work in a real repo, and Agentify's
# context hooks expect one.
RUN git init -q \
  && git config user.name agentify-bench \
  && git config user.email bench@agentify.invalid \
  && git add -A \
  && GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
     git commit -q -m "baseline"

# Agentify context fixtures at a neutral path. Both arms get the identical
# image; only the agentify-claude agent moves these into .agentify/context.
COPY fixtures/agentify-context/ /opt/agentify-fixtures/
