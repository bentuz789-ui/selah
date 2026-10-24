// Run before tests/push.test.mjs: node tests/push-mock/keys.js (writes keys.json and push.env next to this file).
// Makes throwaway keys for the fake Apple/Google/browser push services.
const crypto = require("crypto"), fs = require("fs");
const b64u = b => Buffer.from(b).toString("base64url");
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const apns = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const vapid = crypto.createECDH("prime256v1"); vapid.generateKeys();
const browser = crypto.createECDH("prime256v1"); browser.generateKeys();
const auth = crypto.randomBytes(16);
const host = process.argv[2] || "host.docker.internal";
const keys = {
  sa: { project_id: "selah-test", client_email: "push@selah-test.iam.gserviceaccount.com",
        private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `http://${host}:9099/token` },
  saPublic: rsa.publicKey.export({ type: "spki", format: "pem" }),
  apnsKey: apns.privateKey.export({ type: "pkcs8", format: "pem" }),
  apnsPublic: apns.publicKey.export({ type: "spki", format: "pem" }),
  vapidPublic: b64u(vapid.getPublicKey()), vapidPrivate: b64u(vapid.getPrivateKey()),
  browserPrivate: b64u(browser.getPrivateKey()),
  subscription: { endpoint: `http://${host}:9099/web/abc123`, keys: { p256dh: b64u(browser.getPublicKey()), auth: b64u(auth) } }
};
fs.writeFileSync(__dirname + "/keys.json", JSON.stringify(keys, null, 1));
const envLines = {
  PUSH_WEBHOOK_SECRET: "test-push-secret",
  APNS_KEY: keys.apnsKey.replace(/\n/g, "\\n"), APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM456", APNS_BUNDLE_ID: "com.selahapp.selah",
  APNS_HOST: `http://${host}:9099`,
  FCM_SERVICE_ACCOUNT: JSON.stringify(keys.sa), FCM_API: `http://${host}:9099`,
  VAPID_PUBLIC_KEY: keys.vapidPublic, VAPID_PRIVATE_KEY: keys.vapidPrivate, VAPID_SUBJECT: "mailto:test@example.com"
};
fs.writeFileSync(__dirname + "/push.env", Object.entries(envLines).map(([k, v]) => `${k}='${v}'`).join("\n") + "\n");
console.log("keys written");
