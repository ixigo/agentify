FROM node:22.12.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY repo/ /app/

RUN git init -q \
  && git config user.name agentify-bench \
  && git config user.email bench@agentify.invalid \
  && git add -A \
  && GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z \
     git commit -q -m "baseline"

COPY fixtures/agentify-context/ /opt/agentify-fixtures/
