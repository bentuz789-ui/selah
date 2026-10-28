// Checks the database security rules with real accounts in two churches against a local Supabase.
// Run: npx supabase start, then: node tests/security.test.mjs
import { createClient } from "@supabase/supabase-js";
const SB_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  pass " : "  FAIL ") + msg); if (!cond) fails++; };
const run = Date.now().toString(36);
async function user(name) {
  const c = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const username = (name + run).toLowerCase().slice(0, 24);
  const { data, error } = await c.auth.signUp({ email: `${username}@example.com`, password: "correct horse battery", options: { data: { name, username } } });
  if (error) throw error;
  return { c, id: data.user.id, username };
}
const count = async (q) => ((await q).data || []).length;
// Ana runs Grace Church; Ben and Dee go there. Cal is at Riverside, run by Rob.
const A = await user("Ana"), B = await user("Ben"), C = await user("Cal"), D = await user("Dee"), R = await user("Rob");

console.log("accounts");
const { data: prof } = await A.c.from("profiles").select("*").eq("id", A.id).single();
ok(prof && prof.name === "Ana", "profile created from sign-up details");
ok((await A.c.rpc("username_available", { u: A.username })).data === false, "taken username reported as unavailable");

console.log("churches");
const { data: grace } = await A.c.rpc("create_church", { church_name: "Grace Church", church_city: "Springfield" });
const { data: riverside } = await R.c.rpc("create_church", { church_name: "Riverside", approval: true });
ok(grace && riverside, "anyone can start a church");
const { data: graceCode } = await A.c.rpc("church_code", { cid: grace });
ok(/^[A-HJ-NP-Z2-9]{8}$/.test(graceCode), "church gets an 8-character invite code without look-alike letters");
ok((await count(B.c.from("churches").select("id"))) === 0, "can't see churches you aren't in");
ok((await B.c.rpc("church_code", { cid: grace })).data === null, "outsiders can't read the invite code");
const pretty = graceCode.slice(0, 4).toLowerCase() + "-" + graceCode.slice(4).toLowerCase();
const { data: preview } = await B.c.rpc("church_preview", { code: pretty });
ok(preview?.[0]?.name === "Grace Church" && preview[0].members === 1, "a code shows which church it is (dashes and lower case are fine)");
ok((await B.c.rpc("join_church", { code: pretty })).data === "active", "joining with the code works right away when approval is off");
await D.c.rpc("join_church", { code: graceCode });
let r = await B.c.rpc("join_church", { code: "WRONG123" });
ok(r.error && /didn't match/.test(r.error.message), "a wrong code gives a clear message");
const { data: riverCode } = await R.c.rpc("church_code", { cid: riverside });
ok((await C.c.rpc("join_church", { code: riverCode })).data === "pending", "churches that require approval put new people on hold");
ok((await count(C.c.from("posts").select("id").eq("church_id", riverside))) === 0 && !(await C.c.rpc("church_code", { cid: riverside })).data, "people waiting for approval can't see anything yet");
r = await C.c.rpc("approve_member", { cid: riverside, member: C.id });
ok(r.error, "can't approve yourself");
await R.c.rpc("approve_member", { cid: riverside, member: C.id });
ok((await count(C.c.from("church_members").select("user_id").eq("church_id", riverside).eq("status", "active"))) === 2, "an admin approves them and they're in");
ok(((await R.c.from("notifications").select("type, actor")).data || []).some(n => n.type === "join_request" && n.actor === C.id), "admins are notified about join requests");
ok(((await C.c.from("notifications").select("type, body")).data || []).some(n => n.type === "join_approved" && n.body === "Riverside"), "people are told when they're approved");
r = await A.c.from("church_members").insert({ church_id: riverside, user_id: A.id, role: "owner", status: "active" });
ok(r.error, "can't add yourself to a church without the code");
r = await B.c.from("churches").update({ name: "Taken over" }).eq("id", grace).select();
ok(!r.data?.length, "members can't rename the church");

console.log("church walls");
const { data: post } = await A.c.from("posts").insert({ caption: "Welcome to Grace!", church_id: grace }).select().single();
ok((await count(B.c.from("posts").select("id").eq("id", post.id))) === 1, "church members see the church's posts");
ok((await count(C.c.from("posts").select("id").eq("id", post.id))) === 0, "people in another church don't");
r = await C.c.from("posts").insert({ caption: "spam", church_id: grace });
ok(r.error, "can't post into a church you're not in");
r = await C.c.from("comments").insert({ post_id: post.id, body: "sneaky" });
ok(r.error, "can't comment on another church's post");
await B.c.from("post_reactions").insert({ post_id: post.id, kind: "like" });
await B.c.from("comments").insert({ post_id: post.id, body: "Amen" });
const an = (await A.c.from("notifications").select("type")).data;
ok(an.some(n => n.type === "like") && an.some(n => n.type === "comment"), "likes and comments notify the author");
ok(((await C.c.from("notifications").select("user_id")).data || []).every(n => n.user_id === C.id), "can't read other people's notifications");
await A.c.from("prayers").insert({ body: "Pray for our building fund", church_id: grace });
ok((await count(B.c.from("prayers").select("id"))) === 1 && (await count(C.c.from("prayers").select("id"))) === 0, "prayer requests stay inside the church");

console.log("groups");
const { data: grp } = await B.c.from("groups").insert({ name: "Youth", church_id: grace, created_by: B.id }).select().single();
ok(grp, "members can start a group in their church");
ok((await count(C.c.from("groups").select("id").eq("id", grp.id))) === 0, "other churches can't see it");
r = await C.c.from("group_members").insert({ group_id: grp.id, user_id: C.id });
ok(r.error, "can't join another church's group");
r = await D.c.from("posts").insert({ caption: "group post", group_id: grp.id, church_id: grace });
ok(r.error, "can't post in a group you haven't joined");
await D.c.from("group_members").insert({ group_id: grp.id, user_id: D.id });
r = await D.c.from("posts").insert({ caption: "group post", group_id: grp.id, church_id: riverside }).select().single();
ok(!r.error && r.data.church_id === grace, "a group post always lands in the group's church");
r = await A.c.from("events").insert({ group_id: grp.id, title: "Lock-in", starts_at: new Date(Date.now() + 864e5).toISOString() });
ok(!r.error, "church admins can add events to any of the church's groups");
r = await D.c.from("events").insert({ group_id: grp.id, title: "Party", starts_at: new Date().toISOString() });
ok(r.error, "regular members can't");

console.log("people and friends");
ok((await count(B.c.from("profiles").select("id").eq("id", D.id))) === 1, "you can find people in your church");
ok((await count(B.c.from("profiles").select("id").eq("id", C.id))) === 0, "but not people from other churches");
r = await B.c.from("friendships").insert({ requester: B.id, addressee: C.id });
ok(r.error, "can't friend-request someone you can't see");
await C.c.rpc("join_church", { code: graceCode }); // Cal visits Grace too
ok((await count(C.c.from("posts").select("id").eq("id", post.id))) === 1, "belonging to two churches shows both");
await B.c.from("friendships").insert({ requester: B.id, addressee: C.id });
await C.c.from("friendships").update({ status: "accepted" }).match({ requester: B.id, addressee: C.id });
await C.c.rpc("leave_church", { cid: grace });
ok((await count(C.c.from("posts").select("id").eq("id", post.id))) === 0, "leaving a church hides its posts again");
ok((await count(B.c.from("profiles").select("id").eq("id", C.id))) === 1, "friends stay friends across churches");
ok(!(await B.c.from("messages").insert({ recipient: C.id, body: "hi Cal" })).error, "and can still message each other");

console.log("roles");
r = await B.c.rpc("set_member_role", { cid: grace, member: D.id, new_role: "admin" });
ok(r.error, "members can't make admins");
await A.c.rpc("set_member_role", { cid: grace, member: B.id, new_role: "admin" });
r = await B.c.rpc("set_member_role", { cid: grace, member: A.id, new_role: "member" });
ok(r.error, "admins can't demote the owner");
r = await A.c.rpc("leave_church", { cid: grace });
ok(r.error && /owner/.test(r.error.message), "the owner can't leave without handing the church over");
r = await B.c.rpc("delete_church", { cid: grace });
ok(r.error, "only the owner can delete the church");

console.log("moderation");
const { data: dpost } = await D.c.from("posts").insert({ caption: "rude post", church_id: grace }).select().single();
await C.c.rpc("join_church", { code: graceCode }); // Cal is back, and reports it
r = await C.c.from("reports").insert({ reported_user: D.id, kind: "post", reason: "bully", content: "rude post", post_id: dpost.id });
ok(!r.error, "anyone can report");
const reps = (await B.c.from("reports").select("id, church_id, reason")).data;
ok(reps.length === 1 && reps[0].church_id === grace, "the report goes to that church's admins");
ok((await count(D.c.from("reports").select("id"))) === 0, "you can't see reports about you");
ok((await count(R.c.from("reports").select("id"))) === 0, "other churches' admins can't see it");
await B.c.from("posts").delete().eq("id", dpost.id);
ok((await count(A.c.from("posts").select("id").eq("id", dpost.id))) === 0, "church admins can remove posts");
ok(!(await B.c.rpc("resolve_report", { rid: reps[0].id, new_status: "action_taken" })).error, "and mark the report handled");
await B.c.rpc("remove_member", { cid: grace, member: D.id });
ok((await count(D.c.from("posts").select("id").eq("id", post.id))) === 0, "removed members lose access");
r = await D.c.rpc("join_church", { code: graceCode });
ok(r.error && /can't join/.test(r.error.message), "and can't rejoin with the code");
const newCode = (await A.c.rpc("new_church_code", { cid: grace })).data;
ok(newCode && newCode !== graceCode && (await R.c.rpc("church_preview", { code: newCode })).data?.[0]?.name === "Grace Church", "admins can change the invite code");
r = await R.c.rpc("join_church", { code: graceCode });
ok(r.error, "the old code stops working");

console.log("looking glass");
await A.c.from("friendships").insert({ requester: A.id, addressee: B.id });
await B.c.from("friendships").update({ status: "accepted" }).match({ requester: A.id, addressee: B.id });
await A.c.storage.from("glass").upload(`${A.id}/g1.jpg`, new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }));
await A.c.from("glasses").insert({ recipient: B.id, caption: "secret", art: "sea", image_path: `${A.id}/g1.jpg` });
ok((await B.c.from("glasses").select("caption")).error, "can't read a Looking Glass's words without opening it");
ok((await B.c.storage.from("glass").download(`${A.id}/g1.jpg`)).error, "can't load the photo before opening");
const { data: list } = await B.c.from("glasses").select("id, sender, opened_at");
ok((await B.c.rpc("open_glass", { gid: list[0].id })).data?.[0]?.caption === "secret", "opening returns the contents once");
ok(!(await B.c.storage.from("glass").download(`${A.id}/g1.jpg`)).error, "photo loads right after opening");
ok((await B.c.rpc("open_glass", { gid: list[0].id })).data.length === 0, "can't open it a second time");
await B.c.from("glasses").insert({ recipient: A.id, art: "dawn" });
ok((await A.c.rpc("glass_streaks")).data.some(s => s.friend === B.id && s.days === 1), "streak counts a day you both sent one");

