# SWE-bench Verified warm-up adapter

This directory is the external inference/grading surface for issue #320. It is
not loaded by Agentify at runtime and adds no npm dependency.

- `dataset.json` pins the dataset revision, official grader, Claude Code,
  Agentify, Node, model, budgets, and bounded instance sets.
- `runner.py` runs identical fresh Claude Code scored sessions for the cold and
  Agentify-warm arms, writes official prediction JSONL, and invokes the pinned
  SWE-bench Docker grader.
- `warmup/instruction.md` is the only provider prompt used before scoring. The
  runner projects each dataset row to `repo` and `base_commit` before phase A,
  then scans the resulting trajectory and `.agentify/context/` for markers
  derived from answer-bearing dataset fields.
- Every Claude invocation gets an empty isolated home so host-level hooks,
  plugins, MCP servers, and Agentify installs cannot contaminate the cold arm.
- `run-swebench.sh` performs validate → plan → explicit confirmation → infer →
  grade → import.

See `docs/swebench.md` for prerequisites, protocol details, cost math, and the
scope of claims that may be made from a bounded sample.
