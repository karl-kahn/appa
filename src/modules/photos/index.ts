// pattern: imperative-shell
// Photo uploads with uploader attribution and listing.

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import multer from "multer";
import { z } from "zod";
import type { AppaModule } from "../types.js";

interface PhotoRecord {
  filename: string;
  originalName: string;
  uploaderId: string;
  uploaderName: string;
  uploadedAt: string;
  caption?: string;
  size: number;
  mimeType: string;
}

const KEY = "photos.json";
const UPLOADS_DIR = "photos";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"]);

const Caption = z.object({
  filename: z.string(),
  caption: z.string().max(500),
});

function buildUploader(projectDir: string): multer.Multer {
  const uploadsRoot = join(projectDir, UPLOADS_DIR);
  return multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        await mkdir(uploadsRoot, { recursive: true });
        cb(null, uploadsRoot);
      },
      filename: (_req, file, cb) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const safe = file.originalname.replace(/[^\w.-]/g, "_");
        cb(null, `${stamp}_${safe}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
      else cb(new Error(`unsupported file type: ${file.mimetype}`));
    },
  });
}

const promptFragment = `
The team can upload photos for presentations and documentation.
Use \`get_photos\` to list them with uploader attribution and timestamps.
You can suggest captions but cannot upload yourself.
`;

const mod: AppaModule = {
  name: "photos",
  promptFragment,
  tools: {
    get_photos: async ({ ctx }) => ctx.storage.read<PhotoRecord[]>(KEY, []),
  },
  routes: (router, { storage, team, projectDir, requireCaller }) => {
    const uploader = buildUploader(projectDir);

    router.post("/api/photos/upload", uploader.array("photos", 10), async (req, res) => {
      const caller = await requireCaller(req, res);
      if (!caller) return;
      const member = await team.findById(caller.id);
      const uploaderName = member?.name ?? caller.id;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];

      const records: PhotoRecord[] = files.map((f) => ({
        filename: f.filename,
        originalName: f.originalname,
        uploaderId: caller.id,
        uploaderName,
        uploadedAt: new Date().toISOString(),
        size: f.size,
        mimeType: f.mimetype,
      }));

      await storage.update<PhotoRecord[]>(KEY, [], (cur) => [...records, ...cur]);
      res.json({ added: records.length, records });
    });

    router.get("/api/photos", async (req, res) => {
      const caller = await requireCaller(req, res);
      if (!caller) return;
      res.json({ photos: await storage.read<PhotoRecord[]>(KEY, []) });
    });

    router.get("/api/photos/file/:filename", async (req, res) => {
      // File serving still requires auth so photos aren't world-readable
      // from a leaked URL. Filenames are sanitized at upload time.
      const caller = await requireCaller(req, res);
      if (!caller) return;
      const filename = typeof req.params.filename === "string" ? req.params.filename : "";
      if (!/^[\w.-]+$/.test(filename)) {
        res.status(400).json({ error: "bad filename" });
        return;
      }
      res.sendFile(join(projectDir, UPLOADS_DIR, filename));
    });

    router.delete("/api/photos/:filename", async (req, res) => {
      const caller = await requireCaller(req, res);
      if (!caller) return;
      const filename = typeof req.params.filename === "string" ? req.params.filename : "";
      if (!/^[\w.-]+$/.test(filename)) {
        res.status(400).json({ error: "bad filename" });
        return;
      }
      // Only the uploader or a coach can delete.
      const existing = await storage.read<PhotoRecord[]>(KEY, []);
      const record = existing.find((p) => p.filename === filename);
      if (record && !caller.isCoach && record.uploaderId !== caller.id) {
        res.status(403).json({ error: "not your photo" });
        return;
      }
      await storage.update<PhotoRecord[]>(KEY, [], (cur) =>
        cur.filter((p) => p.filename !== filename),
      );
      try {
        await unlink(join(projectDir, UPLOADS_DIR, filename));
      } catch {
        // file may already be gone; metadata is the source of truth
      }
      res.json({ deleted: filename });
    });

    router.post("/api/photos/caption", async (req, res) => {
      const caller = await requireCaller(req, res);
      if (!caller) return;
      const parsed = Caption.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      // Only the uploader or a coach can caption.
      const existing = await storage.read<PhotoRecord[]>(KEY, []);
      const record = existing.find((p) => p.filename === parsed.data.filename);
      if (record && !caller.isCoach && record.uploaderId !== caller.id) {
        res.status(403).json({ error: "not your photo" });
        return;
      }
      await storage.update<PhotoRecord[]>(KEY, [], (cur) =>
        cur.map((p) =>
          p.filename === parsed.data.filename ? { ...p, caption: parsed.data.caption } : p,
        ),
      );
      res.json({ ok: true });
    });
  },
  tab: {
    id: "photos-view",
    label: "Photos",
    htmlPath: "tab.html",
  },
  dir: new URL(".", import.meta.url).pathname,
};

export default mod;
