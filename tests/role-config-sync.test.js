"use strict";

const assert = require("node:assert/strict");
const { syncRoleConfigCats } = require("../src/engine/role-config-sync");

function testStageProfilesDriveCatsModel() {
  const input = {
    stage_assignment: { coder: "claude", reviewer: "glm", tester: "codex" },
    role_profiles: {
      coder: { display_name: "银渐层", nickname: "牛奶" },
      reviewer: { display_name: "阿比西尼亚", nickname: "咖啡" },
      tester: { display_name: "加菲猫", nickname: "Billy" },
    },
    cats: {
      "银渐层": { model_id: "glm", nickname: "旧牛奶", aliases: ["旧牛奶"] },
      "阿比西尼亚": { model_id: "codex", nickname: "旧咖啡", aliases: ["旧咖啡"] },
      "加菲猫": { model_id: "glm", nickname: "旧Billy", aliases: ["旧Billy"] },
    },
  };

  const out = syncRoleConfigCats(input);
  assert.equal(out.cats["银渐层"].model_id, "claude");
  assert.equal(out.cats["阿比西尼亚"].model_id, "glm");
  assert.equal(out.cats["加菲猫"].model_id, "codex");
  assert.equal(out.cats["加菲猫"].nickname, "Billy");
  assert.equal(out.workflow_assignment.coder, "银渐层");
  assert.equal(out.workflow_assignment.reviewer, "阿比西尼亚");
  assert.equal(out.workflow_assignment.tester, "加菲猫");
  assert.ok(out.cats["加菲猫"].aliases.includes("Billy"));
}

function testWorkflowAssignmentHasPriority() {
  const input = {
    stage_assignment: { coder: "codex", reviewer: "glm", tester: "claude" },
    workflow_assignment: { coder: "加菲猫", reviewer: "阿比西尼亚", tester: "银渐层" },
    role_profiles: {
      coder: { display_name: "银渐层", nickname: "牛奶" },
      reviewer: { display_name: "阿比西尼亚", nickname: "咖啡" },
      tester: { display_name: "加菲猫", nickname: "Billy" },
    },
    cats: {
      "银渐层": { model_id: "x", nickname: "A", aliases: [] },
      "阿比西尼亚": { model_id: "y", nickname: "B", aliases: [] },
      "加菲猫": { model_id: "z", nickname: "C", aliases: [] },
    },
  };

  const out = syncRoleConfigCats(input);
  assert.equal(out.cats["加菲猫"].model_id, "codex");
  assert.equal(out.cats["阿比西尼亚"].model_id, "glm");
  assert.equal(out.cats["银渐层"].model_id, "claude");
  assert.equal(out.workflow_assignment.coder, "加菲猫");
  assert.equal(out.workflow_assignment.reviewer, "阿比西尼亚");
  assert.equal(out.workflow_assignment.tester, "银渐层");
}

function main() {
  testStageProfilesDriveCatsModel();
  testWorkflowAssignmentHasPriority();
  console.log("ok role-config-sync");
}

main();

