import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { IdentityDatabase } from "./db.ts";
import { IdentityService } from "./service.ts";
import { IdentityAuthError, PasskeyRpAdapter } from "./webauthn.ts";
import { parseActionGrantIssueInput, WorkloadActionGrantService } from "./grants.ts";

type IdentityHttpOptions = {
  db: IdentityDatabase;
  identity: IdentityService;
  passkeyConfigured: boolean;
  passkeyAdapterReady?: boolean;
  passkeyAdapter?: PasskeyRpAdapter;
  canonicalOrigin?: string;
  actionGrantService?: WorkloadActionGrantService;
  actionGrantRequired?: boolean;
};

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function errorBody(error: unknown): { error: { code: string; message: string; retryable: boolean } } {
  if (error instanceof IdentityAuthError) return { error: { code: error.code, message: error.message, retryable: error.status >= 500 } };
  if (error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message)) return { error: { code: error.message, message: "Workload authorization request failed", retryable: ["SIGNING_KEY_UNAVAILABLE"].includes(error.message) } };
  return { error: { code: "INTERNAL_ERROR", message: "Identity request failed", retryable: true } };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const length = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > 256 * 1024) throw new IdentityAuthError("REQUEST_TOO_LARGE", "Request body is too large", 413);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 256 * 1024) throw new IdentityAuthError("REQUEST_TOO_LARGE", "Request body is too large", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new IdentityAuthError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
}

function sessionId(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie ?? "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("pai_session="));
  return match?.slice("pai_session=".length) || undefined;
}

