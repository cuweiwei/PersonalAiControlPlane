import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { IdentityDatabase } from "./db.ts";
import { IdentityService, type IssuedSession } from "./service.ts";

export class IdentityAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "IdentityAuthError";
    this.code = code;
    this.status = status;
  }
}

export type PasskeyAdapterOptions = {
  db: IdentityDatabase;
  identity: IdentityService;
  rpName: string;
  rpId: string;
  expectedOrigin: string;
  bootstrapToken?: string;
};

export type PasskeySessionResult = {
  userId: string;
  session: IssuedSession;
};

function decodeBase64Url(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new IdentityAuthError("INVALID_WEBAUTHN_RESPONSE", "WebAuthn response encoding is invalid", 400);
  try { return Buffer.from(value, "base64url"); } catch { throw new IdentityAuthError("INVALID_WEBAUTHN_RESPONSE", "WebAuthn response encoding is invalid", 400); }
}

function clientDataChallenge(clientDataJson: string, expectedType: "webauthn.create" | "webauthn.get"): string {
  let clientData: { type?: unknown; challenge?: unknown };
  try { clientData = JSON.parse(decodeBase64Url(clientDataJson).toString("utf8")) as typeof clientData; } catch { throw new IdentityAuthError("INVALID_WEBAUTHN_RESPONSE", "WebAuthn client data is invalid", 400); }
  if (clientData.type !== expectedType || typeof clientData.challenge !== "string" || clientData.challenge.length < 16) throw new IdentityAuthError("INVALID_WEBAUTHN_RESPONSE", "WebAuthn client data is invalid", 400);
  return clientData.challenge;
}

function requiredText(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new IdentityAuthError("INVALID_INPUT", `${field} is invalid`, 400);
  return value.trim();
}

function safeSecretEqual(input: string, expected: string): boolean {
  const left = Buffer.from(input, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function registrationFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/credential ID was not base64url-encoded/i.test(message)) return "CREDENTIAL_ID_ENCODING";
  if (/unexpected registration response origin/i.test(message)) return "ORIGIN_MISMATCH";
  if (/unexpected registration response challenge|custom challenge verifier returned false/i.test(message)) return "CHALLENGE_MISMATCH";
  if (/rp id|rpId|relying party/i.test(message)) return "RP_ID_MISMATCH";
  if (/user verification was required/i.test(message)) return "USER_VERIFICATION_REQUIRED";
  if (/user presence was required/i.test(message)) return "USER_PRESENCE_REQUIRED";
  if (/no public key|missing numeric alg|unexpected public key alg/i.test(message)) return "PUBLIC_KEY_INVALID";
  if (/no aaguid/i.test(message)) return "AAGUID_MISSING";
  if (/attestation|unsupported attestation|none attestation/i.test(message)) return "ATTESTATION_INVALID";
  if (/client data|credential type|missing credential ID/i.test(message)) return "CLIENT_DATA_INVALID";
  return "VERIFICATION_REJECTED";
}

export class PasskeyRpAdapter {
  private readonly db: IdentityDatabase;
  private readonly identity: IdentityService;
  private readonly rpName: string;
  private readonly rpId: string;
  private readonly expectedOrigin: string;
  private readonly bootstrapToken: string | undefined;

  constructor(options: PasskeyAdapterOptions) {
    this.db = options.db;
    this.identity = options.identity;
    this.rpName = requiredText(options.rpName, "rpName");
    this.rpId = requiredText(options.rpId, "rpId");
    this.expectedOrigin = requiredText(options.expectedOrigin, "expectedOrigin");
    this.bootstrapToken = options.bootstrapToken?.trim() || undefined;
  }

  private hasIncompleteBootstrapUser(): boolean {
    const activeUsers = this.db.all<{ id: string; profile_user_id: string | null; credential_count: number }>(`
      SELECT u.id, p.user_id AS profile_user_id, COUNT(c.id) AS credential_count
      FROM identity_users u
      LEFT JOIN identity_profiles p ON p.user_id = u.id
      LEFT JOIN passkey_credentials c ON c.user_id = u.id AND c.revoked_at IS NULL
      WHERE u.disabled_at IS NULL
      GROUP BY u.id, p.user_id
    `);
    return activeUsers.length === 1 && activeUsers[0].profile_user_id === null && Number(activeUsers[0].credential_count) === 0;
  }

  private abandonIncompleteBootstrapUser(): boolean {
    if (!this.hasIncompleteBootstrapUser()) return false;
    const user = this.db.one<{ id: string }>(`
      SELECT u.id
      FROM identity_users u
      LEFT JOIN identity_profiles p ON p.user_id = u.id
      LEFT JOIN passkey_credentials c ON c.user_id = u.id AND c.revoked_at IS NULL
      WHERE u.disabled_at IS NULL AND p.user_id IS NULL
      GROUP BY u.id
      HAVING COUNT(c.id) = 0
    `);
    if (!user) return false;
    this.identity.abandonUser(user.id);
    return true;
  }

  status(): { configured: true; registrationAllowed: boolean; userCount: number; rpId: string; origin: string; bootstrapConfigured: boolean } {
    const userCount = this.identity.userCount();
    return { configured: true, registrationAllowed: this.bootstrapToken !== undefined && (userCount === 0 || this.hasIncompleteBootstrapUser()), userCount, rpId: this.rpId, origin: this.expectedOrigin, bootstrapConfigured: this.bootstrapToken !== undefined };
  }

