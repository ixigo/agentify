export {
  handleInit,
  handleLink,
  handleWorktree,
  handleIndex,
  handleScan,
  handleDoc,
  handleUp,
  handleSync,
  handleCheck,
} from "./project.js";
export {
  handlePlan,
  handleRun,
  handleExec,
  handleIssueKiller,
  handleAfk,
} from "./execution.js";
export { handleContext, handleQuery, handleRisk } from "./context-query.js";
export { handleSkill, handleSkills, handleMemory, handleHooks } from "./skills-memory-hooks.js";
export { handleHandoff, handleSess } from "./session-handoff.js";
export { handleDoctor, handleSemantic, handleClean, handleCache } from "./maintenance.js";

import {
  handleInit,
  handleLink,
  handleWorktree,
  handleIndex,
  handleScan,
  handleDoc,
  handleUp,
  handleSync,
  handleCheck,
} from "./project.js";
import {
  handlePlan,
  handleRun,
  handleExec,
  handleIssueKiller,
  handleAfk,
} from "./execution.js";
import { handleContext, handleQuery, handleRisk } from "./context-query.js";
import { handleSkill, handleSkills, handleMemory, handleHooks } from "./skills-memory-hooks.js";
import { handleHandoff, handleSess } from "./session-handoff.js";
import { handleDoctor, handleSemantic, handleClean, handleCache } from "./maintenance.js";

export const COMMAND_HANDLERS = {
  init: handleInit,
  link: handleLink,
  worktree: handleWorktree,
  index: handleIndex,
  scan: handleScan,
  doc: handleDoc,
  up: handleUp,
  sync: handleSync,
  check: handleCheck,
  plan: handlePlan,
  run: handleRun,
  context: handleContext,
  exec: handleExec,
  "issue-killer": handleIssueKiller,
  afk: handleAfk,
  handoff: handleHandoff,
  query: handleQuery,
  risk: handleRisk,
  skill: handleSkill,
  skills: handleSkills,
  memory: handleMemory,
  sess: handleSess,
  hooks: handleHooks,
  doctor: handleDoctor,
  semantic: handleSemantic,
  clean: handleClean,
  cache: handleCache,
};

export function getCommandHandler(command) {
  return COMMAND_HANDLERS[command] || null;
}
