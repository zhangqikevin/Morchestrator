import type { Message, ToolDefinition, ToolCall } from "./types.js";

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export class LiteLLMClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async chat(params: {
    model: string; messages: Message[]; tools?: ToolDefinition[];
    tool_choice?: string; temperature?: number; max_tokens?: number;
  }): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ ...params, stream: false }),
    });
    if (!res.ok) throw new Error(`LiteLLM error [${params.model}] ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices[0].message;
    return {
      content: msg.content ?? "",
      toolCalls: msg.tool_calls,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined,
    };
  }

  async *chatStream(params: {
    model: string; messages: Message[]; tools?: ToolDefinition[];
    tool_choice?: string; temperature?: number; max_tokens?: number;
  }): AsyncGenerator<{ delta: string; toolCall?: ToolCall; done: boolean; usage?: LLMResponse["usage"] }> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ ...params, stream: true }),
    });
    if (!res.ok) throw new Error(`LiteLLM stream error [${params.model}] ${res.status}: ${await res.text()}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "", usage: LLMResponse["usage"] | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith("data: ")) continue;
        const d = t.slice(6);
        if (d === "[DONE]") { yield { delta: "", done: true, usage }; return; }
        try {
          const p = JSON.parse(d);
          const c = p.choices?.[0];
          if (!c) continue;
          if (p.usage) usage = { promptTokens: p.usage.prompt_tokens, completionTokens: p.usage.completion_tokens };
          const delta = c.delta?.content ?? "";
          const tcs: ToolCall[] | undefined = c.delta?.tool_calls;
          if (tcs?.length) { for (const tc of tcs) yield { delta: "", toolCall: tc, done: false }; }
          else if (delta) yield { delta, done: false };
        } catch { /* skip */ }
      }
    }
  }
}
