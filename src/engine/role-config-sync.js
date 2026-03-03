"use strict";

function clip(value, max = 64) {
  return String(value || "").trim().slice(0, max);
}

function norm(value) {
  return clip(value).toLowerCase();
}

function toAliasList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = clip(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function addIndex(map, key, catName) {
  if (!key || !catName) return;
  const arr = map.get(key) || [];
  if (!arr.includes(catName)) arr.push(catName);
  map.set(key, arr);
}

function buildCatIndexes(cats = {}) {
  const byName = new Map();
  const byIdentity = new Map();
  for (const [catName, catCfg] of Object.entries(cats || {})) {
    const nameKey = norm(catName);
    if (nameKey) byName.set(nameKey, catName);
    if (!catCfg || typeof catCfg !== "object") continue;

    const displayKey = norm(catCfg.display_name);
    const nickKey = norm(catCfg.nickname);
    if (displayKey) addIndex(byIdentity, displayKey, catName);
    if (nickKey) addIndex(byIdentity, nickKey, catName);

    const aliases = Array.isArray(catCfg.aliases) ? catCfg.aliases : [];
    for (const alias of aliases) {
      const key = norm(alias);
      if (key) addIndex(byIdentity, key, catName);
    }
  }
  return { byName, byIdentity };
}

function pickByIdentity({ displayName, nickname, byName, byIdentity, cats, used }) {
  const directKeys = [norm(displayName), norm(nickname)].filter(Boolean);
  for (const key of directKeys) {
    const byNameHit = byName.get(key);
    if (byNameHit && cats[byNameHit] && !used.has(byNameHit)) return byNameHit;
  }

  for (const key of directKeys) {
    const hits = byIdentity.get(key) || [];
    for (const catName of hits) {
      if (cats[catName] && !used.has(catName)) return catName;
    }
  }

  for (const key of directKeys) {
    const byNameHit = byName.get(key);
    if (byNameHit && cats[byNameHit]) return byNameHit;
    const hits = byIdentity.get(key) || [];
    for (const catName of hits) {
      if (cats[catName]) return catName;
    }
  }
  return null;
}

/**
 * Make role config "single source of truth" for stage/profile driven UI:
 * - stage_assignment + role_profiles map to concrete cats
 * - cats.model_id follows selected stage model
 * - cats.nickname/display_name follow profile values
 * - workflow_assignment is filled so workflow routing does not depend on model-id reverse lookup
 */
function syncRoleConfigCats(roleConfig, opts = {}) {
  const stages = Array.isArray(opts.stages) && opts.stages.length
    ? opts.stages
    : ["coder", "reviewer", "tester"];
  if (!roleConfig || typeof roleConfig !== "object") return roleConfig;
  const inCats = roleConfig.cats;
  if (!inCats || typeof inCats !== "object") return roleConfig;

  const cats = {};
  for (const [catName, catCfg] of Object.entries(inCats)) {
    cats[catName] = catCfg && typeof catCfg === "object" ? { ...catCfg } : {};
  }
  const stageAssignment = roleConfig.stage_assignment && typeof roleConfig.stage_assignment === "object"
    ? roleConfig.stage_assignment
    : {};
  const roleProfiles = roleConfig.role_profiles && typeof roleConfig.role_profiles === "object"
    ? roleConfig.role_profiles
    : {};
  const workflowIn = roleConfig.workflow_assignment && typeof roleConfig.workflow_assignment === "object"
    ? roleConfig.workflow_assignment
    : {};

  const workflowOut = { ...workflowIn };
  const used = new Set();
  const { byName, byIdentity } = buildCatIndexes(cats);

  for (const stage of stages) {
    const profile = roleProfiles[stage] && typeof roleProfiles[stage] === "object"
      ? roleProfiles[stage]
      : {};
    const displayName = clip(profile.display_name);
    const nickname = clip(profile.nickname);

    let catName = null;
    const explicit = clip(workflowIn[stage]);
    if (explicit && cats[explicit] && !used.has(explicit)) {
      catName = explicit;
    } else {
      catName = pickByIdentity({
        displayName,
        nickname,
        byName,
        byIdentity,
        cats,
        used,
      });
    }
    if (!catName || !cats[catName]) continue;
    used.add(catName);
    workflowOut[stage] = catName;

    const catCfg = cats[catName];
    const stageModelId = clip(stageAssignment[stage], 128);
    if (stageModelId) catCfg.model_id = stageModelId;
    if (displayName) catCfg.display_name = displayName;
    if (nickname) catCfg.nickname = nickname;
    catCfg.aliases = toAliasList([
      ...(Array.isArray(catCfg.aliases) ? catCfg.aliases : []),
      displayName,
      nickname,
    ]);
  }

  return {
    ...roleConfig,
    cats,
    workflow_assignment: workflowOut,
  };
}

module.exports = {
  syncRoleConfigCats,
};

