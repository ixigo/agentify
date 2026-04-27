# Agentify LLM Prompt

This file is the single shareable Agentify instruction set for LLMs.

Use it when you want to paste one prompt into Codex, Claude, Gemini, OpenCode, or another coding agent so it can operate on the repository in the current working directory without extra setup guidance.

How to use it:

- share this file's URL
- paste the full contents into the model
- run the model from the target repository root

## Copy-Paste Prompt

```text
You are operating in a repository that should be managed with Agentify.

Treat the current working directory as the target repository root unless I explicitly provide --root.

Your job is to:
1. assess Agentify readiness
2. suggest the right next steps from command output
3. execute the correct repo flow for this repository
4. leave the repo in a healthy Agentify state

Follow this workflow:

1. Verify Agentify is installed.
   - Run: agentify --version
   - If Agentify is missing, stop and report the exact blocker.

2. Run a readiness check first.
   - Run: agentify doctor --json
   - Summarize:
     - capability tier
     - missing required tools
     - optional tools that are unavailable
     - whether MemPalace is available
     - concrete recommendations before proceeding

3. Detect whether this repo is already Agentified.
   - If .agentify.yaml exists, treat it as an existing Agentify repo.
   - If .agentify.yaml does not exist, treat it as a first-time setup.

4. Choose the provider carefully.
   - If you are running inside Codex, Claude, Gemini, or OpenCode, map yourself to one of:
     - codex
     - claude
     - gemini
     - opencode
   - If your runtime does not map cleanly to one of those, or if you are only doing deterministic maintenance, use local.
   - Do not run agentify this automatically unless the user explicitly asked for bootstrap automation or local package installation on macOS.

5. Execute the correct flow.

   First-time setup flow:
   - Run: agentify init --provider <chosen-provider>
   - If the chosen provider is codex, claude, gemini, or opencode, suggest project-scoped built-in skills with:
     - agentify skill install all --provider <chosen-provider> --scope project
   - If the user wants repo-scoped skills, run that install command.
   - Run: agentify up
   - Run: agentify check

   Existing repo flow:
   - Run: agentify sync
   - If sync succeeds, explain that it already includes a local up-style refresh.
   - Run: agentify check when you want an explicit final validation pass or when sync surfaces warnings.

6. When doctor reports missing tooling, do not guess.
   - Recommend the next command based on the doctor output.
   - Distinguish required tools from optional tools.
   - Mention MemPalace as optional acceleration, not a hard blocker.

7. Report back clearly.
   - state whether the repo was new or already Agentified
   - list the commands you ran
   - summarize outcomes
   - call out blockers or missing tools
   - suggest the next best Agentify command for normal usage, for example:
     - agentify run --provider <provider> "task"
     - agentify sess run --provider <provider> --name "<stream>" "task"
     - agentify sync

Rules:
- operate on the current working directory by default
- prefer machine-readable output where useful
- do not assume the repository stack; let Agentify inspect it
- do not invent auth state or tool availability; verify them
- if a command fails, explain the failure and propose the smallest next step
```

## Short Version

For an existing Agentify repo:

```bash
agentify doctor --json
agentify sync
agentify check
```

For a first-time setup:

```bash
agentify doctor --json
agentify init --provider codex
agentify up
agentify check
```

If you also want repo-scoped built-in skills for a supported provider:

```bash
agentify skill install all --provider codex --scope project
```
