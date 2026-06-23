import type { Message, ToolDefinition, ToolCall } from "./types.js";

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export class LiteLLMClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async chat(params: {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];
    tool_choice?: string;
    temperature?: number;
    max_tokens?: number;
  }): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        tools: params.tools,
        tool_choice: params.tool_choice,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.max_tokens,
        stream: false,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LiteLLM error [${params.model}] ${res.status}: ${err}`);
    }
    const data = await res.json();
    const msg = data.choices[0].message;
    return {
      content: msg.content ?? "",
      toolCalls: msg.tool_calls,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined,
    };
  }

  async *chatStream(params: {
    model: string;
    messages: Message[];
    tools?: ToolDefinition[];
    tool_choice?: string;
    temperature?: number;
    max_tokens?: number;
  }): AsyncGenerator<{ delta: string; toolCall?: ToolCall; done: boolean; usage?: LLMResponse["usage"] }> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ ...params, stream: true }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LiteLLM stream error [${params.model}] ${res.status}: ${err}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: LLMResponse["usage"] | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") { yield { delta: "", done: true, usage }; return; }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (parsed.usage) usage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens };
          const delta = choice.delta?.content ?? "";
          const toolCalls: ToolCall[] | undefined = choice.delta?.tool_calls;
          if (toolCalls?.length) { for (const tc of toolCalls) yield { delta: "", toolCall: tc, done: false }; }
          else if (delta) yield { delta, done: false };
        } catch { /* skip */ }
      }
    }
  }
}
