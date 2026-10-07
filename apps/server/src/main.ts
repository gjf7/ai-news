import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config/env.ts";

/**
 * Loads `.env` from the repo root. Real environment variables take precedence,
 * so Docker (which injects config via env_file) and CI are unaffected, and a
 * missing file is not an error. Without this the file is never read: the app
 * has no dotenv dependency and the start scripts do not pass `--env-file`.
 *
 * Exception: editor tooling (e.g. Cursor) exports OPENAI_BASE_URL/OPENAI_API_KEY
 * into every integrated terminal. Left alone, those shadow the project's own
 * model config and silently redirect insight calls to a local endpoint, where
 * the run hangs. For these keys the file wins.
 */
const ENV_FILE_WINS = ["OPENAI_BASE_URL", "OPENAI_API_KEY"];

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) {
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || ENV_FILE_WINS.includes(key)) {
      process.env[key] = value;
    }
  }
}

async function main() {
  const config = loadConfig();
  const { app, close } = await buildApp({ config });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("Failed to start server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
