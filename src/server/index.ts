// pattern: imperative-shell
// Build an Express app from a resolved config + module registry.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, Router } from "express";
import { createBus } from "../core/bus.js";
import type { ResolvedConfig } from "../core/config.js";
import { createMemoryStore } from "../core/memory.js";
import { createStorage } from "../core/storage.js";
import { createTeamReader } from "../core/team.js";
import { createThreadStore } from "../core/thread.js";
import { createTranscriptStore } from "../core/transcript.js";
import { buildRegistry } from "../modules/registry.js";
import type { ModuleContext } from "../modules/types.js";
import {
  type PerCallerRateState,
  createPerCallerRateState,
  mountChat,
  resolveOr403,
} from "./chat.js";
import { mountCoreRoutes } from "./routes.js";
import { securityHeaders } from "./security.js";

export interface AppHandle {
  app: Express;
  rateState: PerCallerRateState;
  ctx: ModuleContext;
}

export async function buildApp(config: ResolvedConfig): Promise<AppHandle> {
  const projectDir = resolve(config.projectDir);
  const storage = createStorage(projectDir);
  const threads = createThreadStore(storage);
  const team = createTeamReader(storage, config.teamPath);
  const memory = createMemoryStore(projectDir, config.sharedMemoryPath);
  const transcripts = createTranscriptStore(
    projectDir,
    config.onTranscriptAppend ? { onAppend: config.onTranscriptAppend } : {},
  );

  const bus = createBus();
  const ctx: ModuleContext = {
    projectDir,
    storage,
    team,
    memory,
    threads,
    transcripts,
    bus,
    async requireCaller(req, res) {
      return resolveOr403(req, res, { config });
    },
  };
  const registry = buildRegistry(config.modules, ctx, config.extraSystemPrompt);
  await registry.init();

  // Pre-load the tutor persona once; the chat hot path uses this string
  // directly instead of re-reading the file per request. Restart the server
  // (or add a refresh endpoint) to pick up persona edits.
  const personaPath = resolve(projectDir, config.tutorPromptPath);
  let persona = "";
  try {
    persona = await readFile(personaPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    console.warn(`appa: no tutor-prompt.md at ${personaPath} — sessions will have no persona`);
  }

  const rateState = createPerCallerRateState(config.hourlyLimit, config.dailyLimit);

  if (!config.resolveCaller) {
    console.warn(
      "appa: no resolveCaller configured — the kernel will deny every request that " +
        "needs a caller. Set config.resolveCaller (use devAuth() for local dev, or " +
        "wire a real resolver against your proxy / SSO / signed-cookie layer).",
    );
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(securityHeaders);
  // Expose readers on app.locals so middleware/helpers can reach them.
  app.locals.team = team;

  const apiRouter = Router();
  mountCoreRoutes(apiRouter, {
    config,
    team,
    threads,
    transcripts,
    tabs: registry.tabs,
  });
  mountChat(apiRouter, {
    config,
    threads,
    transcripts,
    memory,
    team,
    registry,
    rateState,
    persona,
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
