# Immutable base: pin the exact node tag so every trial builds byte-identical
# environments. Bump deliberately with a dataset version bump.
FROM node:22.12.0-bookworm-slim

# python3/make/g++ let npm compile native addons (better-sqlite3) when no
# prebuilt binary matches the container arch; tzdata makes the timezone below
# resolvable. Both arms share this image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ tzdata \
  && rm -rf /var/lib/apt/lists/*

# A deliberately non-UTC container timezone (UTC+14). A helper that extracts
# date parts with LOCAL-time accessors buckets a late-in-the-day UTC timestamp
# into the wrong day/month here; only UTC-based extraction is correct. This is
# the runtime gotcha the seed phase discovers and the recall phase must avoid.
ENV TZ=Pacific/Kiritimati

WORKDIR /app
COPY repo/ /app/

# Phase-A (seed) instruction baked at a neutral path. Only the two-phase
# agentify agent runs it; a memoryless baseline has no prior session to carry
# forward, which is exactly the difference under test. Both arms get the
# identical image — the plain arm simply never reads this file.
COPY phases/seed/instruction.md /opt/agentify-seed/instruction.md

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
# The decisive lesson for this task is PRODUCED by the seed phase, not seeded
# here — these fixtures are only unrelated prior history.
COPY fixtures/agentify-context/ /opt/agentify-fixtures/
