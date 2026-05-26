#!/usr/bin/env node
// pattern: imperative-shell
// `npx create-appa <dir>` — scaffold a new Appa project.

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Templates {
  /** Files copied verbatim. */
  verbatim: string[];
  /** Files with __APPA_PROJECT_NAME__ substituted; written without .tmpl suffix. */
  substituted: string[];
}

const TEMPLATES: Templates = {
  verbatim: [
    "appa.config.js",
    "team.json",
    "tutor-prompt.md",
    "shared-memory.md",
    ".env.example",
    ".gitignore",
  ],
  substituted: ["package.json.tmpl", "README.md.tmpl"],
};

async function main(): Promise<void> {
  const targetArg = process.argv[2];
  if (!targetArg) {
    console.error("Usage: create-appa <directory>");
    process.exit(1);
  }
  const target = resolve(process.cwd(), targetArg);
  if (await exists(target)) {
    console.error(`Refusing to overwrite existing directory: ${target}`);
    process.exit(1);
  }
  const projectName = basenameSafe(target);
  await mkdir(target, { recursive: true });

  const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

  for (const f of TEMPLATES.verbatim) {
    await copyFile(join(templatesDir, f), join(target, f));
  }
  for (const f of TEMPLATES.substituted) {
    const content = await readFile(join(templatesDir, f), "utf8");
    const out = content.replace(/__APPA_PROJECT_NAME__/g, projectName);
    const outName = f.replace(/\.tmpl$/, "");
    await writeFile(join(target, outName), out, "utf8");
  }

  // Sanity check: there should be exactly the files we expect.
  const written = await readdir(target);
  console.log(`Scaffolded ${written.length} files in ${target}:`);
  for (const w of written.sort()) console.log(`  ${w}`);
  console.log();
  console.log("Next steps:");
  console.log(`  cd ${targetArg}`);
  console.log("  cp .env.example .env && edit .env  # set ANTHROPIC_API_KEY");
  console.log("  npm install");
  console.log("  npm start");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function basenameSafe(path: string): string {
  const last = path.split(/[\\/]/).filter(Boolean).pop() ?? "appa-project";
  return last.replace(/[^\w.-]/g, "-");
}

main().catch((err: unknown) => {
  console.error("create-appa: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
