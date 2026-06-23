# Morchestrator

Fugu-style multi-model orchestrator for LiteLLM, written in TypeScript. Routes tasks to the best model(s) automatically with full streaming support.

## How it works

| Task type | Strategy | Streaming |
|-----------|----------|-----------|
| `simple` | Direct → fastChat model | ✅ Zero extra latency |
| `reasoning` | Draft (fast) → Refine (strong) | ✅ Streams draft first, then refined |
| `code` | Parallel workers → Orchestrator review | ✅ Progress events + streams final |
| `tool_use` | Single orchestrator owns tool schema | ✅ Streams + emits tool_call events |

## Usage

```typescript
import { FuguOrchestrator } from "morchestrator";

const fugu = new FuguOrchestrator({
  baseUrl: "https://your-litellm-proxy/litellm",
  apiKey: "your-api-key",
  verbose: true,
});

// Non-streaming
const res = await fugu.run({
  messages: [{ role: "user", content: "Write a TypeScript LRU cache" }],
});

// Streaming
for await (const chunk of fugu.stream({
  messages: [{ role: "user", content: "Explain the CAP theorem" }],
})) {
  if (chunk.type === "progress") process.stdout.write(chunk.progress ?? "");
  if (chunk.type === "delta") process.stdout.write(chunk.text ?? "");
  if (chunk.type === "done") console.log("\ndone:", chunk.modelsUsed);
}
```

## StreamChunk types

- `progress` — orchestration progress message
- `delta` — incremental text token
- `tool_call` — tool call event (tool_use tasks)
- `done` — final event with taskType, modelsUsed, usage
