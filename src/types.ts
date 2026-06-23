export type TaskType = "simple" | "reasoning" | "code" | "tool_use";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ModelRoles {
  orchestrator: string;
  fastChat: string;
  reasoning: string;
  code: string[];
  toolUse: string;
}

export interface OrchestratorConfig {
  baseUrl: string;
  apiKey: string;
  models?: Partial<ModelRoles>;
  maxWorkers?: number;
  maxRetries?: number;
  verbose?: boolean;
}

export interface FuguRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
  taskType?: TaskType;
}

export interface FuguResponse {
  content: string;
  taskType: TaskType;
  modelsUsed: string[];
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export type StreamChunkType = "progress" | "delta" | "tool_call" | "done";

export interface StreamChunk {
  type: StreamChunkType;
  text?: string;
  progress?: string;
  toolCall?: ToolCall;
  taskType?: TaskType;
  modelsUsed?: string[];
  usage?: { promptTokens: number; completionTokens: number };
}