function csrfToken(request: IncomingMessage): string | undefined {
  const value = request.headers["x-pai-csrf-token"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireOrigin(request: IncomingMessage, canonicalOrigin?: string): void {
  if (canonicalOrigin && request.headers.origin !== canonicalOrigin) throw new IdentityAuthError("ORIGIN_REJECTED", "Request origin is not allowed", 403);
}

function html(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  response.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal AI Control Plane · Passkey</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101316;color:#f4f5f7}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,#243347 0,#101316 45%)}main{width:min(92vw,560px);padding:34px;border:1px solid #34404d;border-radius:22px;background:#171c22;box-shadow:0 24px 80px #0008}h1{font-size:1.65rem;margin:.25rem 0 .6rem}p{color:#b6c1cc;line-height:1.5}.eyebrow{letter-spacing:.16em;font-size:.72rem;color:#7dc4ff;font-weight:700}label{display:block;margin:16px 0 6px;color:#d7e0e8}input{box-sizing:border-box;width:100%;padding:12px 13px;border:1px solid #465461;border-radius:9px;background:#0f1317;color:#fff;font-size:1rem}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:9px;background:#5fb4ff;color:#07111b;font-weight:750;cursor:pointer}button:disabled{opacity:.5;cursor:wait}.card{margin-top:22px;padding-top:8px;border-top:1px solid #34404d}.notice{padding:12px 14px;border-radius:9px;background:#202a34;color:#c7d7e6;margin:14px 0}.error{background:#3b2024;color:#ffbec4}.success{background:#1c392c;color:#bdf2c9}code{word-break:break-all;white-space:pre-wrap}.hidden{display:none}</style></head><body><main><div class="eyebrow">PERSONAL AI CONTROL PLANE</div><h1>Owner Passkey</h1><p id="intro">正在讀取 Identity Gateway 狀態…</p><div id="message" class="notice hidden"></div><section id="setup" class="card hidden"><h2>第一次註冊</h2><p>只允許第一位 owner 建立 Passkey。Bootstrap token 只會送到此 gateway，不會寫入瀏覽器儲存。</p><form id="register"><label for="login">Owner login</label><input id="login" value="owner@local" autocomplete="username" required><label for="displayName">Display name</label><input id="displayName" value="Owner" autocomplete="name" required><label for="bootstrapToken">One-time bootstrap token</label><input id="bootstrapToken" type="password" autocomplete="one-time-code" required><button id="registerButton">Register Passkey</button></form></section><section id="loginSection" class="card hidden"><h2>登入</h2><p>輸入 owner login，接著使用此裝置的 Touch ID、Windows Hello 或安全金鑰。</p><form id="loginForm"><label for="loginExisting">Owner login</label><input id="loginExisting" value="owner@local" autocomplete="username webauthn" required><button id="loginButton">Continue with Passkey</button></form></section><div id="recovery" class="notice hidden"><strong>Recovery codes（只顯示一次）</strong><p>請離線保存以下 codes，之後無法由 gateway 取回：</p><code id="codes"></code></div></main><script>
  const $ = (id) => document.getElementById(id); const message = (text, kind='') => { const el=$('message'); el.textContent=text; el.className='notice '+kind; el.classList.remove('hidden'); };
  const b64 = (value) => { const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength); let out=''; for (const byte of bytes) out += String.fromCharCode(byte); return btoa(out).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); };
  const bytes = (value) => { if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value; if (typeof value !== 'string' || value.length === 0) throw new Error('WebAuthn options are invalid'); const normalized=value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='); const binary=atob(normalized); const output=new Uint8Array(binary.length); for (let index=0; index<binary.length; index += 1) output[index]=binary.charCodeAt(index); return output; };
  const creationOptions = (options) => ({ ...options, challenge: bytes(options.challenge), user: { ...options.user, id: bytes(options.user.id) }, excludeCredentials: options.excludeCredentials?.map((credential) => ({ ...credential, id: bytes(credential.id) })) });
  const requestOptions = (options) => ({ ...options, challenge: bytes(options.challenge), allowCredentials: options.allowCredentials?.map((credential) => ({ ...credential, id: bytes(credential.id) })) });
  const registrationJSON = (credential) => { const rawId = b64(credential.rawId); return { id: rawId, rawId, type: credential.type, response: { clientDataJSON: b64(credential.response.clientDataJSON), attestationObject: b64(credential.response.attestationObject), transports: credential.response.getTransports ? credential.response.getTransports() : undefined }, clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {} }; };
  const authenticationJSON = (credential) => { const rawId = b64(credential.rawId); return { id: rawId, rawId, type: credential.type, response: { clientDataJSON: b64(credential.response.clientDataJSON), authenticatorData: b64(credential.response.authenticatorData), signature: b64(credential.response.signature), userHandle: credential.response.userHandle ? b64(credential.response.userHandle) : null }, clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {} }; };
  async function api(path, init={}) { const response = await fetch(path, { ...init, credentials:'same-origin', headers:{ accept:'application/json', ...(init.body ? {'content-type':'application/json'} : {}), ...(init.headers || {}) } }); const body = await response.json().catch(()=>({})); if (!response.ok) throw new Error(body.error?.message || 'Request failed ('+response.status+')'); return body; }
  async function load() { const session = await fetch('/api/v1/auth/me', { credentials:'same-origin', headers:{ accept:'application/json' } }); if (session.ok) { location.replace('/home'); return; } const status = await api('/api/v1/auth/status'); if (status.origin !== location.origin) { $('intro').textContent = '目前網址 '+location.origin+' 與設定的 WebAuthn origin '+status.origin+' 不一致；請先讓 root-owned canonical origin 與此 Identity route 對齊。'; return; } $('intro').textContent = status.registrationAllowed ? (status.userCount ? 'Owner 註冊尚未完成，請使用 bootstrap token 重試。' : '尚未註冊 owner，請使用 bootstrap token 建立第一把 Passkey。') : status.userCount ? 'Identity Gateway 已有 owner Passkey。' : '尚未註冊 owner；需要 root-owned bootstrap token 才能開始。'; if (status.registrationAllowed) $('setup').classList.remove('hidden'); if (status.userCount && !status.registrationAllowed) $('loginSection').classList.remove('hidden'); }
  $('register').addEventListener('submit', async (event) => { event.preventDefault(); const button=$('registerButton'); button.disabled=true; try { const start=await api('/api/v1/auth/register/options',{method:'POST',body:JSON.stringify({login:$('login').value,displayName:$('displayName').value,bootstrapToken:$('bootstrapToken').value})}); const credential=await navigator.credentials.create({publicKey:creationOptions(start.options)}); if (!credential) throw new Error('瀏覽器未建立 Passkey'); const finish=await api('/api/v1/auth/register/finish',{method:'POST',body:JSON.stringify({challengeId:start.challengeId,userId:start.userId,response:registrationJSON(credential)})}); $('setup').classList.add('hidden'); $('loginSection').classList.remove('hidden'); $('recovery').classList.remove('hidden'); $('codes').textContent=finish.recoveryCodes.join('\\n'); message('Passkey 註冊完成，請先離線保存 recovery codes。','success'); } catch (error) { message(error.message,'error'); } finally { button.disabled=false; } });
  $('loginForm').addEventListener('submit', async (event) => { event.preventDefault(); const button=$('loginButton'); button.disabled=true; try { const start=await api('/api/v1/auth/login/options',{method:'POST',body:JSON.stringify({login:$('loginExisting').value})}); const credential=await navigator.credentials.get({publicKey:requestOptions(start.options)}); if (!credential) throw new Error('瀏覽器未完成 Passkey 驗證'); await api('/api/v1/auth/login/finish',{method:'POST',body:JSON.stringify({challengeId:start.challengeId,response:authenticationJSON(credential)})}); message('Passkey 登入成功，正在開啟 Personal AI Portal。','success'); location.replace('/home'); } catch (error) { message(error.message,'error'); } finally { button.disabled=false; } });
  load().catch((error)=>message(error.message,'error'));
</script></body></html>`);
}

export function createIdentityHttpServer(options: IdentityHttpOptions) {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/health/live") return json(response, 200, { status: "ok" });
      if (request.method === "GET" && path === "/health/ready") {
        const schema = options.db.one<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
        const adapterReady = options.passkeyAdapterReady === true;
        const grantReady = options.actionGrantService !== undefined;
        const ready = schema?.version === 2 && (process.env.NODE_ENV !== "production" ? true : options.passkeyConfigured && adapterReady && (!options.actionGrantRequired || grantReady));
        return json(response, ready ? 200 : 503, { status: ready ? "ok" : "not_ready", schemaVersion: schema?.version ?? null, passkey: !options.passkeyConfigured ? "disabled" : adapterReady ? "ready" : "not_wired", actionGrants: grantReady ? "ready" : options.actionGrantRequired ? "not_wired" : "not_required" });
      }
      if (request.method === "GET" && path === "/api/v1/action-grant-keys") {
        if (!options.actionGrantService) return json(response, 503, { error: { code: "SIGNING_KEY_UNAVAILABLE", message: "Action-grant signing authority is unavailable", retryable: true } });
        return json(response, 200, { keys: options.actionGrantService.verificationKeys() });
      }
      if (request.method === "POST" && path === "/api/v1/workloads/action-grants") {
        if (!options.actionGrantService) return json(response, 503, { error: { code: "SIGNING_KEY_UNAVAILABLE", message: "Action-grant signing authority is unavailable", retryable: true } });
        const body = parseActionGrantIssueInput(await readJson(request));
        const workloadId = request.headers["x-pai-workload-id"];
        const timestamp = Number(request.headers["x-pai-workload-timestamp"]);
        const nonce = request.headers["x-pai-workload-nonce"];
        const signature = request.headers["x-pai-workload-signature"];
        const key = request.headers["idempotency-key"];
        if ([workloadId, nonce, signature, key].some((value) => typeof value !== "string")) throw new Error("WORKLOAD_PROOF_INVALID");
        const issued = await options.actionGrantService.issue({ workloadId: workloadId as string, timestamp, nonce: nonce as string, signature: signature as string, idempotencyKey: key as string, method: "POST", path: "/api/v1/workloads/action-grants" }, body);
        return json(response, 201, issued, issued.replayed ? { "x-idempotent-replay": "true" } : {});
      }
      if (request.method === "GET" && path === "/" && options.passkeyAdapter) return html(response);
      if (path.startsWith("/api/v1/auth/")) {
        if (!options.passkeyConfigured) return json(response, 503, { error: { code: "PASSKEY_NOT_CONFIGURED", message: "Passkey origin/RP configuration is missing", retryable: false } });
        if (!options.passkeyAdapter) return json(response, 501, { error: { code: "NOT_IMPLEMENTED", message: "WebAuthn RP adapter is not wired", retryable: false } });
        if (request.method !== "GET") requireOrigin(request, options.canonicalOrigin);
        if (request.method === "GET" && path === "/api/v1/auth/status") return json(response, 200, options.passkeyAdapter.status());
        if (request.method === "GET" && path === "/api/v1/auth/csrf") {
          const raw = sessionId(request);
          const token = raw ? options.identity.refreshCsrf(raw) : undefined;
          if (!token) return json(response, 401, { error: { code: "AUTH_REQUIRED", message: "Authenticated Identity Gateway session required", retryable: false } });
          return json(response, 200, { csrfToken: token });
        }
        if (request.method === "GET" && path === "/api/v1/auth/forward") {
          const rawSessionId = sessionId(request);
          const view = rawSessionId ? options.identity.verifySession(rawSessionId) : undefined;
          if (!rawSessionId || !view) return json(response, 401, { error: { code: "AUTH_REQUIRED", message: "Authenticated Identity Gateway session required", retryable: false } });
          const forwardedMethod = request.headers["x-forwarded-method"];
          if (typeof forwardedMethod !== "string" || !/^[A-Z]+$/.test(forwardedMethod)) throw new IdentityAuthError("FORWARD_CONTEXT_REQUIRED", "Forward-auth requires the original request method", 400);
          if (!["GET", "HEAD", "OPTIONS"].includes(forwardedMethod)) {
            requireOrigin(request, options.canonicalOrigin);
            const csrf = csrfToken(request);
            if (!csrf || !options.identity.verifyCsrf(rawSessionId, csrf)) throw new IdentityAuthError("CSRF_REJECTED", "Session CSRF verification failed", 403);
          }
          const headers = options.identity.buildForwardAuthHeaders({ ownerId: view.userId, sessionId: view.id, authTime: view.authTime, requestId: randomUUID() });
          response.writeHead(204, { "cache-control": "no-store", ...headers });
          response.end();
          return;
        }
        if (request.method === "POST" && path === "/api/v1/auth/register/options") return json(response, 200, await options.passkeyAdapter.registrationOptions(await readJson(request)));
        if (request.method === "POST" && path === "/api/v1/auth/register/finish") {
          const result = await options.passkeyAdapter.finishRegistration(await readJson(request) as never);
          return json(response, 200, { verified: true, userId: result.userId, recoveryCodes: result.recoveryCodes, csrfToken: result.session.csrfToken }, { "set-cookie": result.session.cookie });
        }
        if (request.method === "POST" && path === "/api/v1/auth/login/options") return json(response, 200, await options.passkeyAdapter.authenticationOptions((await readJson(request)).login));
        if (request.method === "POST" && path === "/api/v1/auth/login/finish") {
          const result = await options.passkeyAdapter.finishAuthentication(await readJson(request) as never);
          return json(response, 200, { authenticated: true, userId: result.userId, csrfToken: result.session.csrfToken }, { "set-cookie": result.session.cookie });
        }
        if (request.method === "POST" && path === "/api/v1/auth/step-up/options") {
          const raw = sessionId(request); const csrf = csrfToken(request);
          if (!raw || !csrf || !options.identity.verifyCsrf(raw, csrf)) throw new IdentityAuthError("CSRF_REJECTED", "Session CSRF verification failed", 403);
          return json(response, 200, await options.passkeyAdapter.stepUpOptions(raw));
        }
        if (request.method === "POST" && path === "/api/v1/auth/step-up/finish") {
          const raw = sessionId(request); const csrf = csrfToken(request);
          if (!raw || !csrf || !options.identity.verifyCsrf(raw, csrf)) throw new IdentityAuthError("CSRF_REJECTED", "Session CSRF verification failed", 403);
          const result = await options.passkeyAdapter.finishStepUp(raw, await readJson(request) as never);
          return json(response, 200, { authenticated: true, steppedUp: true, userId: result.userId, authTime: result.session.view.authTime, csrfToken: result.session.csrfToken }, { "set-cookie": result.session.cookie });
        }
        if (request.method === "POST" && path === "/api/v1/auth/recovery") {
          const input = await readJson(request);
          const result = options.passkeyAdapter.recoverWithCode(input.login, input.recoveryCode);
          return json(response, 200, { authenticated: true, recovered: true, userId: result.userId, csrfToken: result.session.csrfToken }, { "set-cookie": result.session.cookie });
        }
        if (request.method === "GET" && path === "/api/v1/auth/me") {
          const raw = sessionId(request);
          const view = raw ? options.identity.verifySession(raw) : undefined;
          if (!view) return json(response, 401, { authenticated: false });
          const profile = options.db.one<{ login: string; display_name: string }>("SELECT login, display_name FROM identity_profiles WHERE user_id = ?", view.userId);
          return json(response, 200, { authenticated: true, user: { id: view.userId, login: profile?.login ?? null, displayName: profile?.display_name ?? null, authTime: view.authTime, expiresAt: view.expiresAt } });
        }
        if (request.method === "POST" && path === "/api/v1/auth/logout") {
          const raw = sessionId(request); const csrf = csrfToken(request);
          if (!raw || !csrf || !options.identity.verifyCsrf(raw, csrf)) throw new IdentityAuthError("CSRF_REJECTED", "Session CSRF verification failed", 403);
          const revoked = options.identity.revokeSession(raw);
          return json(response, 200, { authenticated: false, revoked }, { "set-cookie": "pai_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict" });
        }
        return json(response, 404, { error: { code: "NOT_FOUND", message: "not found", retryable: false } });
      }
      return json(response, 404, { error: { code: "NOT_FOUND", message: "not found", retryable: false } });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const status = error instanceof IdentityAuthError
        ? error.status
        : ["WORKLOAD_PROOF_INVALID", "WORKLOAD_SIGNATURE_INVALID", "WORKLOAD_IDENTITY_UNAVAILABLE"].includes(code)
          ? 401
          : ["WORKLOAD_REQUEST_REPLAY", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_RECORD_EXPIRED"].includes(code)
            ? 409
            : code === "SIGNING_KEY_UNAVAILABLE"
              ? 503
              : /^INVALID_|^UNKNOWN_/.test(code)
                ? 400
                : 500;
      if (!response.headersSent) json(response, status, errorBody(error)); else response.destroy();
    }
  });
}
