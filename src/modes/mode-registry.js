"use strict";

/**
 * Mode Registry — defines session modes and their prompt builders.
 *
 * Each mode has:
 *   id        — unique key
 *   label     — display name (Chinese)
 *   icon      — emoji for UI
 *   desc      — short description
 *   buildPrompt(cat, userMessage, history, peerCats, modeState) → string
 */

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

const MODES = Object.freeze({
  free_chat: {
    id: "free_chat",
    label: "自由聊天",
    icon: "💬",
    desc: "猫猫们自由讨论，随意聊天",
  },
  workflow: {
    id: "workflow",
    label: "流程执行",
    icon: "⚙️",
    desc: "严格流程：Coder → Reviewer → Tester",
  },
  werewolf: {
    id: "werewolf",
    label: "狼人杀",
    icon: "🐺",
    desc: "猫猫们玩狼人杀游戏",
  },
  quiz: {
    id: "quiz",
    label: "出题答题",
    icon: "🧩",
    desc: "猫猫之间互相出题答题",
  },
});

const DEFAULT_MODE = "free_chat";

// ---------------------------------------------------------------------------
// Prompt builders per mode
// ---------------------------------------------------------------------------

function buildBaseHeader(cat, peerCats) {
  const lines = [];
  const name = cat.display_name || cat.cat_name;
  const persona = cat.persona || "";

  lines.push(`你是${name}，Cat Café 里的一只猫猫。`);
  if (persona) lines.push(`性格：${persona}`);
  lines.push("");

  if (peerCats && peerCats.length > 0) {
    lines.push("你的猫猫同事：");
    for (const peer of peerCats) {
      const peerName = peer.display_name || peer.cat_name;
      const peerNick = peer.nickname || peerName;
      lines.push(`- ${peerName}（昵称：${peerNick}）`);
    }
    lines.push("");
  }
  return lines;
}

function appendHistory(lines, history) {
  if (history && history.length > 0) {
    lines.push("对话历史：");
    for (const msg of history) {
      const sender = msg.sender || "铲屎官";
      lines.push(`[${sender}]: ${msg.text}`);
    }
    lines.push("");
  }
}

// ---- free_chat ----
function buildFreeChatPrompt(cat, userMessage, history, peerCats) {
  const lines = buildBaseHeader(cat, peerCats);
  appendHistory(lines, history);
  const name = cat.display_name || cat.cat_name;
  lines.push("铲屎官说：");
  lines.push(userMessage);
  lines.push("");
  lines.push(`请以${name}的身份回复。保持你的性格特点，简洁自然地回答。`);
  return lines.join("\n");
}

// ---- werewolf ----
function buildWerewolfPrompt(cat, userMessage, history, peerCats, modeState) {
  const lines = buildBaseHeader(cat, peerCats);
  const name = cat.display_name || cat.cat_name;
  const role = modeState?.roles?.[cat.cat_name] || "村民";
  const phase = modeState?.phase || "讨论";
  const round = modeState?.round || 1;

  lines.push("=== 狼人杀游戏 ===");
  lines.push(`当前回合：第${round}轮`);
  lines.push(`当前阶段：${phase}`);
  lines.push(`你的身份：${role}`);
  lines.push("");
  lines.push("游戏规则：");
  lines.push("- 狼人：夜晚选择一名玩家淘汰");
  lines.push("- 预言家：夜晚可以查验一名玩家身份");
  lines.push("- 女巫：有一瓶解药和一瓶毒药");
  lines.push("- 村民：白天投票淘汰可疑玩家");
  lines.push("- 铲屎官是主持人");
  lines.push("");

  appendHistory(lines, history);

  lines.push("铲屎官（主持人）说：");
  lines.push(userMessage);
  lines.push("");
  lines.push(`请以${name}的身份，根据你的游戏角色（${role}）来回应。`);
  lines.push("注意：不要暴露自己的身份（除非你是村民阵营且在白天讨论阶段）。");
  lines.push("保持你的猫猫性格特点来表演这个角色。");
  return lines.join("\n");
}

// ---- quiz ----
function buildQuizPrompt(cat, userMessage, history, peerCats, modeState) {
  const lines = buildBaseHeader(cat, peerCats);
  const name = cat.display_name || cat.cat_name;
  const quizRole = modeState?.quiz_role?.[cat.cat_name] || "answerer";
  const topic = modeState?.topic || "编程";
  const score = modeState?.scores?.[cat.cat_name] || 0;

  lines.push("=== 出题答题模式 ===");
  lines.push(`主题：${topic}`);
  lines.push(`你的角色：${quizRole === "questioner" ? "出题者" : "答题者"}`);
  lines.push(`当前得分：${score}分`);
  lines.push("");

  if (quizRole === "questioner") {
    lines.push("你是出题者，请根据主题出一道有趣的题目给其他猫猫。");
    lines.push("题目可以是选择题、填空题或开放题。");
  } else {
    lines.push("你是答题者，请认真思考并回答问题。");
  }
  lines.push("");

  appendHistory(lines, history);

  lines.push("铲屎官说：");
  lines.push(userMessage);
  lines.push("");
  lines.push(`请以${name}的身份回复，保持你的性格特点。`);
  return lines.join("\n");
}

// ---- workflow (strict process execution with node tracking) ----
const WORKFLOW_NODES = [
  { id: "coder",    label: "编码",   role: "CoreDev",  desc: "编写代码实现需求" },
  { id: "reviewer", label: "评审",   role: "Reviewer", desc: "审查代码质量与规范" },
  { id: "tester",   label: "测试",   role: "Tester",   desc: "编写和执行测试用例" },
];

