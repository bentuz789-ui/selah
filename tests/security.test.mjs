// Checks the database security rules with three real accounts against a local Supabase.
// Run: npx supabase start, then: node tests/security.test.mjs
import { createClient } from "@supabase/supabase-js";
const URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  pass " : "  FAIL ") + msg); if (!cond) fails++; };
const run = Date.now().toString(36);
async function user(name) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const username = (name + run).toLowerCase().slice(0, 24);
  const { data, error } = await c.auth.signUp({ email: `${username}@example.com`, password: "correct horse battery", options: { data: { name, username } } });
  if (error) throw error;
  return { c, id: data.user.id, username };
}
const A = await user("Ana"), B = await user("Ben"), C = await user("Cal");
console.log("accounts");
const { data: prof } = await A.c.from("profiles").select("*").eq("id", A.id).single();
ok(prof && prof.name === "Ana", "profile created from sign-up details");
const { data: avail } = await A.c.rpc("username_available", { u: A.username });
ok(avail === false, "taken username reported as unavailable");

console.log("friends");
let r = await A.c.from("messages").insert({ recipient: B.id, body: "hi" });
ok(r.error, "can't message someone who isn't a friend");
await A.c.from("friendships").insert({ requester: A.id, addressee: B.id });
r = await A.c.from("friendships").update({ status: "accepted" }).eq("requester", A.id).eq("addressee", B.id).select();
ok(!r.data?.length, "can't accept your own friend request");
r = await B.c.from("friendships").update({ status: "accepted" }).eq("requester", A.id).eq("addressee", B.id).select();
ok(r.data?.length === 1, "friend can accept request");
const { data: bn } = await B.c.from("notifications").select("type");
ok(bn.some(n => n.type === "friend_request"), "friend request creates a notification");

console.log("posts");
const { data: post } = await A.c.from("posts").insert({ caption: "Hello friends" }).select().single();
ok((await B.c.from("posts").select("id").eq("id", post.id)).data.length === 1, "friend sees post");
ok((await C.c.from("posts").select("id").eq("id", post.id)).data.length === 0, "stranger can't see post");
r = await C.c.from("comments").insert({ post_id: post.id, body: "sneaky" });
ok(r.error, "stranger can't comment on a post they can't see");
await B.c.from("post_reactions").insert({ post_id: post.id, kind: "like" });
await B.c.from("comments").insert({ post_id: post.id, body: "Amen" });
const { data: an } = await A.c.from("notifications").select("type");
ok(an.some(n => n.type === "like") && an.some(n => n.type === "comment"), "likes and comments notify the author");
ok((await C.c.from("notifications").select("id")).data.length === 0, "can't read other people's notifications");
const { data: grp } = await A.c.from("groups").select("id").limit(1).single();
r = await C.c.from("posts").insert({ caption: "group post", group_id: grp.id });
ok(r.error, "can't post in a group you haven't joined");
await C.c.from("group_members").insert({ group_id: grp.id, user_id: C.id });
r = await C.c.from("posts").insert({ caption: "group post", group_id: grp.id }).select().single();
ok(!r.error && (await A.c.from("posts").select("id").eq("id", r.data.id)).data.length === 1, "group posts are visible to everyone signed in");
r = await C.c.from("group_members").insert({ group_id: grp.id, user_id: A.id });
ok(r.error, "can't add someone else to a group");

console.log("looking glass");
await A.c.storage.from("glass").upload(`${A.id}/g1.jpg`, new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }));
await A.c.from("glasses").insert({ recipient: B.id, caption: "secret", art: "sea", image_path: `${A.id}/g1.jpg` });
r = await B.c.from("glasses").select("caption");
ok(r.error, "can't read a Looking Glass's words without opening it");
r = await B.c.storage.from("glass").download(`${A.id}/g1.jpg`);
ok(r.error, "can't load the photo before opening");
const { data: list } = await B.c.from("glasses").select("id, sender, opened_at");
const { data: opened } = await B.c.rpc("open_glass", { gid: list[0].id });
ok(opened?.[0]?.caption === "secret", "opening returns the contents once");
r = await B.c.storage.from("glass").download(`${A.id}/g1.jpg`);
ok(!r.error, "photo loads right after opening");
const { data: again } = await B.c.rpc("open_glass", { gid: list[0].id });
ok(again.length === 0, "can't open it a second time");
ok((await C.c.rpc("open_glass", { gid: list[0].id })).data.length === 0, "someone else can't open it");
await B.c.from("glasses").insert({ recipient: A.id, art: "dawn" });
const { data: st } = await A.c.rpc("glass_streaks");
ok(st.some(s => s.friend === B.id && s.days === 1), "streak counts a day you both sent one");

console.log("blocking");
await A.c.from("prayers").insert({ body: "Pray for my exam" });
ok((await B.c.from("prayers").select("id")).data.length === 1, "friend sees prayer request");
await B.c.from("blocks").insert({ blocker: B.id, blocked: A.id });
ok((await B.c.from("posts").select("id").eq("id", post.id)).data.length === 0, "blocking hides their posts");
ok((await A.c.from("profiles").select("id").eq("id", B.id)).data.length === 0, "blocked person can't find the blocker");
r = await A.c.from("messages").insert({ recipient: B.id, body: "hello?" });
ok(r.error, "blocked person can't message you");
ok((await A.c.from("friendships").select("*")).data.length === 0, "blocking ends the friendship");
ok((await A.c.from("blocks").select("*")).data.length === 0, "you can't see who blocked you");

console.log("reports and deletion");
r = await C.c.from("reports").insert({ reported_user: A.id, kind: "post", reason: "spam", content: "x" });
ok(!r.error, "anyone can send a report");
ok((await A.c.from("reports").select("id")).data.length === 0, "you can't see reports about you");
await C.c.storage.from("avatars").upload(`${C.id}/me.jpg`, new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
r = await C.c.storage.from("avatars").upload(`${A.id}/me.jpg`, new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
ok(r.error, "can't upload into someone else's folder");
r = await C.c.rpc("delete_my_account");
ok(!r.error, "delete account runs");
ok((await A.c.from("profiles").select("id").eq("id", C.id)).data.length === 0, "deleted account is gone");
console.log(fails ? `\n${fails} check(s) failed` : "\nAll security checks passed");
process.exit(fails ? 1 : 0);