  async registrationOptions(input: { bootstrapToken: unknown; login: unknown; displayName: unknown }) {
    if (this.identity.userCount() > 0 && !this.abandonIncompleteBootstrapUser()) throw new IdentityAuthError("BOOTSTRAP_COMPLETE", "The owner Passkey is already configured", 409);
    if (!this.bootstrapToken) throw new IdentityAuthError("BOOTSTRAP_NOT_CONFIGURED", "The production bootstrap token has not been configured", 503);
    const bootstrapToken = requiredText(input.bootstrapToken, "bootstrapToken", 512);
    if (!safeSecretEqual(bootstrapToken, this.bootstrapToken)) throw new IdentityAuthError("INVALID_BOOTSTRAP_TOKEN", "Bootstrap token is invalid", 403);
    const login = requiredText(input.login, "login");
    const displayName = requiredText(input.displayName, "displayName");
    const userId = this.identity.createUser();
    const issued = this.identity.issueChallenge("registration", userId, 120_000);
    try {
      const options = await generateRegistrationOptions({
        rpName: this.rpName,
        rpID: this.rpId,
        userID: Buffer.from(userId, "utf8"),
        userName: login,
        userDisplayName: displayName,
        challenge: issued.challenge,
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      });
      this.db.run("INSERT INTO registration_intents(id, user_id, challenge_id, login, display_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", issued.id, userId, issued.id, login, displayName, issued.expiresAt, Date.now());
      return { options, challengeId: issued.id, userId };
    } catch (error) {
      this.identity.abandonUser(userId);
      throw error;
    }
  }

  async finishRegistration(input: { challengeId: unknown; userId: unknown; response: unknown }): Promise<PasskeySessionResult & { recoveryCodes: string[] }> {
    const challengeId = requiredText(input.challengeId, "challengeId");
    const userId = requiredText(input.userId, "userId");
    const intent = this.db.one<{ user_id: string; login: string; display_name: string; expires_at: number; consumed_at: number | null }>("SELECT user_id, login, display_name, expires_at, consumed_at FROM registration_intents WHERE id = ? AND challenge_id = ?", challengeId, challengeId);
    if (!intent || intent.user_id !== userId || intent.consumed_at !== null || intent.expires_at <= Date.now()) throw new IdentityAuthError("CHALLENGE_EXPIRED", "Registration challenge expired", 400);
    const response = input.response as RegistrationResponseJSON;
    const expectedChallenge = async (challenge: string) => this.identity.consumeChallenge(challengeId, challenge);
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: this.expectedOrigin, expectedRPID: this.rpId, requireUserVerification: true });
    } catch (error) {
      this.identity.abandonUser(userId);
      throw new IdentityAuthError("PASSKEY_REGISTRATION_FAILED", `Passkey verification failed (${registrationFailureCode(error)})`, 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      this.identity.abandonUser(userId);
      throw new IdentityAuthError("PASSKEY_REGISTRATION_FAILED", "Passkey verification failed (ATTESTATION_REJECTED)", 400);
    }
    const credential = verification.registrationInfo.credential;
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(9).toString("base64url"));
    this.db.transaction(() => {
      this.db.run("INSERT INTO identity_profiles(user_id, login, display_name, created_at) VALUES (?, ?, ?, ?)", userId, intent.login, intent.display_name, Date.now());
      this.identity.registerCredential(userId, credential.id, Buffer.from(credential.publicKey).toString("base64url"), credential.counter, credential.transports ?? []);
      for (const code of recoveryCodes) this.identity.issueRecoveryCode(userId, code);
      this.db.run("UPDATE registration_intents SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", Date.now(), challengeId);
    });
    return { userId, recoveryCodes, session: this.identity.issueSession(userId) };
  }

  async authenticationOptions(loginInput?: unknown) {
    const login = requiredText(loginInput ?? "owner@local", "login");
    const profile = this.db.one<{ user_id: string }>("SELECT user_id FROM identity_profiles WHERE login = ?", login);
    const credentials = profile ? this.identity.activeCredentials(profile.user_id) : [];
    if (credentials.length === 0) throw new IdentityAuthError("AUTHENTICATION_FAILED", "Account or Passkey was not accepted", 401);
    const issued = this.identity.issueChallenge("authentication", profile?.user_id ?? null, 120_000);
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      challenge: issued.challenge,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ id: credential.credentialId, transports: credential.transports as never })),
    });
    return { options, challengeId: issued.id };
  }

  async finishAuthentication(input: { challengeId: unknown; response: unknown }): Promise<PasskeySessionResult> {
    const challengeId = requiredText(input.challengeId, "challengeId");
    const response = input.response as AuthenticationResponseJSON;
    if (!response || typeof response.id !== "string" || !response.response?.clientDataJSON) throw new IdentityAuthError("INVALID_WEBAUTHN_RESPONSE", "WebAuthn response is invalid", 400);
    const challenge = clientDataChallenge(response.response.clientDataJSON, "webauthn.get");
    const assertion = { credentialId: response.id, clientDataJson: response.response.clientDataJSON, authenticatorData: response.response.authenticatorData, signature: response.response.signature };
    const issued = await this.identity.authenticateWithPasskeyAsync(challengeId, challenge, assertion, async ({ assertion: current, credentialId, publicKeyCose, signCount }) => {
      try {
        const credential = { id: credentialId, publicKey: decodeBase64Url(publicKeyCose), counter: signCount, transports: this.identity.activeCredentials().find((item) => item.credentialId === credentialId)?.transports as never };
        const verification = await verifyAuthenticationResponse({ response: current as AuthenticationResponseJSON, expectedChallenge: challenge, expectedOrigin: this.expectedOrigin, expectedRPID: this.rpId, credential, requireUserVerification: true });
        return { valid: verification.verified, signCount: verification.authenticationInfo?.newCounter };
      } catch {
        return { valid: false };
      }
    });
    if (!issued) throw new IdentityAuthError("AUTHENTICATION_FAILED", "Account or Passkey was not accepted", 401);
    return { userId: issued.view.userId, session: issued };
  }
}