function buildWorkflowPrompt(cat, userMessage, history, peerCats, modeState) {
  const lines = buildBaseHeader(cat, peerCats);
  const name = cat.display_name || cat.cat_name;
  const currentNode = modeState?.current_node || "coder";
  const nodeIndex = WORKFLOW_NODES.findIndex((n) => n.id === currentNode);
  const node = WORKFLOW_NODES[nodeIndex] || WORKFLOW_NODES[0];

  lines.push("=== 严格流程执行模式 ===");
  lines.push("流程节点：" + WORKFLOW_NODES.map((n, i) => {
    const marker = n.id === currentNode ? "▶" : (i < nodeIndex ? "✓" : "○");
    return `${marker} ${n.label}`;
  }).join(" → "));
  lines.push(`当前节点：${node.label}（${node.desc}）`);
  lines.push(`负责角色：${node.role}`);
  lines.push("");

  const catRole = modeState?.role_map?.[cat.cat_name] || null;
  if (catRole) {
    lines.push(`你在本流程中的职责：${catRole}`);
  }
  const isActive = catRole === node.role;
  if (isActive) {
    lines.push(">>> 当前节点轮到你负责，请认真执行你的职责。");
  } else {
    lines.push("当前节点不是你负责，请等待或提供辅助意见。");
  }
  lines.push("");

  appendHistory(lines, history);

  lines.push("铲屎官说：");
  lines.push(userMessage);
  lines.push("");
  lines.push(`请以${name}的身份，按照流程规范回复。保持你的性格特点。`);
  return lines.join("\n");
}

const PROMPT_BUILDERS = {
  free_chat: buildFreeChatPrompt,
  workflow: buildWorkflowPrompt,
  werewolf: buildWerewolfPrompt,
  quiz: buildQuizPrompt,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getModes() {
  return Object.values(MODES);
}

function getMode(modeId) {
  return MODES[modeId] || MODES[DEFAULT_MODE];
}

function isValidMode(modeId) {
  return modeId in MODES;
}

function buildModePrompt(modeId, cat, userMessage, history, peerCats, modeState) {
  const builder = PROMPT_BUILDERS[modeId] || PROMPT_BUILDERS[DEFAULT_MODE];
  return builder(cat, userMessage, history, peerCats, modeState || {});
}

/**
 * Build initial mode_state for workflow mode from roleConfig.
 * Maps each cat to its workflow role based on role_profiles.
 */
function buildWorkflowModeState(roleConfig) {
  const roleMap = {};
  const profiles = roleConfig?.role_profiles || {};
  const cats = roleConfig?.cats || {};
  const workflowAssignment = roleConfig?.workflow_assignment || {};

  // Preferred: explicit stage -> cat_name mapping, avoids collisions when
  // multiple stages share the same model_id.
  for (const [stage, catName] of Object.entries(workflowAssignment)) {
    if (!catName || !profiles[stage] || !cats[catName]) continue;
    roleMap[catName] = profiles[stage].role_title || DEFAULT_STAGE_DUTY[stage];
  }

  // If explicit mapping exists for all known stages, skip fallback inference.
  const hasAllStageAssignments = Object.keys(DEFAULT_STAGE_DUTY).every((stage) => {
    const catName = workflowAssignment[stage];
    return Boolean(catName && cats[catName] && profiles[stage]);
  });
  if (hasAllStageAssignments) {
    return {
      current_node: WORKFLOW_NODES[0].id,
      role_map: roleMap,
      completed_nodes: [],
    };
  }

  // Map cat_name → role_title via stage_assignment + role_profiles
  const stageAssignment = roleConfig?.stage_assignment || {};
  // Build reverse: model_id → stage
  const modelToStage = {};
  for (const [stage, modelId] of Object.entries(stageAssignment)) {
    modelToStage[modelId] = stage;
  }

  for (const [catName, catCfg] of Object.entries(cats)) {
    if (roleMap[catName]) continue;
    const modelId = catCfg?.model_id;
    const stage = modelToStage[modelId];
    if (stage && profiles[stage] && !workflowAssignment[stage]) {
      roleMap[catName] = profiles[stage].role_title || DEFAULT_STAGE_DUTY[stage];
    }
  }

  return {
    current_node: WORKFLOW_NODES[0].id,
    role_map: roleMap,
    completed_nodes: [],
  };
}

const DEFAULT_STAGE_DUTY = { coder: "CoreDev", reviewer: "Reviewer", tester: "Tester" };

/**
 * Advance workflow to the next node. Returns updated mode_state or null if already at end.
 */
function advanceWorkflowNode(modeState) {
  const current = modeState?.current_node || WORKFLOW_NODES[0].id;
  const idx = WORKFLOW_NODES.findIndex((n) => n.id === current);
  if (idx < 0) return null;

  const completed = [...(modeState?.completed_nodes || [])];
  if (!completed.includes(current)) completed.push(current);

  // Already at last node — mark it completed and signal finished
  if (idx >= WORKFLOW_NODES.length - 1) {
    return {
      ...modeState,
      current_node: current,
      completed_nodes: completed,
      finished: true,
    };
  }

  return {
    ...modeState,
    current_node: WORKFLOW_NODES[idx + 1].id,
    completed_nodes: completed,
  };
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  WORKFLOW_NODES,
  getModes,
  getMode,
  isValidMode,
  buildModePrompt,
  buildWorkflowModeState,
  advanceWorkflowNode,
};
