import { FuguOrchestrator } from "../src/index.js";

const fugu = new FuguOrchestrator({
  baseUrl: "https://proxy.kevinzhang.fun/litellm",
  apiKey: process.env.LITELLM_API_KEY ?? "",
  verbose: true,
});

const r = await fugu.run({ messages: [{ role: "user", content: "用 TypeScript 写一个 debounce 函数" }] });
console.log("taskType:", r.taskType, "models:", r.modelsUsed);
console.log(r.content);

console.log("\n--- streaming ---\n");
for await (const chunk of fugu.stream({ messages: [{ role: "user", content: "解释一下 CAP 定理" }] })) {
  if (chunk.type === "progress") process.stdout.write(`\n${chunk.progress}`);
  else if (chunk.type === "delta") process.stdout.write(chunk.text ?? "");
  else if (chunk.type === "done") console.log(`\n\n[done] ${chunk.taskType} | ${chunk.modelsUsed?.join(", ")}`);
}
