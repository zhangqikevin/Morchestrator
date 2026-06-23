import type { FuguRequest, TaskType } from "./types.js";
import type { LiteLLMClient } from "./client.js";

function ruleBasedClassify(req: FuguRequest): TaskType | null {
  if (req.tools && req.tools.length > 0) return "tool_use";
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const text = lastUser.toLowerCase();
  const codeKeywords = ["write", "code", "implement", "function", "class", "script", "bug", "debug", "refactor", "typescript", "python", "javascript", "写代码", "实现", "函数", "脚本", "编写"];
  const reasoningKeywords = ["why", "explain", "analyze", "compare", "reason", "think", "step by step", "pros and cons", "trade-off", "为什么", "分析", "解释", "推导", "比较"];
  if (codeKeywords.some((k) => text.includes(k))) return "code";
  if (reasoningKeywords.some((k) => text.includes(k))) return "reasoning";
  if (lastUser.length < 80) return "simple";
  return null;
}

export async function classifyTask(req: FuguRequest, client: LiteLLMClient, fastModel: string): Promise<TaskType> {
  if (req.taskType) return req.taskType;
  const rule = ruleBasedClassify(req);
  if (rule) return rule;
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const res = await client.chat({
    model: fastModel,
    messages: [
      { role: "system", content: "Classify into exactly one of: simple, reasoning, code, tool_use.\n- simple: factual Q&A, translation, short tasks\n- reasoning: analysis, explanation, comparison, multi-step thinking\n- code: write/debug/refactor any code\n- tool_use: needs external tools/APIs/search\nReply with ONLY the category word." },
      { role: "user", content: lastUser },
    ],
    temperature: 0,
    max_tokens: 10,
  });
  const label = res.content.trim().toLowerCase();
  return (["simple", "reasoning", "code", "tool_use"].includes(label) ? label : "simple") as TaskType;
}
