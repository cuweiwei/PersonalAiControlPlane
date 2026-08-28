import { createHash } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, openSync, renameSync, closeSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ArtifactPutOptions = { expectedDigest?: string; maxBytes: number; mediaType: string };
export type ArtifactRef = { digest: string; path: string; size: number; mediaType: string };

function digestBytes(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

export class ContentAddressedArtifactStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "sha256"), { recursive: true });
    mkdirSync(join(root, "manifests"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
  }

  put(bytes: Uint8Array, options: ArtifactPutOptions): ArtifactRef {
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || bytes.byteLength > options.maxBytes) throw new Error("artifact exceeds configured size limit");
    if (!options.mediaType || options.mediaType.length > 200) throw new Error("artifact media type is invalid");
    const digest = digestBytes(bytes);
    if (options.expectedDigest && options.expectedDigest !== digest) throw new Error("artifact digest mismatch");
    const hex = digest.slice("sha256:".length);
    const target = join(this.root, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      const temporary = join(this.root, "tmp", `${hex}.${process.pid}.${Date.now()}`);
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporary, "r");
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      try { renameSync(temporary, target); } catch (error) { if (!existsSync(target)) throw error; }
    }
    return { digest, path: target, size: bytes.byteLength, mediaType: options.mediaType };
  }

  has(digest: string): boolean {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return false;
    const hex = digest.slice(7);
    return existsSync(join(this.root, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex));
  }

  sweep(unreferencedDigests: readonly string[], olderThanMs: number, now = Date.now()): string[] {
    if (!Number.isInteger(olderThanMs) || olderThanMs < 0) throw new Error("artifact grace period is invalid");
    const removed: string[] = [];
    for (const digest of unreferencedDigests) {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) continue;
      const hex = digest.slice(7); const target = join(this.root, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex);
      if (!existsSync(target)) continue;
      if (now - statSync(target).mtimeMs < olderThanMs) continue;
      unlinkSync(target); removed.push(digest);
    }
    return removed;
  }
}
