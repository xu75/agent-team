"use strict";

const assert = require("node:assert");
const {
  DEFAULT_PROMPT_HISTORY_LIMIT,
  buildCatLookup,
  parseMentions,
  resolvePromptUserText,
  selectPromptHistory,
  buildWorkflowTaskPrompt,
  selectEffectiveTargets,
  buildChatContext,
} = require("../src/engine/context-builder");

function run() {
  const cats = {
    "银渐层": { nickname: "牛奶", aliases: ["Milk"], persona: "A" },
    "阿比西尼亚": { nickname: "咖啡", aliases: ["Coffee"], persona: "B" },
    "加菲猫": { nickname: "Billy", aliases: ["billy"], persona: "C" },
  };

  const lookup = buildCatLookup(cats);
  assert.strictEqual(lookup.get("牛奶").cat_name, "银渐层");
  assert.strictEqual(lookup.get("coffee").cat_name, "阿比西尼亚");

  const mention = parseMentions("@牛奶 @Coffee 帮我看下，@牛奶 再补充", lookup);
  assert.strictEqual(mention.targets.length, 2);
  assert.strictEqual(mention.targets[0].cat_name, "银渐层");
  assert.strictEqual(mention.targets[1].cat_name, "阿比西尼亚");
  assert.strictEqual(resolvePromptUserText("x", mention.cleanText), "帮我看下， 再补充");

  const nonWorkflowTargets = selectEffectiveTargets({
    mode: "free_chat",
    modeState: {},
    cats,
    mentionTargets: mention.targets,
    workflowNodes: [],
  });
  assert.deepStrictEqual(
    nonWorkflowTargets.map((t) => t.cat_name),
    ["银渐层", "阿比西尼亚"]
  );

  const workflowTargets = selectEffectiveTargets({
    mode: "workflow",
    modeState: {
      current_node: "reviewer",
      role_map: {
        "银渐层": "CoreDev",
        "阿比西尼亚": "Reviewer",
        "加菲猫": "Tester",
      },
    },
    cats,
    mentionTargets: mention.targets,
    workflowNodes: [
      { id: "coder", role: "CoreDev" },
      { id: "reviewer", role: "Reviewer" },
      { id: "tester", role: "Tester" },
    ],
  });
  assert.deepStrictEqual(workflowTargets.map((t) => t.cat_name), ["阿比西尼亚"]);

  const history = Array.from({ length: DEFAULT_PROMPT_HISTORY_LIMIT + 3 }, (_, i) => ({
    sender: "u",
    sender_type: "user",
    text: `msg-${i + 1}`,
  }));
  const promptHistory = selectPromptHistory(history);
  assert.strictEqual(promptHistory.length, DEFAULT_PROMPT_HISTORY_LIMIT);
  assert.strictEqual(promptHistory[0].text, "msg-4");

  const workflowPrompt = buildWorkflowTaskPrompt(
    [
      { sender_type: "user", text: "主任务" },
      { sender_type: "cat", text: "猫回复" },
      { sender_type: "user", text: "补充A" },
      { sender_type: "user", text: "补充B" },
    ],
    "fallback"
  );
  assert(workflowPrompt.includes("主任务"));
  assert(workflowPrompt.includes("1. 补充A"));
  assert(workflowPrompt.includes("2. 补充B"));
  assert(!workflowPrompt.includes("猫回复"));

  const ctx = buildChatContext({
    mode: "free_chat",
    modeState: {},
    userText: "@billy  帮我写个测试",
    cats,
    history,
    workflowNodes: [],
  });
  assert.strictEqual(ctx.promptUserText, "帮我写个测试");
  assert.deepStrictEqual(ctx.effectiveTargets.map((t) => t.cat_name), ["加菲猫"]);
  assert.strictEqual(ctx.promptHistory.length, DEFAULT_PROMPT_HISTORY_LIMIT);
  assert(ctx.workflowTaskPrompt.length > 0);

  process.stdout.write("context builder tests passed\n");
}

run();
