// Delivers Selah notifications to phones and browsers.
//
// The database calls this function for every new notification (see the send_push trigger).
// It looks up the person's devices and sends to each one:
//   iPhone   -> Apple Push Notification service (APNs), with an APNs auth key
//   Android  -> Firebase Cloud Messaging (FCM), with a Firebase service account
//   Web      -> the browser's push service, with VAPID keys
// Any of the three can be left unconfigured; those devices are skipped.
//
// Secrets (Supabase dashboard > Edge Functions > Secrets, or `supabase secrets set`):
//   PUSH_WEBHOOK_SECRET   must match private.push_settings.secret in the database
//   APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRODUCTION ("true" for App Store/TestFlight)
//   FCM_SERVICE_ACCOUNT   the Firebase service account JSON
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (like "mailto:you@yourchurch.org")
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

const env = (k: string) => Deno.env.get(k) ?? "";

// Reads and writes the database through its REST API with the service key (this function runs
// on Supabase's servers; the key never reaches the app).
async function rest(path: string, method = "GET") {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`database ${res.status}: ${await res.text()}`);
  return method === "GET" ? await res.json() : null;
}

type Push = { title: string; body: string; tag: string; data: Record<string, string> };
type Device = { id: number; platform: "ios" | "android" | "web"; token: string };
type Result = { id: number; platform: string; ok: boolean; gone?: boolean; error?: string };

// which notification switch in Settings covers each kind
const PREF: Record<string, string> = { like: "like", pray: "like", comment: "comment", message: "message", glass: "message" };

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function describe(type: string, text: string | null): string {
  const q = text ? `: “${clip(text, 90)}”` : "";
  switch (type) {
    case "like": return `Liked your post${q}`;
    case "pray": return `Is praying with you${q}`;
    case "prayed": return `Prayed for your request${q}`;
    case "comment": return text ? clip(`Commented: ${text}`) : "Commented on your post";
    case "message": return text ? clip(text) : "Sent you a message";
    case "glass": return "Sent you a Looking Glass";
    case "friend_request": return "Sent you a friend request";
    case "friend_accept": return "Accepted your friend request";
    default: return "New activity on Selah";
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  const secret = env("PUSH_WEBHOOK_SECRET");
  if (!secret || req.headers.get("x-push-secret") !== secret) return json({ error: "Forbidden" }, 403);

  let id: number;
  try { id = Number((await req.json()).notification_id); } catch { return json({ error: "Bad request" }, 400); }

  if (!Number.isInteger(id)) return json({ error: "Bad request" }, 400);
  const [n] = await rest(`notifications?id=eq.${id}&select=id,user_id,actor,type,post_id,body`);
  if (!n) return json({ sent: 0, reason: "notification not found" });

  const [[actor], [state], list] = await Promise.all([
    rest(`profiles?id=eq.${n.actor}&select=name`),
    rest(`user_state?user_id=eq.${n.user_id}&select=data`),
    rest(`push_tokens?user_id=eq.${n.user_id}&select=id,platform,token`),
  ]) as [{ name: string }[], { data: { notifPrefs?: Record<string, boolean> } }[], Device[]];
  const prefs = state?.data?.notifPrefs ?? {};
  if (PREF[n.type] && prefs[PREF[n.type]] === false) return json({ sent: 0, reason: "turned off in settings" });
  if (!list.length) return json({ sent: 0, reason: "no devices" });

  const push: Push = {
    title: actor?.name ?? "Selah",
    body: describe(n.type, n.body),
    // one notification per conversation or post, so a busy chat doesn't fill the screen
    tag: n.type === "message" || n.type === "glass" ? `chat-${n.actor}` : n.post_id ? `post-${n.post_id}` : `n-${n.id}`,
    data: { type: n.type, actor: n.actor, post_id: n.post_id ? String(n.post_id) : "", notification_id: String(n.id) },
  };

  const results: Result[] = await Promise.all(list.map(async (d) => {
    try {
      if (d.platform === "ios") return await sendApns(d, push);
      if (d.platform === "android") return await sendFcm(d, push);
      return await sendWeb(d, push);
    } catch (e) {
      return { id: d.id, platform: d.platform, ok: false, error: String(e) };
    }
  }));

  // forget devices that the push services say no longer exist (app deleted, logged out, etc.)
  const gone = results.filter((r) => r.gone).map((r) => r.id);
  if (gone.length) await rest(`push_tokens?id=in.(${gone.join(",")})`, "DELETE");
  const failures = results.filter((r) => !r.ok && !r.gone);
  if (failures.length) console.error("push failures", JSON.stringify(failures));
  return json({ sent: results.filter((r) => r.ok).length, removed: gone.length, results });
});

