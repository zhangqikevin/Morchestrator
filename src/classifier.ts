import type { FuguRequest, TaskType } from "./types.js";
import type { LiteLLMClient } from "./client.js";

function ruleBasedClassify(req: FuguRequest): TaskType | null {
  if (req.tools?.length) return "tool_use";
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const t = lastUser.toLowerCase();
  const code = ["write","code","implement","function","class","script","bug","debug","refactor","typescript","python","javascript","写代码","实现","函数","脚本","编写"];
  const reason = ["why","explain","analyze","compare","reason","think","step by step","pros and cons","trade-off","为什么","分析","解释","推导","比较"];
  if (code.some((k) => t.includes(k))) return "code";
  if (reason.some((k) => t.includes(k))) return "reasoning";
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
      { role: "system", content: "Classify into exactly one of: simple, reasoning, code, tool_use.\nReply with ONLY the category word." },
      { role: "user", content: lastUser },
    ],
    temperature: 0, max_tokens: 10,
  });
  const label = res.content.trim().toLowerCase();
  return (["simple","reasoning","code","tool_use"].includes(label) ? label : "simple") as TaskType;
}
