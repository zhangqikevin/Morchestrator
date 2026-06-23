import type { FuguRequest, StreamChunk, TaskType, ModelRoles, Message } from "./types.js";
import type { LiteLLMClient } from "./client.js";
import { classifyTask } from "./classifier.js";

export class StreamingOrchestrator {
  constructor(
    private client: LiteLLMClient,
    private roles: ModelRoles,
    private maxWorkers: number,
    private verbose: boolean,
  ) {}

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
    const model = this.roles.fastChat;
    let usage;
    for await (const chunk of this.client.chatStream({ model, messages: req.messages, temperature: req.temperature, max_tokens: req.maxTokens })) {
      if (chunk.done) { usage = chunk.usage; break; }
      if (chunk.delta) yield { type: "delta", text: chunk.delta };
    }
    yield { type: "done", taskType, modelsUsed: [model], usage };
  }

  private async *streamToolUse(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const model = this.roles.toolUse;
    let usage;
    const toolCallAcc: Record<number, { id: string; name: string; args: string }> = {};
    for await (const chunk of this.client.chatStream({ model, messages: req.messages, tools: req.tools, tool_choice: req.tool_choice ?? "auto", temperature: req.temperature ?? 0, max_tokens: req.maxTokens })) {
      if (chunk.done) { usage = chunk.usage; break; }
      if (chunk.toolCall) {
        const tc = chunk.toolCall as any;
        const idx = tc.index ?? 0;
        if (!toolCallAcc[idx]) toolCallAcc[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
        toolCallAcc[idx].args += tc.function?.arguments ?? "";
      } else if (chunk.delta) {
        yield { type: "delta", text: chunk.delta };
      }
    }
    for (const tc of Object.values(toolCallAcc)) {
      yield { type: "tool_call", toolCall: { id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } } };
    }
    yield { type: "done", taskType, modelsUsed: [model], usage };
  }

  private async *streamReasoning(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const modelsUsed: string[] = [];
    yield { type: "progress", progress: `🚀 起草中 (${this.roles.fastChat})...` };
    let draftContent = "";
    for await (const chunk of this.client.chatStream({ model: this.roles.fastChat, messages: req.messages, temperature: req.temperature ?? 0.5, max_tokens: req.maxTokens })) {
      if (chunk.done) break;
      if (chunk.delta) { draftContent += chunk.delta; yield { type: "delta", text: chunk.delta }; }
    }
    modelsUsed.push(this.roles.fastChat);
    yield { type: "progress", progress: `\n\n---\n🔍 深度优化中 (${this.roles.reasoning})...\n\n` };
    const refineMessages: Message[] = [
      ...req.messages,
      { role: "assistant", content: draftContent },
      { role: "user", content: "Review the answer above. Fix any errors or gaps, then produce an improved final answer. If already correct, restate concisely." },
    ];
    let usage;
    for await (const chunk of this.client.chatStream({ model: this.roles.reasoning, messages: refineMessages, temperature: 0.3, max_tokens: req.maxTokens })) {
      if (chunk.done) { usage = chunk.usage; break; }
      if (chunk.delta) yield { type: "delta", text: chunk.delta };
    }
    modelsUsed.push(this.roles.reasoning);
    yield { type: "done", taskType, modelsUsed, usage };
  }

  private async *streamCode(req: FuguRequest, taskType: TaskType): AsyncGenerator<StreamChunk> {
    const workers = this.roles.code.slice(0, this.maxWorkers);
    yield { type: "progress", progress: `⚡ 并行生成中 (${workers.join(", ")})...` };
    const results = await Promise.allSettled(
      workers.map((model) => this.client.chat({ model, messages: req.messages, temperature: req.temperature ?? 0.2, max_tokens: req.maxTokens }).then((r) => ({ model, content: r.content })))
    );
    const succeeded = results.filter((r): r is PromiseFulfilledResult<{ model: string; content: string }> => r.status === "fulfilled").map((r) => r.value);
    if (succeeded.length === 0) throw new Error("All code workers failed");
    const modelsUsed = succeeded.map((s) => s.model);
    if (succeeded.length === 1) {
      yield { type: "progress", progress: `\n✓ 生成完成，输出中...\n\n` };
      yield { type: "delta", text: succeeded[0].content };
      yield { type: "done", taskType, modelsUsed };
      return;
    }
    yield { type: "progress", progress: `\n✓ ${succeeded.length} 个版本完成，合并优化中...\n\n` };
    const originalQuestion = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const draftsText = succeeded.map((d, i) => `### Draft ${i + 1} (${d.model})\n${d.content}`).join("\n\n---\n\n");
    const reviewMessages: Message[] = [
      { role: "system", content: "You are a senior code reviewer. Pick the best draft or synthesize the best parts. Output ONLY the final code with brief inline comments. No meta-commentary." },
      { role: "user", content: `Original task:\n${originalQuestion}\n\n${draftsText}` },
    ];
    let usage;
    for await (const chunk of this.client.chatStream({ model: this.roles.orchestrator, messages: reviewMessages, temperature: 0.1 })) {
      if (chunk.done) { usage = chunk.usage; break; }
      if (chunk.delta) yield { type: "delta", text: chunk.delta };
    }
    yield { type: "done", taskType, modelsUsed: [this.roles.orchestrator, ...modelsUsed], usage };
  }
}
