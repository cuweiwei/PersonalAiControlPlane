import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256, uuidv7 } from "../../../../packages/contracts/src/index.ts";

export type StoredArtifact = { id: string; filename: string; mediaType: string; sizeBytes: number; sha256: string; storagePath: string };

export class ArtifactStorage {
  readonly root: string;
  constructor(root: string) { this.root = root; mkdirSync(root, { recursive: true }); }

  write(taskId: string, filename: string, mediaType: string, bytes: Uint8Array, now = Date.now()): StoredArtifact {
    const artifactId = uuidv7(now);
    const safeName = basename(filename || "artifact.bin").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "artifact.bin";
    const targetDir = join(this.root, new Date(now).toISOString().slice(0, 7).replace("-", "/"), taskId);
    mkdirSync(targetDir, { recursive: true });
    const digest = sha256(bytes);
    const storagePath = join(targetDir, `${artifactId}-${safeName}`);
    writeFileSync(storagePath, bytes, { flag: "wx" });
    return { id: artifactId, filename: safeName, mediaType: mediaType || "application/octet-stream", sizeBytes: bytes.byteLength, sha256: digest, storagePath };
  }

  read(path: string): Buffer { return readFileSync(path); }
  stream(path: string) { return createReadStream(path); }
  exists(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
  isWritable(): boolean { try { accessSync(this.root, constants.W_OK); return true; } catch { return false; } }
  static digest(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
}
