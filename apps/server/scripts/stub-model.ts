/**
 * A tiny OpenAI-compatible stub server for end-to-end verification.
 *
 * It answers the three prompts the pipeline sends (classification,
 * adjudication, insight) and records every request so the caller can confirm
 * the exact URL and payload shape the client produces.
 *
 * Usage: vp run server#stub-model [port]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4123);
const log: { url: string; body: unknown }[] = [];

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }

  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    let payload: { messages?: { role: string; content: string }[] } = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      response.writeHead(400).end();
      return;
    }

    const system = payload.messages?.[0]?.content ?? "";
    const user = payload.messages?.[1]?.content ?? "";
    log.push({ url: request.url ?? "", body: payload });

    let content: string;
    if (system.includes("You classify news items")) {
      const count = user.split("\n").length;
      content = JSON.stringify({
        results: Array.from({ length: count }, (_, index) => ({ index, relevant: true })),
      });
    } else if (system.includes("You group news articles")) {
      content = '{"index": -1}';
    } else {
      const headlineOnly = user.includes("本次材料全部只有标题");
      content = JSON.stringify({
        title: "中文标题（本地桩）",
        facts: [{ text: "这是由本地桩生成的事实摘要。", citations: ["0"] }],
        importance: { score: 78, reason: "本地桩判定为较重要" },
        impact: headlineOnly ? null : "可能影响相关厂商的竞争格局。",
        watch: null,
        material_update: { is: true, reason: "首次报道" },
      });
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "stub",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

server.listen(port, () => {
  console.log(`stub model listening on http://localhost:${port}`);
  console.log(`requests will be logged to stdout`);
});

// Print a summary on shutdown so the caller can inspect the URLs hit.
const shutdown = () => {
  const urls = new Set(log.map((entry) => entry.url));
  console.log(`\nreceived ${log.length} requests across URLs: ${[...urls].join(", ")}`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
