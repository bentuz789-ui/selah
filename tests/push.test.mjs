// Checks push delivery end to end against a local Supabase and fake Apple/Google/browser push
// services (see README, "Testing push notifications"). Run: node tests/push.test.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const SB_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const MOCK = process.env.PUSH_MOCK || "http://127.0.0.1:9099";
const subscription = JSON.parse(readFileSync(process.env.PUSH_KEYS || new URL("./push-mock/keys.json", import.meta.url), "utf8")).subscription;
let fails = 0;
const ok = (c, m) => { console.log((c ? "  pass " : "  FAIL ") + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = async () => (await fetch(MOCK + "/log")).json();
const reset = () => fetch(MOCK + "/reset", { method: "POST" });
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const l = await log(); if (check(l)) return l; await wait(250); } return log(); };
const run = Date.now().toString(36);
async function user(name) {
  const c = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const username = (name + run).toLowerCase().slice(0, 24);
  const { data, error } = await c.auth.signUp({ email: `${username}@example.com`, password: "correct horse battery", options: { data: { name, username } } });
  if (error) throw error;
  return { c, id: data.user.id };
}
const A = await user("Ana"), B = await user("Ben"), C = await user("Cal");
// everyone in one church, so they can find and friend each other
const { data: church } = await A.c.rpc("create_church", { church_name: "Push Test Church" });
const { data: code } = await A.c.rpc("church_code", { cid: church });
await B.c.rpc("join_church", { code });
await C.c.rpc("join_church", { code });
await A.c.from("friendships").insert({ requester: A.id, addressee: B.id });
await B.c.from("friendships").update({ status: "accepted" }).match({ requester: A.id, addressee: B.id });

console.log("devices");
ok(!(await B.c.rpc("register_push", { device_platform: "ios", device_token: "benios" + run })).error, "register an iPhone");
await B.c.rpc("register_push", { device_platform: "android", device_token: "benandroid" + run });
await B.c.rpc("register_push", { device_platform: "web", device_token: JSON.stringify(subscription) });
ok((await B.c.from("push_tokens").select("id")).data.length === 3, "see your own devices");
ok((await A.c.from("push_tokens").select("id")).data.length === 0, "can't see other people's devices");
ok((await A.c.from("push_tokens").insert({ user_id: B.id, platform: "ios", token: "x" })).error, "can't add a device for someone else");

console.log("delivery");
await reset();
await A.c.from("messages").insert({ recipient: B.id, body: "Are you coming tonight?" });
let l = await until(x => x.length >= 3);
const by = s => l.find(x => x.service === s) || {};
ok(by("apns").title === "Ana" && by("apns").body === "Are you coming tonight?", "iPhone gets the message with the sender's name");
ok(by("fcm").title === "Ana" && by("fcm").data?.type === "message" && by("fcm").tag === "chat-" + A.id, "Android gets it, grouped by conversation");
ok(by("web").title === "Ana" && by("web").encoding === "aes128gcm" && by("web").body === "Are you coming tonight?", "browser gets it, encrypted so only it can read it");
ok(!l.some(x => x.service === "error"), "no delivery errors");

await reset();
const { data: post } = await B.c.from("posts").insert({ caption: "Sunrise at camp", church_id: church }).select().single();
await A.c.from("post_reactions").insert({ post_id: post.id, kind: "like" });
l = await until(x => x.length >= 3);
ok(by("apns").body === "Liked your post: “Sunrise at camp”" && by("fcm").data?.post_id === String(post.id), "likes say what was liked and which post");

console.log("settings and blocking");
await B.c.from("user_state").update({ data: { notifPrefs: { like: false, comment: true, message: true } } }).eq("user_id", B.id);
await reset();
await A.c.from("post_reactions").insert({ post_id: post.id, kind: "pray" });
await A.c.from("comments").insert({ post_id: post.id, body: "Beautiful" });
l = await until(x => x.length >= 3, 5000); await wait(1500); l = await log();
ok(l.length === 3 && l.every(x => /Commented/.test(x.body)), "turning off likes in Settings stops like pushes, comments still come");
await reset();
await B.c.from("blocks").insert({ blocker: B.id, blocked: A.id });
await A.c.from("messages").insert({ recipient: B.id, body: "hello?" }); // refused by the database anyway
await A.c.from("comments").insert({ post_id: post.id, body: "still here" });
await wait(2500);
ok((await log()).length === 0, "nothing from someone you blocked");
await B.c.from("blocks").delete().match({ blocker: B.id, blocked: A.id });

console.log("cleanup");
await B.c.rpc("register_push", { device_platform: "ios", device_token: "deadiostoken" });
await B.c.rpc("register_push", { device_platform: "android", device_token: "dead-android-token" });
await B.c.rpc("register_push", { device_platform: "web", device_token: JSON.stringify({ ...subscription, endpoint: subscription.endpoint.replace(/web\/.*/, "web/gone") }) });
await reset();
await C.c.from("friendships").insert({ requester: C.id, addressee: B.id });
await until(x => x.length >= 3); await wait(1500);
const tokens = (await B.c.from("push_tokens").select("token")).data.map(t => t.token);
ok(tokens.length === 3 && !tokens.includes("deadiostoken") && !tokens.includes("dead-android-token") && !tokens.some(t => t.includes("/web/gone")), "devices the push services reject are forgotten");
ok((await log()).some(x => x.body === "Sent you a friend request" && x.title === "Cal"), "friend requests are pushed");
await A.c.rpc("register_push", { device_platform: "ios", device_token: "benios" + run });
ok((await B.c.from("push_tokens").select("token")).data.length === 2, "a phone that logs into another account stops getting the old account's pushes");
await B.c.rpc("unregister_push", { device_token: "benandroid" + run });
ok((await B.c.from("push_tokens").select("token")).data.length === 1, "logging out removes the device");
const r = await fetch(SB_URL + "/functions/v1/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"notification_id":1}' });
ok(r.status === 403, "the push function refuses requests that don't come from the database");
console.log(fails ? `\n${fails} check(s) failed` : "\nAll push checks passed");
process.exit(fails ? 1 : 0);
