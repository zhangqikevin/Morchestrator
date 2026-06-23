import type { FuguRequest, FuguResponse, ModelRoles, OrchestratorConfig, StreamChunk, Message } from "./types.js";
import { LiteLLMClient } from "./client.js";
import { classifyTask } from "./classifier.js";
import { StreamingOrchestrator } from "./streaming.js";

export const DEFAULT_ROLES: ModelRoles = {
  orchestrator: "claude-sonnet-4-6",
  fastChat: "gemini-2.5-flash",
  reasoning: "DeepSeek-R1",
  code: ["claude-sonnet-4-6", "gpt-5", "qwen3-coder"],
  toolUse: "claude-sonnet-4-6",
};

export class FuguOrchestrator {
  private client: LiteLLMClient;
  readonly roles: ModelRoles;
  private maxWorkers: number;
  private maxRetries: number;
  private verbose: boolean;
  private streamer: StreamingOrchestrator;

  constructor(config: OrchestratorConfig) {
    this.client = new LiteLLMClient(config.baseUrl, config.apiKey);
    this.roles = { ...DEFAULT_ROLES, ...config.models };
    this.maxWorkers = config.maxWorkers ?? 2;
    this.maxRetries = config.maxRetries ?? 1;
    this.verbose = config.verbose ?? false;
    this.streamer = new StreamingOrchestrator(this.client, this.roles, this.maxWorkers, this.verbose);
  }

  async run(req: FuguRequest): Promise<FuguResponse> {
    const taskType = await classifyTask(req, this.client, this.roles.fastChat);
    if (this.verbose) console.log(`[Morchestrator] task_type=${taskType}`);
    switch (taskType) {
      case "simple":    return this.runSimple(req);
      case "tool_use":  return this.runToolUse(req);
      case "code":      return this.runCode(req);
      case "reasoning": return this.runReasoning(req);
    }
  }

  stream(req: FuguRequest): AsyncGenerator<StreamChunk> { return this.streamer.stream(req); }

  private async runSimple(req: FuguRequest): Promise<FuguResponse> {
    const res = await this.client.chat({ model: this.roles.fastChat, messages: req.messages, temperature: req.temperature, max_tokens: req.maxTokens });
    return { content: res.content, taskType: "simple", modelsUsed: [this.roles.fastChat], usage: res.usage };
  }
  private async runToolUse(req: FuguRequest): Promise<FuguResponse> {
    const model = this.roles.toolUse;
    for (let turn = 0; turn < 10; turn++) {
      const res = await this.client.chat({ model, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice ?? "auto", temperature: req.temperature ?? 0, max_tokens: req.maxTokens });
      if (!res.toolCalls?.length) return { content: res.content, taskType: "tool_use", modelsUsed: [model], usage: res.usage };
      return { content: res.content, taskType: "tool_use", modelsUsed: [model], toolCalls: res.toolCalls, usage: res.usage };
    }
    throw new Error("tool_use loop exceeded 10 turns");
  }
  private async runCode(req: FuguRequest): Promise<FuguResponse> {
    const workers = this.roles.code.slice(0, this.maxWorkers);
    const drafts = await Promise.allSettled(workers.map((model) => this.client.chat({ model, messages: req.messages, temperature: req.temperature ?? 0.2, max_tokens: req.maxTokens }).then((r) => ({ model, content: r.content }))));
    const ok = drafts.filter((d): d is PromiseFulfilledResult<{ model: string; content: string }> => d.status === "fulfilled").map((d) => d.value);
    if (!ok.length) throw new Error("All code workers failed");
    if (ok.length === 1) return { content: ok[0].content, taskType: "code", modelsUsed: [ok[0].model] };
    const q = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const dt = ok.map((d, i) => `### Draft ${i + 1} (${d.model})\n${d.content}`).join("\n\n---\n\n");
    const review = await this.client.chat({ model: this.roles.orchestrator, messages: [{ role: "system", content: "Senior code reviewer. Output ONLY final code." }, { role: "user", content: `Task:\n${q}\n\n${dt}` }], temperature: 0.1 });
    return { content: review.content, taskType: "code", modelsUsed: [this.roles.orchestrator, ...ok.map((s) => s.model)], usage: review.usage };
  }
  private async runReasoning(req: FuguRequest): Promise<FuguResponse> {
    const draft = await this.client.chat({ model: this.roles.fastChat, messages: req.messages, temperature: req.temperature ?? 0.5, max_tokens: req.maxTokens });
    const rm: Message[] = [...req.messages, { role: "assistant", content: draft.content }, { role: "user", content: "Review and improve. Fix errors and gaps." }];
    const refined = await this.client.chat({ model: this.roles.reasoning, messages: rm, temperature: 0.3, max_tokens: req.maxTokens });
    return { content: refined.content, taskType: "reasoning", modelsUsed: [this.roles.fastChat, this.roles.reasoning], usage: refined.usage };
  }
}
