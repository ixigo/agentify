# Agentify Harbor benchmark dataset

Portable paired benchmark (`agentify-claude` vs plain `claude-code`) for the
[Harbor](https://www.harborframework.com) / Terminal-Bench 2.0 harness.
Everything here is data — Harbor is never an Agentify runtime dependency.

- Full docs: [`docs/harbor.md`](../../docs/harbor.md) (prerequisites, cost
  math, import, cleanup).
- Validate without tokens: `agentify eval harbor validate`
- Spend ceiling: `agentify eval harbor plan --suite smoke|nightly|profiles`
- One-command paired smoke: `./run-smoke.sh`

`dataset.json` pins the dataset version, model, Harbor, Claude Code, and
Agentify versions; bump pins deliberately and re-run the smoke suite.

First nightly results (2026-07-14): agentify 24/24 vs plain claude-code 21/24,
all three baseline failures on the designed discordant task, controls tied,
no winner declared yet (3 discordant pairs → sign-test p = 0.25). Full numbers
and the scope caveat: [`docs/harbor.md` § Results so far](../../docs/harbor.md#results-so-far).
