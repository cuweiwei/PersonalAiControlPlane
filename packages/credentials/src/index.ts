import { sha256, uuidv7 } from "../../crypto/src/index.ts";

export type CredentialStorageClass = "nas-vault" | "root-env" | "device-vault" | "provider-session" | "codex-login";
export type CredentialHealth = "HEALTHY" | "EXPIRING" | "EXPIRED" | "UNAVAILABLE" | "REVOKED";

export type CredentialHandle = {
  id: string;
  alias: string;
  storageClass: CredentialStorageClass;
  adapter: string;
  purpose: string;
  scopes: string[];
  health: CredentialHealth;
  expiresAt: number | null;
};

export type CredentialView = Omit<CredentialHandle, "id"> & { id: string };
export type CredentialLease = { id: string; handleId: string; workerId: string | null; expiresAt: number; release: () => void };
export type CredentialResolver = (handle: CredentialHandle) => { available: true; withSecret<T>(callback: (secret: string) => T): T } | { available: false; reason: string };

function parseHandleUri(value: string): { storageClass: CredentialStorageClass; adapter: string; opaqueId: string } | undefined {
  const match = /^credential:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match || !["nas-vault", "root-env", "device-vault", "provider-session", "codex-login"].includes(match[1])) return undefined;
  return { storageClass: match[1] as CredentialStorageClass, adapter: match[2], opaqueId: match[3] };
}

export function credentialHandleUri(handle: CredentialHandle): string {
  if (!handle.storageClass || !handle.adapter || !handle.id) throw new Error("credential handle identity is incomplete");
  return `credential://${handle.storageClass}/${handle.adapter}/${handle.id}`;
}

export function parseCredentialHandleUri(value: string): { storageClass: CredentialStorageClass; adapter: string; opaqueId: string } {
  const parsed = parseHandleUri(value);
  if (!parsed) throw new Error("credential handle URI is invalid");
  return parsed;
}

export class CredentialBroker {
  private readonly handles = new Map<string, CredentialHandle>();
  private readonly leases = new Map<string, CredentialLease>();
  private readonly resolver: CredentialResolver;
  private readonly clock: () => number;

  constructor(resolver: CredentialResolver, clock: () => number = Date.now) { this.resolver = resolver; this.clock = clock; }

  register(input: Omit<CredentialHandle, "id"> & { id?: string }): CredentialView {
    if (!input.alias || !input.adapter || !input.purpose || !input.scopes.every((scope) => typeof scope === "string")) throw new Error("credential handle metadata is invalid");
    const handle = { ...input, id: input.id ?? uuidv7(this.clock()) };
    this.handles.set(handle.id, handle);
    return this.view(handle);
  }

  view(handle: CredentialHandle): CredentialView { return { id: handle.id, alias: handle.alias, storageClass: handle.storageClass, adapter: handle.adapter, purpose: handle.purpose, scopes: [...handle.scopes], health: handle.health, expiresAt: handle.expiresAt }; }

  lease(handleId: string, request: { purpose: string; adapter: string; workerId?: string | null; ttlMs?: number; now?: number }): CredentialLease {
    const handle = this.handles.get(handleId);
    const now = request.now ?? this.clock();
    const ttlMs = request.ttlMs ?? 60_000;
    if (!handle || handle.purpose !== request.purpose || handle.adapter !== request.adapter || handle.health !== "HEALTHY" || (handle.expiresAt !== null && handle.expiresAt <= now) || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new Error("credential lease denied");
    const resolved = this.resolver(handle);
    if (!resolved.available) throw new Error(`credential unavailable: ${resolved.reason}`);
    const leaseId = uuidv7(now);
    let released = false;
    const lease: CredentialLease = { id: leaseId, handleId, workerId: request.workerId ?? null, expiresAt: now + ttlMs, release: () => { if (!released) { released = true; this.leases.delete(leaseId); } } };
    this.leases.set(leaseId, lease);
    return lease;
  }

  withLeaseSecret<T>(leaseId: string, callback: (secret: string) => T, now = this.clock()): T {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.expiresAt <= now) throw new Error("credential lease expired");
    const handle = this.handles.get(lease.handleId);
    if (!handle || handle.health !== "HEALTHY") throw new Error("credential handle unavailable");
    const resolved = this.resolver(handle);
    if (!resolved.available) throw new Error("credential handle unavailable");
    return resolved.withSecret(callback);
  }

  expire(now = this.clock()): number {
    let expired = 0;
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) { this.leases.delete(id); expired += 1; }
    return expired;
  }

  revoke(handleId: string): boolean {
    const handle = this.handles.get(handleId);
    if (!handle) return false;
    handle.health = "REVOKED";
    for (const [id, lease] of this.leases) if (lease.handleId === handleId) this.leases.delete(id);
    return true;
  }

  safeErrorDigest(input: unknown): string { return sha256(JSON.stringify(input)); }
}