// ---------------------------------------------------------------------------
// Small crypto helpers (Web Crypto only, no extra libraries)
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}
async function signJwt(header: object, claims: object, key: CryptoKey, alg: AlgorithmIdentifier | EcdsaParams): Promise<string> {
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign(alg, key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// ---------------------------------------------------------------------------
// iPhone: Apple Push Notification service
// ---------------------------------------------------------------------------
let apnsAuth = { jwt: "", made: 0 };
async function apnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (apnsAuth.jwt && now - apnsAuth.made < 50 * 60) return apnsAuth.jwt; // Apple wants a new one at least hourly
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(env("APNS_KEY")), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jwt = await signJwt({ alg: "ES256", kid: env("APNS_KEY_ID") }, { iss: env("APNS_TEAM_ID"), iat: now }, key, { name: "ECDSA", hash: "SHA-256" });
  apnsAuth = { jwt, made: now };
  return jwt;
}
async function sendApns(d: Device, p: Push): Promise<Result> {
  if (!env("APNS_KEY")) return { id: d.id, platform: "ios", ok: false, error: "APNs not configured" };
  const host = env("APNS_HOST") || (env("APNS_PRODUCTION") === "true" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com");
  const res = await fetch(`${host}/3/device/${d.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsJwt()}`,
      "apns-topic": env("APNS_BUNDLE_ID"),
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": p.tag.slice(0, 64),
    },
    body: JSON.stringify({ aps: { alert: { title: p.title, body: p.body }, sound: "default", "thread-id": p.tag }, ...p.data }),
  });
  if (res.ok) return { id: d.id, platform: "ios", ok: true };
  const reason = (await res.json().catch(() => ({}))).reason ?? res.status;
  const gone = res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
  return { id: d.id, platform: "ios", ok: false, gone, error: String(reason) };
}

// ---------------------------------------------------------------------------
// Android: Firebase Cloud Messaging (HTTP v1 API)
// ---------------------------------------------------------------------------
let googleAuth = { token: "", until: 0 };
async function googleAccessToken(sa: { client_email: string; private_key: string; token_uri?: string }): Promise<string> {
  if (googleAuth.token && Date.now() < googleAuth.until) return googleAuth.token;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assertion = await signJwt({ alg: "RS256", typ: "JWT" }, {
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: tokenUri, iat: now, exp: now + 3600,
  }, key, { name: "RSASSA-PKCS1-v1_5" });
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${JSON.stringify(body)}`);
  googleAuth = { token: body.access_token, until: Date.now() + (body.expires_in - 120) * 1000 };
  return googleAuth.token;
}
async function sendFcm(d: Device, p: Push): Promise<Result> {
  if (!env("FCM_SERVICE_ACCOUNT")) return { id: d.id, platform: "android", ok: false, error: "Firebase not configured" };
  const sa = JSON.parse(env("FCM_SERVICE_ACCOUNT"));
  const api = env("FCM_API") || "https://fcm.googleapis.com";
  const res = await fetch(`${api}/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${await googleAccessToken(sa)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: {
      token: d.token,
      notification: { title: p.title, body: p.body },
      data: p.data,
      android: { priority: "high", notification: { tag: p.tag, icon: "ic_stat_selah", color: "#2E5E50", sound: "default" } },
    } }),
  });
  if (res.ok) return { id: d.id, platform: "android", ok: true };
  const err = (await res.json().catch(() => ({}))).error ?? {};
  const code = (err.details ?? []).map((x: { errorCode?: string }) => x.errorCode).find(Boolean) ?? err.status ?? res.status;
  const gone = res.status === 404 || code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /token/i.test(err.message ?? ""));
  return { id: d.id, platform: "android", ok: false, gone, error: String(code) };
}

// ---------------------------------------------------------------------------
// Web: Web Push with VAPID (RFC 8291 message encryption, RFC 8292 VAPID)
// ---------------------------------------------------------------------------
let vapidKey: CryptoKey | null = null;
async function vapidHeader(endpoint: string): Promise<string> {
  const pub = fromB64url(env("VAPID_PUBLIC_KEY"));
  if (!vapidKey) {
    vapidKey = await crypto.subtle.importKey("jwk", {
      kty: "EC", crv: "P-256", d: env("VAPID_PRIVATE_KEY"), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)),
    }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const jwt = await signJwt({ typ: "JWT", alg: "ES256" }, {
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env("VAPID_SUBJECT") || "mailto:admin@example.com",
  }, vapidKey, { name: "ECDSA", hash: "SHA-256" });
  return `vapid t=${jwt}, k=${env("VAPID_PUBLIC_KEY")}`;
}
// Encrypts the message so only that browser can read it (aes128gcm content coding).
async function encryptForBrowser(sub: { keys: { p256dh: string; auth: string } }, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.keys.p256dh), authSecret = fromB64url(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}
async function sendWeb(d: Device, p: Push): Promise<Result> {
  if (!env("VAPID_PRIVATE_KEY")) return { id: d.id, platform: "web", ok: false, error: "Web push not configured" };
  const sub = JSON.parse(d.token);
  const body = await encryptForBrowser(sub, enc.encode(JSON.stringify({ title: p.title, body: p.body, tag: p.tag, data: p.data })));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
      Topic: p.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
    },
    body,
  });
  if (res.ok) return { id: d.id, platform: "web", ok: true };
  return { id: d.id, platform: "web", ok: false, gone: res.status === 404 || res.status === 410, error: `${res.status} ${await res.text().catch(() => "")}`.trim() };
}
