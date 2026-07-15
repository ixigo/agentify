// Deterministic, in-memory prompt-text classification for the opt-in
// --content local-extractive mode. The contract that makes this safe:
//
// - Prompt text is examined ONLY inside classifyPromptText while the
//   session file streams; the text itself is never stored on the session,
//   never cached, never rendered, and no model is started.
// - Only rule identifiers and match COUNTS survive. Counts are not
//   reversible into text.
// - Rules are plain keyword tests so the same history always yields the
//   same labels.
export const CONTENT_CLASSIFIER_VERSION = "content-rules-v1";

const RULES = [
  // Priority order doubles as the tie-break: a prompt that says both
  // "fix" and "add" is more usefully a debugging session.
  { category: "debugging", pattern: /\b(fix|bug|broken|error|crash|fail|failing|failure|regression|traceback|exception|debug)\b/gi },
  { category: "implementation", pattern: /\b(implement|add|create|build|feature|support|integrate|refactor|migrate|write)\b/gi },
  { category: "quick-fix", pattern: /\b(typo|rename|bump|tweak|minor|one-?liner|small change|quick)\b/gi },
  { category: "research", pattern: /\b(how|why|what|explain|investigate|understand|compare|analy[sz]e|look into|summari[sz]e)\b/gi },
];

export function createContentClassifier() {
  const counts = Object.fromEntries(RULES.map((rule) => [rule.category, 0]));
  let promptsSeen = 0;
  return {
    // Called per user prompt while streaming; the text stays in this frame.
    observe(text) {
      const value = String(text || "");
      if (!value.trim()) return;
      promptsSeen += 1;
      for (const rule of RULES) {
        const matches = value.match(rule.pattern);
        if (matches) counts[rule.category] += matches.length;
      }
    },
    // Only counts and a category label leave the classifier.
    result() {
      const entries = Object.entries(counts).filter(([, count]) => count > 0);
      const total = entries.reduce((sum, [, count]) => sum + count, 0);
      if (promptsSeen === 0 || total < 2) {
        return { classifier: CONTENT_CLASSIFIER_VERSION, prompts_seen: promptsSeen, category_hint: null, hint_confidence: 0, signal_counts: counts };
      }
      let winner = null;
      for (const rule of RULES) {
        if (counts[rule.category] > (winner ? counts[winner] : 0)) {
          winner = rule.category;
        }
      }
      return {
        classifier: CONTENT_CLASSIFIER_VERSION,
        prompts_seen: promptsSeen,
        category_hint: winner,
        hint_confidence: Number((counts[winner] / total).toFixed(2)),
        signal_counts: counts,
      };
    },
  };
}

// Extracts user prompt text from the record shapes both providers use.
// Returns null for anything that is not a human-typed prompt.
export function claudePromptText(record) {
  if (record?.type !== "user" || record.isSidechain === true) return null;
  const message = record.message;
  if (!message || typeof message !== "object") return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const parts = message.content.filter((item) => item?.type === "text" && typeof item.text === "string");
    if (parts.length > 0) return parts.map((item) => item.text).join("\n");
  }
  return null;
}

export function codexPromptText(record, payload) {
  if (record?.type === "event_msg" && payload?.type === "user_message") {
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.text === "string") return payload.text;
  }
  if (record?.type === "response_item" && payload?.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
    const parts = payload.content.filter((item) => item?.type === "input_text" && typeof item.text === "string");
    if (parts.length > 0) return parts.map((item) => item.text).join("\n");
  }
  return null;
}
