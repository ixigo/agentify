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
