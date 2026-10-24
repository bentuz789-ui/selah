// Run: node tests/push-mock/server.js (listens on port 9099).
// A stand-in for Apple's, Google's and a browser's push services. It checks the same things the
// real services check (signed tokens, topic, encryption) and records what it received.
const http = require("http"), crypto = require("crypto"), ece = require("http_ece");
const keys = require("./keys.json");
const log = [];
const vjwt = (jwt, pem, alg) => {
  const [h, c, s] = jwt.split(".");
  const ok = crypto.verify(alg === "RS256" ? "sha256" : "sha256", Buffer.from(`${h}.${c}`),
    alg === "RS256" ? pem : { key: pem, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(c, "base64url")) };
};
const vapidPem = () => {
  const pub = Buffer.from(keys.vapidPublic, "base64url");
  return crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
};
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks), send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === "GET" && req.url === "/log") return send(200, log);
      if (req.method === "POST" && req.url === "/reset") { log.length = 0; return send(200, {}); }
      if (req.url === "/token") { // Google OAuth
        const a = new URLSearchParams(raw.toString()).get("assertion");
        const v = vjwt(a, keys.saPublic, "RS256");
        if (!v.ok || v.claims.iss !== keys.sa.client_email || !/firebase\.messaging/.test(v.claims.scope)) return send(401, { error: "bad assertion" });
        return send(200, { access_token: "test-access-token", expires_in: 3600, token_type: "Bearer" });
      }
      let m;
      if ((m = req.url.match(/^\/v1\/projects\/([^/]+)\/messages:send$/))) { // FCM
        if (req.headers.authorization !== "Bearer test-access-token") return send(401, { error: { status: "UNAUTHENTICATED" } });
        const msg = JSON.parse(raw).message;
        if (msg.token === "dead-android-token") return send(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } });
        log.push({ service: "fcm", project: m[1], token: msg.token, title: msg.notification.title, body: msg.notification.body, data: msg.data, tag: msg.android.notification.tag });
        return send(200, { name: "projects/x/messages/1" });
      }
      if ((m = req.url.match(/^\/3\/device\/(.+)$/))) { // APNs
        const jwt = (req.headers.authorization || "").replace(/^bearer /, "");
        const v = vjwt(jwt, keys.apnsPublic, "ES256");
        if (!v.ok || v.header.kid !== "KEY123" || v.claims.iss !== "TEAM456") return send(403, { reason: "InvalidProviderToken" });
        if (req.headers["apns-topic"] !== "com.selahapp.selah") return send(400, { reason: "DeviceTokenNotForTopic" });
        if (m[1] === "deadiostoken") return send(410, { reason: "Unregistered" });
        const p = JSON.parse(raw);
        log.push({ service: "apns", token: m[1], title: p.aps.alert.title, body: p.aps.alert.body, type: p.type, collapse: req.headers["apns-collapse-id"] });
        return send(200, {});
      }
      if ((m = req.url.match(/^\/web\/(.+)$/))) { // browser push service
        if (m[1] === "gone") return send(410, {});
        const auth = req.headers.authorization || "";
        const t = auth.match(/t=([^,]+)/)[1], k = auth.match(/k=([^,\s]+)/)[1];
        const v = vjwt(t, vapidPem(), "ES256");
        if (!v.ok || k !== keys.vapidPublic) return send(403, { error: "bad vapid" });
        const ecdh = crypto.createECDH("prime256v1"); ecdh.setPrivateKey(Buffer.from(keys.browserPrivate, "base64url"));
        const plain = ece.decrypt(raw, { version: "aes128gcm", privateKey: ecdh, authSecret: keys.subscription.keys.auth });
        const p = JSON.parse(plain.toString());
        log.push({ service: "web", aud: v.claims.aud, encoding: req.headers["content-encoding"], title: p.title, body: p.body, data: p.data });
        return send(201, {});
      }
      send(404, { error: "unknown path " + req.url });
    } catch (e) { log.push({ service: "error", error: String(e) }); send(500, { error: String(e) }); }
  });
}).listen(9099, "0.0.0.0", () => console.log("mock push services on :9099"));
