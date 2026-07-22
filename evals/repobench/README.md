# RepoBench repo-context adapter

This directory is the external benchmark surface for issue #321. It is not
loaded by Agentify at runtime and adds no npm dependency.

- `dataset.json` pins the RepoBench `python_v1.1` revision, a bounded
  content-verified task sample (repository + commit + sha256 receipts for
  every consumed row field), Claude Code, Agentify, Node, the model, and
  per-completion budgets.
- `runner.py retrieval` is token-free: it checks out each pinned commit,
  builds the Agentify index, derives queries from the task's import statement
  only, and scores `agentify query def|refs|impacts` against RepoBench's
  labeled gold cross-file dependency.
- `runner.py run` is the paid paired arm: both arms get the identical
  instruction and in-file context; the agentify arm additionally gets
  cross-file snippets selected mechanically by the same index queries. The
  answer line never feeds queries, prompts, or context selection.
- `prompts/completion.md` is the only completion instruction; validation
  rejects any placeholder outside the allowlisted input fields.
- `run-repobench.sh` performs validate → plan → free retrieval → explicit
  confirmation → paid completion → import.

See `docs/repobench.md` for the protocol, selection rule, metrics, cost
ceilings, and the scope of claims a bounded sample supports.