console.log("blocking");
await B.c.from("blocks").insert({ blocker: B.id, blocked: A.id });
ok((await count(B.c.from("posts").select("id").eq("id", post.id))) === 0, "blocking hides their posts, even in the same church");
ok((await count(A.c.from("profiles").select("id").eq("id", B.id))) === 0, "blocked person can't find the blocker");
ok((await A.c.from("messages").insert({ recipient: B.id, body: "hello?" })).error, "blocked person can't message you");
ok((await count(A.c.from("friendships").select("*").or(`requester.eq.${B.id},addressee.eq.${B.id}`))) === 0, "blocking ends the friendship");
ok((await count(A.c.from("blocks").select("*"))) === 0, "you can't see who blocked you");

console.log("storage and deletion");
r = await C.c.storage.from("avatars").upload(`${A.id}/me.jpg`, new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
ok(r.error, "can't upload into someone else's folder");
ok(!(await C.c.rpc("delete_my_account")).error, "delete account runs");
ok((await count(R.c.from("profiles").select("id").eq("id", C.id))) === 0, "deleted account is gone");
await R.c.rpc("delete_church", { cid: riverside });
ok((await count(R.c.from("churches").select("id"))) === 0, "the owner can delete their church");
console.log(fails ? `\n${fails} check(s) failed` : "\nAll security checks passed");
process.exit(fails ? 1 : 0);
