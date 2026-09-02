import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256, type JsonValue } from "../../contracts/src/index.ts";

export type CapabilityDescriptor = { capability: string; runtime?: string; runtimeVersion?: string; status: "READY" | "DEGRADED" | "UNAVAILABLE"; maxConcurrency?: number; properties?: Record<string, JsonValue> };
export type ModelDescriptor = { runtime: string; id: string; displayName?: string; status: "ready" | "loading" | "unavailable"; contextLength?: number; metadata?: Record<string, JsonValue> };

export function descriptorHash(descriptor: Omit<CapabilityDescriptor, "status"> & { status: CapabilityDescriptor["status"] }): string { return sha256(canonicalJson(descriptor)); }
export function resolvePathWithinRoots(candidatePath: string, roots: readonly string[]): string | undefined {
  if (!isAbsolute(candidatePath) || roots.length === 0) return undefined;
  const canonical = (input: string): string => { const suffix: string[] = []; let current = resolve(input); while (true) { try { const existing = realpathSync(current); return suffix.reverse().reduce((path, segment) => join(path, segment), existing); } catch { const parent = dirname(current); if (parent === current) return resolve(input); suffix.push(basename(current)); current = parent; } } };
  const candidate = canonical(candidatePath);
  return roots.filter(isAbsolute).map(canonical).find((root) => { const child = relative(root, candidate); return child === "" || (!child.startsWith("..") && !isAbsolute(child)); }) ? candidate : undefined;
}

export type ShellProfile = { allowedExecutables: readonly string[]; allowedEnvironment?: readonly string[]; roots: readonly string[]; maxRuntimeMs: number; maxOutputBytes: number; network: "none" | "approved" };
export function validateShellInvocation(profile: ShellProfile, executable: string, args: readonly string[], cwd: string, environment: Record<string, string>): { valid: true } | { valid: false; reason: string } {
  if (!profile.allowedExecutables.includes(executable)) return { valid: false, reason: "executable-not-allowed" };
  if (["sudo", "su", "doas", "docker", "nsenter", "mount", "umount", "chroot"].includes(basename(executable).toLowerCase())) return { valid: false, reason: "privileged-command-not-allowed" };
  if (args.some((arg) => /[;&|`$<>\n\r]/.test(arg))) return { valid: false, reason: "shell-metacharacter-rejected" };
  if (!resolvePathWithinRoots(cwd, profile.roots)) return { valid: false, reason: "working-root-outside-profile" };
  if (Object.keys(environment).some((key) => !(profile.allowedEnvironment ?? []).includes(key))) return { valid: false, reason: "environment-key-not-allowed" };
  if (!Number.isInteger(profile.maxRuntimeMs) || profile.maxRuntimeMs < 1 || !Number.isInteger(profile.maxOutputBytes) || profile.maxOutputBytes < 1) return { valid: false, reason: "profile-limits-invalid" };
  return { valid: true };
}
