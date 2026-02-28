"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { executeProviderText } = require("../providers/execute-provider");

/**
 * Chat Session Engine
 *
 * Manages free-form @猫猫 chat interactions.
 * Parses @mentions, resolves target cats, builds persona prompts,
 * and routes messages to the correct provider.
 */

// ---------------------------------------------------------------------------
// Cat registry — builds a lookup from role-config cats section
// ---------------------------------------------------------------------------

function buildCatLookup(cats) {
  // cats: { "银渐层": { model_id, display_name, nickname, aliases, ... }, ... }
  const lookup = new Map(); // key (lowercase) → cat config object
  if (!cats || typeof cats !== "object") return lookup;

  for (const [name, cat] of Object.entries(cats)) {
    if (!cat || typeof cat !== "object") continue;
    const entry = { ...cat, cat_name: name };
    // Register by display_name
    lookup.set(name.toLowerCase(), entry);
    // Register by nickname
    if (cat.nickname) lookup.set(cat.nickname.toLowerCase(), entry);
    // Register by aliases
    if (Array.isArray(cat.aliases)) {
      for (const alias of cat.aliases) {
        if (typeof alias === "string" && alias.trim()) {
          lookup.set(alias.trim().toLowerCase(), entry);
        }
      }
    }
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// @mention parser
// ---------------------------------------------------------------------------

/**
 * Parse @mentions from user input text.
 * Supports: @银渐层, @牛奶, @咖啡, etc.
 * Returns { targets: [cat_entry, ...], cleanText: "message without @mentions" }
 */
function parseMentions(text, catLookup) {
  const mentionPattern = /@([\u4e00-\u9fff\w]+)/g;
  const targets = [];
  const seen = new Set();
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    const cat = catLookup.get(name);
    if (cat && !seen.has(cat.cat_name)) {
      seen.add(cat.cat_name);
      targets.push(cat);
    }
  }

  const cleanText = text.replace(/@[\u4e00-\u9fff\w]+/g, "").trim();
  return { targets, cleanText };
}

// ---------------------------------------------------------------------------
// Resolve provider info from cat config + models list
// ---------------------------------------------------------------------------

function resolveProviderForCat(cat, models) {
  const modelId = cat.model_id;
  if (!modelId || !Array.isArray(models)) {
    return { provider: "claude-cli", model: null, settingsFile: null };
  }
  const modelDef = models.find((m) => m.id === modelId);
  if (!modelDef) return { provider: "claude-cli", model: null, settingsFile: null };
  return {
    provider: modelDef.provider || "claude-cli",
    model: modelDef.model || null,
    settingsFile: modelDef.settings_file || null,
  };
}

// ---------------------------------------------------------------------------
// Build chat prompt with persona
// ---------------------------------------------------------------------------

function buildChatPrompt(cat, userMessage, history, peerCats) {
  const lines = [];
  const name = cat.display_name || cat.cat_name;
  const persona = cat.persona || "";

  lines.push(`你是${name}，Cat Café 里的一只猫猫。`);
  if (persona) lines.push(`性格：${persona}`);
  lines.push("");

  // Introduce peers
  if (peerCats && peerCats.length > 0) {
    lines.push("你的猫猫同事：");
    for (const peer of peerCats) {
      const peerName = peer.display_name || peer.cat_name;
      const peerNick = peer.nickname || peerName;
      lines.push(`- ${peerName}（昵称：${peerNick}）`);
    }
    lines.push("");
  }

  // Conversation history (last N messages for context)
  if (history && history.length > 0) {
    lines.push("对话历史：");
    for (const msg of history.slice(-20)) {
      const sender = msg.sender || "铲屎官";
      lines.push(`[${sender}]: ${msg.text}`);
    }
    lines.push("");
  }

  lines.push("铲屎官说：");
  lines.push(userMessage);
  lines.push("");
  lines.push(`请以${name}的身份回复。保持你的性格特点，简洁自然地回答。`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Chat message model
// ---------------------------------------------------------------------------

function createMessage({ sender, sender_type, cat_name, text, ts }) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sender: sender || "铲屎官",
    sender_type: sender_type || "user", // "user" | "cat"
    cat_name: cat_name || null,
    text: String(text || ""),
    ts: ts || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Thread persistence
// ---------------------------------------------------------------------------

function threadDir(logsRoot, threadId) {
  return path.join(logsRoot, "threads", threadId);
}

function ensureThreadDir(logsRoot, threadId) {
  const dir = threadDir(logsRoot, threadId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createThread(logsRoot, title) {
  const threadId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = ensureThreadDir(logsRoot, threadId);
  const meta = { thread_id: threadId, title: title || "新对话", created_at: Date.now() };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

function appendMessage(logsRoot, threadId, message) {
  const dir = ensureThreadDir(logsRoot, threadId);
  fs.appendFileSync(path.join(dir, "messages.jsonl"), JSON.stringify(message) + "\n", "utf8");
  return message;
}

function readMessages(logsRoot, threadId) {
  const file = path.join(threadDir(logsRoot, threadId), "messages.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readThreadMeta(logsRoot, threadId) {
  const file = path.join(threadDir(logsRoot, threadId), "meta.json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function listThreads(logsRoot) {
  const root = path.join(logsRoot, "threads");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readThreadMeta(logsRoot, d.name))
    .filter(Boolean)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

// ---------------------------------------------------------------------------
// Send chat message — the main entry point
// ---------------------------------------------------------------------------

async function sendChatMessage({
  logsRoot,
  threadId,
  userText,
  roleConfig,
  timeoutMs = 5 * 60 * 1000,
  abortSignal = null,
}) {
  const cats = roleConfig?.cats || {};
  const models = roleConfig?.models || [];
  const catLookup = buildCatLookup(cats);

  // Parse @mentions
  const { targets, cleanText } = parseMentions(userText, catLookup);

  // If no @mention, default to first cat
  const catNames = Object.keys(cats);
  const effectiveTargets =
    targets.length > 0
      ? targets
      : catNames.length > 0
        ? [{ ...cats[catNames[0]], cat_name: catNames[0] }]
        : [];

  if (effectiveTargets.length === 0) {
    throw new Error("没有可用的猫猫，请检查 role-config.json 中的 cats 配置。");
  }

  // Store user message
  const userMsg = createMessage({
    sender: "铲屎官",
    sender_type: "user",
    text: userText,
  });
  appendMessage(logsRoot, threadId, userMsg);

  // Read history for context
  const history = readMessages(logsRoot, threadId);

  // Build peer list (all cats except current target)
  const allCatEntries = Object.entries(cats).map(([name, c]) => ({ ...c, cat_name: name }));

  // Send to each target cat (parallel if multiple)
  const responses = await Promise.all(
    effectiveTargets.map(async (cat) => {
      const { provider, model, settingsFile } = resolveProviderForCat(cat, models);
      const peerCats = allCatEntries.filter((c) => c.cat_name !== cat.cat_name);
      const prompt = buildChatPrompt(cat, cleanText || userText, history, peerCats);

      const result = await executeProviderText({
        provider,
        model,
        settingsFile,
        prompt,
        timeoutMs,
        streamOutput: false,
        eventMeta: { cat_name: cat.cat_name, mode: "chat" },
        abortSignal,
      });

      const catMsg = createMessage({
        sender: cat.display_name || cat.cat_name,
        sender_type: "cat",
        cat_name: cat.cat_name,
        text: result.text || "(无回复)",
      });
      appendMessage(logsRoot, threadId, catMsg);

      return {
        cat_name: cat.cat_name,
        display_name: cat.display_name,
        avatar: cat.avatar,
        color: cat.color,
        message: catMsg,
        run_id: result.runId,
        run_dir: result.runDir,
        exit: result.exit,
        error_class: result.error_class || null,
      };
    })
  );

  return { user_message: userMsg, responses };
}

module.exports = {
  buildCatLookup,
  parseMentions,
  resolveProviderForCat,
  createThread,
  appendMessage,
  readMessages,
  readThreadMeta,
  listThreads,
  sendChatMessage,
};
