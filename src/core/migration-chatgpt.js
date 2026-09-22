import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
export const CHATGPT_CONTENT = Symbol("chatgpt content");

function timestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (!Array.isArray(content.parts)) return `[${content.content_type || "non-text content"}; see original export]`;
  return content.parts.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part?.text === "string") return part.text;
    return `[${part?.content_type || "attachment"}; see original export]`;
  }).join("\n");
}

// ChatGPT exports are trees: following current_node preserves the chosen
// regenerate/edit branch rather than interleaving mutually exclusive answers.
export function chatGptMessages(conversation) {
  const mapping = conversation.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("ChatGPT conversation has no message mapping");
  let leaf = conversation.current_node;
  if (!leaf) {
    const parents = new Set(Object.values(mapping).map((node) => node?.parent).filter(Boolean));
    const leaves = Object.keys(mapping).filter((id) => !parents.has(id));
    if (leaves.length !== 1) throw new Error("ChatGPT conversation has ambiguous branches and no current_node");
    [leaf] = leaves;
  }
  const chain = [];
  const seen = new Set();
  while (leaf) {
    if (seen.has(leaf)) throw new Error("ChatGPT conversation contains a parent cycle");
    seen.add(leaf);
    const node = Object.hasOwn(mapping, leaf) ? mapping[leaf] : null;
    if (!node || typeof node !== "object") throw new Error(`ChatGPT conversation references a missing message: ${leaf}`);
    if (node.message) chain.push(node.message);
    leaf = node.parent;
  }
  return chain.reverse().flatMap((message) => {
    // Hidden export nodes contain UI bookkeeping, not user-visible dialogue.
    if (message.metadata?.is_visually_hidden_from_conversation) return [];
    let text = contentText(message.content);
    if (!text) return [];
    if (message.channel) text = `[chatgpt channel: ${message.channel}]\n${text}`;
    const role = typeof message.author?.role === "string" ? message.author.role : "unknown";
    return [{ role, text, timestamp: timestamp(message.create_time) }];
  });
}

export async function discoverChatGptConversations(input, root) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("ChatGPT migration requires --input /path/to/conversations.json (extract the ChatGPT data export first)");
  }
  let source = path.resolve(input);
  let stat = await fs.stat(source);
  if (stat.isDirectory()) {
    source = path.join(source, "conversations.json");
    stat = await fs.stat(source);
  }
  if (!stat.isFile()) throw new Error("ChatGPT --input must be conversations.json or its extracted export directory");
  if (source.toLowerCase().endsWith(".zip")) throw new Error("Extract the ChatGPT ZIP first, then pass --input conversations.json");
  if (stat.size > MAX_EXPORT_BYTES) throw new Error("ChatGPT export exceeds 256 MiB; split the conversation array into smaller JSON files before importing");
  let data;
  try { data = JSON.parse(await fs.readFile(source, "utf8")); } catch (error) {
    throw new Error("ChatGPT export is not valid JSON", { cause: error });
  }
  const conversations = Array.isArray(data) ? data : data?.conversations;
  if (!Array.isArray(conversations)) throw new Error("ChatGPT export must contain an array of conversations");
  if (!conversations.length) throw new Error("ChatGPT export contains no conversations");
  const ids = new Set();
  return conversations.map((conversation, index) => {
    if (!conversation || typeof conversation !== "object") throw new Error(`Invalid ChatGPT conversation at index ${index}`);
    const id = conversation.id || conversation.conversation_id;
    if (typeof id !== "string" || !id) throw new Error(`ChatGPT conversation at index ${index} has no id`);
    if (ids.has(id)) throw new Error(`Duplicate ChatGPT conversation id: ${id}`);
    ids.add(id);
    // Validate every selected export record before any destination writes.
    const messages = chatGptMessages(conversation);
    const serialized = JSON.stringify(conversation);
    return {
      provider: "chatgpt", path: source, id, cwd: root,
      key: createHash("sha256").update(`chatgpt:${id}`).digest("hex").slice(0, 16),
      title: typeof conversation.title === "string" ? conversation.title : id,
      mtime_ms: timestamp(conversation.update_time) ? conversation.update_time * 1000 : stat.mtimeMs,
      size: Buffer.byteLength(serialized), malformed: 0,
      [CHATGPT_CONTENT]: { conversation, messages },
    };
  });
}
