"use strict";

const DEFAULT_PROMPT_HISTORY_LIMIT = 20;

function buildCatLookup(cats) {
  const lookup = new Map();
  if (!cats || typeof cats !== "object") return lookup;

  for (const [name, cat] of Object.entries(cats)) {
    if (!cat || typeof cat !== "object") continue;
    const entry = { ...cat, cat_name: name };
    lookup.set(name.toLowerCase(), entry);
    if (cat.nickname) lookup.set(String(cat.nickname).toLowerCase(), entry);
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

function parseMentions(text, catLookup) {
  const source = String(text || "");
  const mentionPattern = /@([\u4e00-\u9fff\w]+)/g;
  const targets = [];
  const seen = new Set();
  let match;

  while ((match = mentionPattern.exec(source)) !== null) {
    const name = String(match[1] || "").toLowerCase();
    const cat = catLookup.get(name);
    if (cat && !seen.has(cat.cat_name)) {
      seen.add(cat.cat_name);
      targets.push(cat);
    }
  }

  const cleanText = source.replace(/@[\u4e00-\u9fff\w]+/g, "").trim();
  return { targets, cleanText };
}

function resolvePromptUserText(userText, cleanText) {
  const cleaned = String(cleanText || "").trim();
  if (cleaned) return cleaned;
  return String(userText || "").trim();
}

function selectPromptHistory(history, limit = DEFAULT_PROMPT_HISTORY_LIMIT) {
  const safeHistory = Array.isArray(history) ? history : [];
  const size = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : DEFAULT_PROMPT_HISTORY_LIMIT;
  if (safeHistory.length <= size) return [...safeHistory];
  return safeHistory.slice(-size);
}

function buildWorkflowTaskPrompt(history, fallbackText = "") {
  const userMessages = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.sender_type === "user")
    .map((m) => String(m.text || "").trim())
    .filter(Boolean);

  if (!userMessages.length) return String(fallbackText || "").trim();
  const first = userMessages[0];
  if (userMessages.length === 1) return first;
  const lines = [first, "", "Follow-up messages from operator (chronological):"];
  userMessages.slice(1).forEach((m, idx) => {
    lines.push(`${idx + 1}. ${m}`);
  });
  return lines.join("\n");
}

function selectEffectiveTargets({
  mode,
  modeState,
  cats,
  mentionTargets,
  workflowNodes,
}) {
  const safeCats = cats && typeof cats === "object" ? cats : {};
  const catNames = Object.keys(safeCats);
  const mentions = Array.isArray(mentionTargets) ? mentionTargets : [];

  if (mode === "workflow") {
    const nodes = Array.isArray(workflowNodes) && workflowNodes.length > 0
      ? workflowNodes
      : [{ id: "coder", role: "CoreDev" }];
    const currentNode = modeState?.current_node || "coder";
    const node = nodes.find((n) => n.id === currentNode) || nodes[0];
    const roleMap = modeState?.role_map || {};
    const activeCats = catNames.filter((n) => roleMap[n] === node.role);
    if (activeCats.length > 0) {
      return activeCats.map((n) => ({ ...safeCats[n], cat_name: n }));
    }
    return catNames.map((n) => ({ ...safeCats[n], cat_name: n }));
  }

  if (mentions.length > 0) return mentions;
  return catNames.map((n) => ({ ...safeCats[n], cat_name: n }));
}

function buildChatContext({
  mode,
  modeState,
  userText,
  cats,
  history,
  workflowNodes,
  historyLimit = DEFAULT_PROMPT_HISTORY_LIMIT,
}) {
  const catLookup = buildCatLookup(cats);
  const mention = parseMentions(userText, catLookup);
  const promptUserText = resolvePromptUserText(userText, mention.cleanText);
  const effectiveTargets = selectEffectiveTargets({
    mode,
    modeState,
    cats,
    mentionTargets: mention.targets,
    workflowNodes,
  });
  const promptHistory = selectPromptHistory(history, historyLimit);
  const workflowTaskPrompt = buildWorkflowTaskPrompt(history, promptUserText);

  return {
    catLookup,
    mention,
    promptUserText,
    effectiveTargets,
    promptHistory,
    workflowTaskPrompt,
  };
}

module.exports = {
  DEFAULT_PROMPT_HISTORY_LIMIT,
  buildCatLookup,
  parseMentions,
  resolvePromptUserText,
  selectPromptHistory,
  buildWorkflowTaskPrompt,
  selectEffectiveTargets,
  buildChatContext,
};
