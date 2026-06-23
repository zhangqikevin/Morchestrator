import type { FuguRequest, StreamChunk, TaskType, ModelRoles, Message } from "./types.js";
import type { LiteLLMClient } from "./client.js";
import { classifyTask } from "./classifier.js";

export class StreamingOrchestrator {
  constructor(private client: LiteLLMClient, private roles: ModelRoles, private maxWorkers: number, private verbose: boolean) {}

  async *stream(req: FuguRequest): AsyncGenerator<StreamChunk> {
    const taskType = await classifyTask(req, this.client, this.roles.fastChat);
    if (this.verbose) console.log(`[Morchestrator] stream task_type=${taskType}`);
    switch (taskType) {
      case "simple":    yield* this.streamSimple(req, taskType); break;
      case "tool_use":  yield* this.streamToolUse(req, taskType); break;
      case "reasoning": yield* this.streamReasoning(req, taskType); break;
      case "code":      yield* this.streamCode(req, taskType); break;
    }
  }

  private async *streamSimple(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const model = this.roles.fastChat; let usage;
    for await (const c of this.client.chatStream({ model, messages: req.messages, temperature: req.temperature, max_tokens: req.maxTokens })) {
      if (c.done) { usage = c.usage; break; }
      if (c.delta) yield { type: "delta", text: c.delta };
    }
    yield { type: "done", taskType, modelsUsed: [model], usage };
  }

  private async *streamToolUse(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const model = this.roles.toolUse; let usage;
    const acc: Record<number, { id: string; name: string; args: string }> = {};
    for await (const c of this.client.chatStream({ model, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice ?? "auto", temperature: req.temperature ?? 0, max_tokens: req.maxTokens })) {
      if (c.done) { usage = c.usage; break; }
      if (c.toolCall) {
        const tc = c.toolCall as any; const idx = tc.index ?? 0;
        if (!acc[idx]) acc[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
        acc[idx].args += tc.function?.arguments ?? "";
      } else if (c.delta) yield { type: "delta", text: c.delta };
    }
    for (const tc of Object.values(acc)) yield { type: "tool_call", toolCall: { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } } };
    yield { type: "done", taskType, modelsUsed: [model], usage };
  }

  private async *streamReasoning(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const modelsUsed: string[] = [];
    yield { type: "progress", progress: `🚀 起草中 (${this.roles.fastChat})...` };
    let draft = "";
    for await (const c of this.client.chatStream({ model: this.roles.fastChat, messages: req.messages, temperature: req.temperature ?? 0.5, max_tokens: req.maxTokens })) {
      if (c.done) break;
      if (c.delta) { draft += c.delta; yield { type: "delta", text: c.delta }; }
    }
    modelsUsed.push(this.roles.fastChat);
    yield { type: "progress", progress: `\n\n---\n🔍 深度优化中 (${this.roles.reasoning})...\n\n` };
    const refine: Message[] = [...req.messages, { role: "assistant", content: draft }, { role: "user", content: "Review and improve. Fix errors and gaps. If correct, restate concisely." }];
    let usage;
    for await (const c of this.client.chatStream({ model: this.roles.reasoning, messages: refine, temperature: 0.3, max_tokens: req.maxTokens })) {
      if (c.done) { usage = c.usage; break; }
      if (c.delta) yield { type: "delta", text: c.delta };
    }
    modelsUsed.push(this.roles.reasoning);
    yield { type: "done", taskType, modelsUsed, usage };
  }

  private async *streamCode(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const workers = this.roles.code.slice(0, this.maxWorkers);
    yield { type: "progress", progress: `⚡ 并行生成中 (${workers.join(", ")})...` };
    const results = await Promise.allSettled(workers.map((model) => this.client.chat({ model, messages: req.messages, temperature: req.temperature ?? 0.2, max_tokens: req.maxTokens }).then((r) => ({ model, content: r.content }))));
    const ok = results.filter((r): r is PromiseFulfilledResult<{ model: string; content: string }> => r.status === "fulfilled").map((r) => r.value);
    if (!ok.length) throw new Error("All code workers failed");
    if (ok.length === 1) {
      yield { type: "progress", progress: `\n✓ 生成完成，输出中...\n\n` };
      yield { type: "delta", text: ok[0].content };
      yield { type: "done", taskType, modelsUsed: ok.map((s) => s.model) };
      return;
    }
    yield { type: "progress", progress: `\n✓ ${ok.length} 个版本完成，合并优化中...\n\n` };
    const q = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const drafts = ok.map((d, i) => `### Draft ${i + 1} (${d.model})\n${d.content}`).join("\n\n---\n\n");
    const review: Message[] = [
      { role: "system", content: "Senior code reviewer. Pick best draft or synthesize. Output ONLY final code." },
      { role: "user", content: `Task:\n${q}\n\n${drafts}` },
    ];
    let usage;
    for await (const c of this.client.chatStream({ model: this.roles.orchestrator, messages: review, temperature: 0.1 })) {
      if (c.done) { usage = c.usage; break; }
      if (c.delta) yield { type: "delta", text: c.delta };
    }
    yield { type: "done", taskType, modelsUsed: [this.roles.orchestrator, ...ok.map((s) => s.model)], usage };
  }
}
