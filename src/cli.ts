#!/usr/bin/env node
// pattern: imperative-shell
// Entry point: load appa.config.{js,mjs} from cwd and start the server.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { type AppaConfig, resolveConfig } from "./core/config.js";
import { buildApp } from "./server/index.js";

async function main(): Promise<void> {
  loadDotenv();

  const configPath = findConfig();
  if (!configPath) {
    console.error("appa: no appa.config.js or appa.config.mjs found in", process.cwd());
    console.error("Run `npx create-appa <dir>` to scaffold a new project.");
    process.exit(1);
  }

  const mod = (await import(pathToFileURL(configPath).href)) as { default?: AppaConfig };
  if (!mod.default) {
    console.error(`appa: ${configPath} has no default export`);
    process.exit(1);
  }

  // Env vars override config-file defaults so deployments can re-target without editing checked-in files.
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const envHost = process.env.HOST;
  const envProjectDir = process.env.APPA_PROJECT_DIR;
  const envModel = process.env.APPA_MODEL;

  const config = resolveConfig({
    ...mod.default,
    projectDir: envProjectDir ?? mod.default.projectDir ?? process.cwd(),
    ...(envPort && Number.isFinite(envPort) ? { port: envPort } : {}),
    ...(envHost ? { host: envHost } : {}),
    ...(envModel ? { model: envModel } : {}),
  });

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("appa: ANTHROPIC_API_KEY is not set. Add it to .env and try again.");
    process.exit(1);
  }

  const { app } = await buildApp(config);
  app.listen(config.port, config.host, () => {
    console.log(`appa listening on http://${config.host}:${config.port}`);
    console.log(`  project dir: ${config.projectDir}`);
    console.log(`  modules: ${config.modules.map((m) => m.name).join(", ") || "(none)"}`);
  });
}

function findConfig(): string | null {
  const candidates = ["appa.config.js", "appa.config.mjs"];
  for (const c of candidates) {
    const full = resolve(process.cwd(), c);
    if (existsSync(full)) return full;
  }
  return null;
}

main().catch((err: unknown) => {
  console.error("appa: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
