// pattern: imperative-shell
// Build an Express app from a resolved config + module registry.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, Router } from "express";
import type { ResolvedConfig } from "../core/config.js";
import { createMemoryStore } from "../core/memory.js";
import { type RateLimitState, createRateLimitState } from "../core/rate-limit.js";
import { createSessionStore } from "../core/session.js";
import { createStorage } from "../core/storage.js";
import { createTeamReader } from "../core/team.js";
import { createTranscriptStore } from "../core/transcript.js";
import { buildRegistry } from "../modules/registry.js";
import type { ModuleContext } from "../modules/types.js";
import { mountChat } from "./chat.js";
import { mountCoreRoutes } from "./routes.js";
import { securityHeaders } from "./security.js";

export interface AppHandle {
  app: Express;
  rateState: { current: RateLimitState };
  ctx: ModuleContext;
}

export async function buildApp(config: ResolvedConfig): Promise<AppHandle> {
  const projectDir = resolve(config.projectDir);
  const storage = createStorage(projectDir);
  const sessions = createSessionStore(storage);
  const team = createTeamReader(storage, config.teamPath);
  const memory = createMemoryStore(projectDir, config.sharedMemoryPath);
  const transcripts = createTranscriptStore(projectDir);

  const ctx: ModuleContext = { projectDir, storage, team, memory, sessions };
  const registry = buildRegistry(config.modules, ctx, config.extraSystemPrompt);
  await registry.init();

  const rateState = {
    current: createRateLimitState(config.hourlyLimit, config.dailyLimit),
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(securityHeaders);

  const apiRouter = Router();
  mountCoreRoutes(apiRouter, {
    team,
    sessions,
    transcripts,
    tabs: registry.tabs,
  });
  mountChat(apiRouter, {
    config,
    sessions,
    transcripts,
    memory,
    team,
    registry,
    rateState,
  });
  registry.registerRoutes(apiRouter);
  app.use(apiRouter);

  // Per-module asset serving. Each module declares a `dir`; we expose its files at
  // /tabs/<moduleName>/<asset> with path-traversal guards. The UI shell loads tab.html
  // (and any siblings) via this route.
  app.get("/tabs/:moduleName/*splat", (req, res) => {
    const p = req.params as { moduleName?: string; splat?: string | string[] };
    const mn = typeof p.moduleName === "string" ? p.moduleName : "";
    const asset = Array.isArray(p.splat) ? p.splat.join("/") : (p.splat ?? "");
    const found = config.modules.find((m) => m.name === mn);
    if (!found || !found.dir) {
      res.status(404).end();
      return;
    }
    if (!/^[\w./-]+$/.test(asset) || asset.includes("..")) {
      res.status(400).end();
      return;
    }
    const filePath = resolve(found.dir, asset);
    if (!filePath.startsWith(resolve(found.dir))) {
      res.status(400).end();
      return;
    }
    res.sendFile(filePath);
  });

  // Serve the UI shell from <package>/public.
  const here = dirname(fileURLToPath(import.meta.url));
  const publicDir = resolve(here, "..", "..", "public");
  app.use(express.static(publicDir));

  return { app, rateState, ctx };
}
