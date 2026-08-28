import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
import { IdentityDatabase } from "./db.ts";

export const SESSION_COOKIE_POLICY = Object.freeze({
  name: "pai_session",
  httpOnly: true,
  secure: true,
  sameSite: "Strict" as const,
  path: "/",
  hostOnly: true,
});

export type ChallengeKind = "registration" | "authentication" | "step_up" | "recovery";

export type IssuedChallenge = {
  id: string;
  challenge: string;
  kind: ChallengeKind;
  userId: string | null;
  expiresAt: number;
};

export type SessionView = {
  id: string;
  userId: string;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
};

export type IssuedSession = {
  sessionId: string;
  csrfToken: string;
  cookie: string;
  view: SessionView;
};

export type PasskeyAssertion = {
  credentialId: string;
  clientDataJson: string;
  authenticatorData: string;
  signature: string;
};

export type PasskeyVerifier = (input: {
  assertion: PasskeyAssertion;
  challenge: string;
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
}) => { valid: boolean; signCount?: number };

export type ForwardAuthIdentity = {
  ownerId: string;
  sessionId: string;
  authTime: number;
  requestId: string;
};

function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function cookieHeader(rawSessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_POLICY.name}=${rawSessionId}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export class IdentityService {
  private readonly db: IdentityDatabase;
  private readonly clock: () => number;

  constructor(db: IdentityDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  createUser(userId = uuidv7(this.clock())): string {
    const now = this.clock();
    this.db.run("INSERT INTO identity_users(id, created_at) VALUES (?, ?)", userId, now);
    return userId;
  }

  issueChallenge(kind: ChallengeKind, userId: string | null, ttlMs = 120_000, sessionId: string | null = null): IssuedChallenge {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new Error("challenge TTL must be between 1ms and 5 minutes");
    if (userId && !this.db.one("SELECT id FROM identity_users WHERE id = ? AND disabled_at IS NULL", userId)) throw new Error("identity user is unavailable");
    if (sessionId && !this.db.one("SELECT id FROM sessions WHERE id = ? AND revoked_at IS NULL", sessionId)) throw new Error("session is unavailable");
    const id = uuidv7(this.clock());
    const challenge = randomSecret();
    const now = this.clock();
    const expiresAt = now + ttlMs;
    this.db.run(
      "INSERT INTO auth_challenges(id, kind, user_id, session_id, challenge_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      kind,
      userId,
      sessionId,
      sha256(challenge),
      expiresAt,
      now,
    );
    return { id, challenge, kind, userId, expiresAt };
  }

  consumeChallenge(id: string, challenge: string, now = this.clock()): boolean {
    const row = this.db.one<{ challenge_hash: string; expires_at: number; consumed_at: number | null }>("SELECT challenge_hash, expires_at, consumed_at FROM auth_challenges WHERE id = ?", id);
    if (!row || row.consumed_at !== null || row.expires_at <= now || !safeEqualText(row.challenge_hash, sha256(challenge))) return false;
    const result = this.db.connection.prepare("UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND challenge_hash = ?").run(now, id, now, row.challenge_hash);
    return Number(result.changes) === 1;
  }

  registerCredential(userId: string, credentialId: string, publicKeyCose: string, signCount = 0, transports: string[] = []): string {
    if (!this.db.one("SELECT id FROM identity_users WHERE id = ? AND disabled_at IS NULL", userId)) throw new Error("identity user is unavailable");
    if (!credentialId || !publicKeyCose || !Number.isInteger(signCount) || signCount < 0) throw new Error("credential data is invalid");
    const id = uuidv7(this.clock());
    this.db.run(
      "INSERT INTO passkey_credentials(id, user_id, credential_id, public_key_cose, sign_count, transports_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      userId,
      credentialId,
      publicKeyCose,
      signCount,
      JSON.stringify(transports),
      this.clock(),
    );
    return id;
  }

  authenticateWithPasskey(
    challengeId: string,
    challenge: string,
    assertion: PasskeyAssertion,
    verifier: PasskeyVerifier,
    ttlMs = 8 * 60 * 60 * 1000,
  ): IssuedSession | undefined {
    const challengeRow = this.db.one<{ user_id: string | null; expires_at: number }>("SELECT user_id, expires_at FROM auth_challenges WHERE id = ? AND kind = 'authentication'", challengeId);
    if (!challengeRow?.user_id || !this.consumeChallenge(challengeId, challenge)) return undefined;
    const credential = this.db.one<{ user_id: string; credential_id: string; public_key_cose: string; sign_count: number; revoked_at: number | null }>(
      "SELECT user_id, credential_id, public_key_cose, sign_count, revoked_at FROM passkey_credentials WHERE credential_id = ?",
      assertion.credentialId,
    );
    if (!credential || credential.user_id !== challengeRow.user_id || credential.revoked_at !== null) return undefined;
    let result: { valid: boolean; signCount?: number };
    try {
      result = verifier({ assertion, challenge, credentialId: credential.credential_id, publicKeyCose: credential.public_key_cose, signCount: credential.sign_count });
    } catch {
      return undefined;
    }
    if (!result.valid || result.signCount !== undefined && result.signCount < credential.sign_count) return undefined;
    this.db.run("UPDATE passkey_credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?", result.signCount ?? credential.sign_count, this.clock(), credential.credential_id);
    return this.issueSession(challengeRow.user_id, this.clock(), ttlMs);
  }

  issueSession(userId: string, authTime = this.clock(), ttlMs = 8 * 60 * 60 * 1000, rotatedFrom: string | null = null): IssuedSession {
    if (!this.db.one("SELECT id FROM identity_users WHERE id = ? AND disabled_at IS NULL", userId)) throw new Error("identity user is unavailable");
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) throw new Error("session TTL is out of bounds");
    const rawSessionId = randomSecret();
    const csrfToken = randomSecret();
    const id = uuidv7(this.clock());
    const issuedAt = this.clock();
    const expiresAt = issuedAt + ttlMs;
    this.db.run(
      "INSERT INTO sessions(id, user_id, session_hash, csrf_hash, auth_time, issued_at, expires_at, last_seen_at, rotated_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      userId,
      sha256(rawSessionId),
      sha256(csrfToken),
      authTime,
      issuedAt,
      expiresAt,
      issuedAt,
      rotatedFrom,
    );
    return { sessionId: rawSessionId, csrfToken, cookie: cookieHeader(rawSessionId, Math.floor(ttlMs / 1000)), view: { id, userId, authTime, issuedAt, expiresAt } };
  }

  verifySession(rawSessionId: string, now = this.clock()): SessionView | undefined {
    const row = this.db.one<{ id: string; user_id: string; auth_time: number; issued_at: number; expires_at: number; revoked_at: number | null }>(
      "SELECT id, user_id, auth_time, issued_at, expires_at, revoked_at FROM sessions WHERE session_hash = ?",
      sha256(rawSessionId),
    );
    if (!row || row.revoked_at !== null || row.expires_at <= now) return undefined;
    this.db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL", now, row.id);
    return { id: row.id, userId: row.user_id, authTime: row.auth_time, issuedAt: row.issued_at, expiresAt: row.expires_at };
  }

  rotateSession(rawSessionId: string, authTime: number, ttlMs = 8 * 60 * 60 * 1000): IssuedSession | undefined {
    const current = this.verifySession(rawSessionId);
    if (!current) return undefined;
    const issued = this.issueSession(current.userId, authTime, ttlMs, current.id);
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", this.clock(), current.id);
    return issued;
  }

  revokeSession(rawSessionId: string): boolean {
    const row = this.db.one<{ id: string }>("SELECT id FROM sessions WHERE session_hash = ? AND revoked_at IS NULL", sha256(rawSessionId));
    if (!row) return false;
    this.db.run("UPDATE sessions SET revoked_at = ? WHERE id = ?", this.clock(), row.id);
    return true;
  }

  revokeAllSessions(userId: string): number {
    const result = this.db.connection.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(this.clock(), userId);
    return Number(result.changes);
  }

  verifyCsrf(rawSessionId: string, csrfToken: string, now = this.clock()): boolean {
    const session = this.verifySession(rawSessionId, now);
    if (!session) return false;
    const row = this.db.one<{ csrf_hash: string }>("SELECT csrf_hash FROM sessions WHERE id = ? AND revoked_at IS NULL", session.id);
    return Boolean(row && safeEqualText(row.csrf_hash, sha256(csrfToken)));
  }

  hasFreshStepUp(session: SessionView, maxAgeMs: number, now = this.clock()): boolean {
    return Number.isInteger(maxAgeMs) && maxAgeMs >= 0 && session.authTime <= now && now - session.authTime <= maxAgeMs;
  }

  issueRecoveryCode(userId: string, code: string): string {
    if (!this.db.one("SELECT id FROM identity_users WHERE id = ? AND disabled_at IS NULL", userId)) throw new Error("identity user is unavailable");
    if (code.length < 12 || code.length > 256) throw new Error("recovery code length is invalid");
    const id = uuidv7(this.clock());
    this.db.run("INSERT INTO recovery_codes(id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)", id, userId, sha256(code), this.clock());
    return id;
  }

  consumeRecoveryCode(userId: string, code: string): boolean {
    const codeHash = sha256(code);
    return this.db.transaction(() => {
      const result = this.db.connection.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND code_hash = ?").run(this.clock(), userId, codeHash);
      if (Number(result.changes) !== 1) return false;
      this.revokeAllSessions(userId);
      return true;
    });
  }

  consumeGrantJti(jti: string, audience: string, expSeconds: number, nowSeconds = Math.floor(this.clock() / 1000)): boolean {
    if (!jti || !audience || !Number.isInteger(expSeconds) || expSeconds <= nowSeconds) return false;
    try {
      this.db.run("INSERT INTO grant_nonces(jti, audience, expires_at, consumed_at) VALUES (?, ?, ?, ?)", jti, audience, expSeconds, nowSeconds);
      return true;
    } catch {
      return false;
    }
  }

  buildForwardAuthHeaders(identity: ForwardAuthIdentity): Record<string, string> {
    if (!identity.ownerId || !identity.sessionId || !identity.requestId || !Number.isFinite(identity.authTime)) throw new Error("forward-auth identity is incomplete");
    return {
      "x-pai-verified": "1",
      "x-pai-owner-id": identity.ownerId,
      "x-pai-session-id": identity.sessionId,
      "x-pai-auth-time": String(identity.authTime),
      "x-pai-request-id": identity.requestId,
    };
  }

  stripIncomingIdentityHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
    const clean = { ...headers };
    for (const key of ["x-pai-verified", "x-pai-owner-id", "x-pai-session-id", "x-pai-auth-time", "x-pai-request-id"]) delete clean[key];
    return clean;
  }

  isVerifiedForwardAuth(headers: Record<string, string | string[] | undefined>): boolean {
    return headers["x-pai-verified"] === "1" && typeof headers["x-pai-owner-id"] === "string" && typeof headers["x-pai-session-id"] === "string" && typeof headers["x-pai-auth-time"] === "string";
  }
}
