// Selah's connection to its server (Supabase): accounts, loading and saving everything,
// and live updates. Used only when config.js names a Supabase project; otherwise the app
// runs as a demo with sample people.
//
// The screens in index.html work on one in-memory state object, S. This file fills S from
// the server, turns the signed-in person's id into "me" (the id the screens use for you),
// and replaces the do-nothing `api` calls with real ones.

let sb = null, ME = null, liveUserEmail = "";
let refreshTimer = 0, saveTimer = 0, liveEntered = false, catchUpStarted = false, liveReady = false;
const PERSONAL = ["read", "done", "streak", "readDay", "planDay", "highlights", "notifPrefs", "theme", "hiddenPosts", "seen"];

function liveBlankState() {
  return {
    profile: { name: "", handle: "", church: "", photo: null },
    tab: "home", read: { tr: "kjv", b: 18, c: 23 }, done: {}, streak: 0, readDay: "", planDay: 1, highlights: {},
    notifPrefs: { like: true, comment: true, message: true }, theme: null, hiddenPosts: {}, seen: {},
    stories: { me: [] }, posts: [], snaps: [], sent: {}, streaks: {}, groups: [], dms: {}, unread: {},
    prayers: [], notifs: [], blocked: {}, reports: [], requests: [], requested: {},
    groupId: null, gtab: "discussion", nextId: 1, demoPing: true
  };
}
const liveEmail = () => liveUserEmail;
const pid = id => id === ME ? "me" : id;
const realId = id => id === "me" ? ME : id;

// Personal things (Bible progress, highlights, settings) live in one row per person.
function liveSave() {
  if (!ME) return;
  const data = {};
  PERSONAL.forEach(k => data[k] = S[k]);
  try { localStorage.setItem("selah-live-" + ME, JSON.stringify(data)); } catch (e) {}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => sb.from("user_state").upsert({ user_id: ME, data, updated_at: new Date().toISOString() })
    .then(r => { if (r.error) console.warn("save", r.error.message); }), 800);
}

function shortAgo(t) {
  const s = (Date.now() - Date.parse(t)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 604800) return Math.floor(s / 86400) + "d";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function failed(error, what) {
  console.warn(what, error);
  toast(navigator.onLine === false ? "You're offline. Try again when you're connected." : `Couldn't ${what}. Please try again.`);
  scheduleRefresh(300);
}
// Runs a server request; on failure shows a message and reloads so the screen matches the server.
async function call(what, promise) {
  try {
    const r = await promise;
    if (r && r.error) { failed(r.error, what); return null; }
    return r || {};
  } catch (e) { failed(e, what); return null; }
}

// ---------- photos ----------
function dataUrlToBlob(url) {
  const [head, b64] = url.split(",");
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.match(/:(.*?);/)[1] });
}
const newName = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)) + ".jpg";
// Uploads a photo the person picked (a data: URL) and returns where it lives.
async function uploadPhoto(bucket, dataUrl) {
  if (!dataUrl || !dataUrl.startsWith("data:")) return { url: dataUrl || null, path: null };
  const path = `${ME}/${newName()}`;
  const r = await sb.storage.from(bucket).upload(path, dataUrlToBlob(dataUrl), { contentType: "image/jpeg", upsert: false });
  if (r.error) throw r.error;
  return { path, url: bucket === "glass" ? null : sb.storage.from(bucket).getPublicUrl(path).data.publicUrl };
}

// ---------- start up ----------
async function startLive() {
  sb = supabase.createClient(SELAH_CONFIG.supabaseUrl, SELAH_CONFIG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  Object.assign(api, liveApi);
  listenForPushTaps();
  $("#view").innerHTML = `<p class="loading" style="text-align:center;padding-block:48px">Loading…</p>`;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") setTimeout(openNewPassword, 0);
    if (event === "SIGNED_OUT") { liveEntered = false; liveReady = false; ME = null; showAuth(); }
    if (event === "SIGNED_IN" && session && !liveEntered) setTimeout(() => enterApp(session.user), 0);
  });
  const { data } = await sb.auth.getSession();
  if (data.session) await enterApp(data.session.user);
  else if (!liveEntered) showAuth();
}

async function enterApp(user) {
  if (liveEntered && ME === user.id) return;
  liveEntered = true; liveReady = false; ME = user.id; liveUserEmail = user.email || "";
  S = liveBlankState();
  try { Object.assign(S, JSON.parse(localStorage.getItem("selah-live-" + ME)) || {}); } catch (e) {}
  hideAuth();
  $("#view").innerHTML = `<p class="loading" style="text-align:center;padding-block:48px">Loading your feed…</p>`;
  const ok = await loadAll(true);
  if (!ok) {
    $("#view").innerHTML = `<div class="card empty" style="margin-top:24px">Couldn't reach Selah. Check your connection, then <button class="pill" id="liveRetry">Try again</button></div>`;
    $("#liveRetry").onclick = () => { liveEntered = false; enterApp(user); };
    return;
  }
  liveReady = true;
  applyTheme(); render();
  subscribeLive();
  afterLoginPush();
}

// ---------- loading everything ----------
async function loadAll(first) {
  const since = new Date(Date.now() - 400 * 864e5).toISOString();
  const q = await Promise.all([
    sb.from("profiles").select("*").eq("id", ME).single(),
    sb.from("user_state").select("data").eq("user_id", ME).maybeSingle(),
    sb.from("friendships").select("*"),
    sb.from("blocks").select("blocked"),
    sb.from("posts").select("*, post_reactions(kind,user_id), comments(id,author,body,created_at)")
      .order("created_at", { ascending: false }).order("created_at", { referencedTable: "comments", ascending: true }).limit(100),
    sb.from("stories").select("*").order("created_at", { ascending: true }),
    sb.from("glasses").select("id,sender,recipient,created_at,opened_at").gte("created_at", since).order("created_at", { ascending: true }).limit(500),
    sb.from("messages").select("*").order("created_at", { ascending: true }).limit(1000),
    sb.from("groups").select("*, group_members(user_id,role), events(*, event_rsvps(user_id))").order("name"),
    sb.from("prayers").select("*, prayer_marks(user_id)").order("created_at", { ascending: false }).limit(100),
    sb.from("notifications").select("*").order("created_at", { ascending: false }).limit(60),
    sb.rpc("glass_streaks"),
    sb.from("reports").select("id", { count: "exact", head: true })
  ]).catch(e => { console.warn(e); return null; });
  if (!q || q.some(r => r.error)) { if (q) console.warn(q.filter(r => r.error).map(r => r.error.message)); return false; }
  const [prof, state, friends, blocks, posts, stories, glasses, msgs, groups, prayers, notifs, streaks, reports] = q.map(r => r.data);

  // who's who
  const ids = new Set();
  friends.forEach(f => { ids.add(f.requester); ids.add(f.addressee); });
  blocks.forEach(b => ids.add(b.blocked));
  posts.forEach(p => { ids.add(p.author); p.comments.forEach(c => ids.add(c.author)); });
  stories.forEach(s => ids.add(s.author));
  glasses.forEach(g => { ids.add(g.sender); ids.add(g.recipient); });
  msgs.forEach(m => { ids.add(m.sender); ids.add(m.recipient); });
  groups.forEach(g => g.group_members.slice(0, 40).forEach(m => ids.add(m.user_id)));
  prayers.forEach(p => ids.add(p.author));
  notifs.forEach(n => ids.add(n.actor));
  ids.delete(ME);
  await loadPeople([...ids]);

  // you
  S.profile = { name: prof.name, handle: prof.username, church: prof.church, photo: prof.avatar_url };
  if (first && state && state.data) PERSONAL.forEach(k => { if (state.data[k] !== undefined) S[k] = state.data[k]; });

  S.blocked = {}; blocks.forEach(b => S.blocked[b.blocked] = true);
  const streakOf = {}; (streaks || []).forEach(x => streakOf[x.friend] = x.days);
  S.streaks = {}; S.requests = []; S.requested = {};
  friends.forEach(f => {
    const other = f.requester === ME ? f.addressee : f.requester;
    if (f.status === "accepted") S.streaks[other] = streakOf[other] || 0;
    else if (f.addressee === ME) S.requests.push(other);
    else S.requested[other] = true;
  });

  const groupName = {}; groups.forEach(g => groupName[g.id] = g.name);
  const wasOpen = {}; S.posts.forEach(p => { if (p.open) wasOpen[p.id] = true; });
  S.posts = posts.map(p => ({
    id: p.id, by: pid(p.author), group: p.group_id ? groupName[p.group_id] : undefined, groupId: p.group_id,
    time: shortAgo(p.created_at), art: p.art, img: p.image_url,
    verse: p.verse_text ? { text: p.verse_text, ref: p.verse_ref || "" } : null, cap: p.caption,
    likes: p.post_reactions.filter(r => r.kind === "like").length, liked: p.post_reactions.some(r => r.kind === "like" && r.user_id === ME),
    prays: p.post_reactions.filter(r => r.kind === "pray").length, prayed: p.post_reactions.some(r => r.kind === "pray" && r.user_id === ME),
    cmts: p.comments.map(c => ({ id: c.id, by: pid(c.author), t: c.body })), open: !!wasOpen[p.id]
  }));

  S.stories = { me: [] };
  stories.forEach(s => (S.stories[pid(s.author)] ||= []).push({
    id: s.id, art: s.art, img: s.image_url, cap: s.caption, verse: s.verse_text ? { text: s.verse_text, ref: s.verse_ref || "" } : null
  }));

  // messages and Looking Glasses together, in time order, per friend
  const thread = [];
  msgs.forEach(m => thread.push({ at: m.created_at, other: m.sender === ME ? m.recipient : m.sender, m: {
    id: m.id, f: pid(m.sender), t: m.body, kind: m.kind === "text" ? undefined : m.kind, ref: m.ref, art: m.art } }));
  S.snaps = [];
  glasses.forEach(g => {
    if (g.recipient === ME && !g.opened_at) { S.snaps.push({ id: g.id, from: g.sender, opened: false }); return; }
    thread.push({ at: g.created_at, other: g.sender === ME ? g.recipient : g.sender, m: { f: pid(g.sender), kind: "glass" } });
  });
  thread.sort((a, b) => a.at < b.at ? -1 : 1);
  S.dms = {}; thread.forEach(x => (S.dms[x.other] ||= []).push(x.m));
  S.unread = {}; msgs.forEach(m => { if (m.recipient === ME && !m.read_at) S.unread[m.sender] = (S.unread[m.sender] || 0) + 1; });

  const now = Date.now() - 864e5;
  S.groups = groups.map(g => {
    const mine = g.group_members.find(m => m.user_id === ME);
    return {
      id: g.id, name: g.name, about: g.about, meets: g.meets, art: g.art, members: g.group_members.length,
      joined: !!mine, isAdmin: !!(mine && mine.role === "admin"),
      people: g.group_members.map(m => m.user_id).filter(u => u !== ME && PEOPLE[u]).slice(0, 40),
      events: g.events.filter(e => Date.parse(e.starts_at) > now).sort((a, b) => a.starts_at < b.starts_at ? -1 : 1)
        .map(e => Object.assign(eventFields(new Date(e.starts_at)), { id: e.id, t: e.title, where: e.place,
          n: e.event_rsvps.length, going: e.event_rsvps.some(r => r.user_id === ME) }))
    };
  });

  S.prayers = prayers.map(p => ({ id: p.id, by: pid(p.author), t: p.body, n: p.prayer_marks.length, me: p.prayer_marks.some(m => m.user_id === ME) }));
  S.notifs = notifs.filter(n => wantsNotif(n.type)).map(liveNotif);
  S.reports = Array.from({ length: q[12].count || 0 });
  return true;
}

// Fills in names and photos for people we haven't seen yet.
async function loadPeople(ids) {
  const need = ids.filter(id => id && id !== ME && !PEOPLE[id]);
  for (let i = 0; i < need.length; i += 100) {
    const { data } = await sb.from("profiles").select("id,name,username,church,avatar_url").in("id", need.slice(i, i + 100));
    (data || []).forEach(rememberPerson);
  }
  // people we can't see (deleted, or they blocked us) still need a label
  need.forEach(id => { if (!PEOPLE[id]) PEOPLE[id] = { name: "Selah member", short: "Member" }; });
}
function rememberPerson(p) {
  PEOPLE[p.id] = { name: p.name, short: p.name.split(" ")[0], username: p.username, bio: p.church, photo: p.avatar_url };
}

const NOTIF_PREF = { like: "like", pray: "like", comment: "comment", message: "message", glass: "message" };
const wantsNotif = type => !NOTIF_PREF[type] || S.notifPrefs[NOTIF_PREF[type]] !== false;
function liveNotif(n) {
  return { id: n.id, type: n.type, from: pid(n.actor), text: n.body || "", postId: n.post_id, time: Date.parse(n.created_at), read: !!n.read_at };
}

// Reload from the server soon (several changes in a row only reload once).
function scheduleRefresh(ms = 500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!ME) return;
    if (await loadAll(false)) {
      softRender();
      document.querySelectorAll(".ov.thread").forEach(o => o.draw && o.draw());
    }
  }, ms);
}

// ---------- live updates ----------
async function subscribeLive() {
  if (sb.getChannels().length) await sb.removeAllChannels();
  sb.channel("me-" + ME)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${ME}` }, async ({ new: m }) => {
      await loadPeople([m.sender]);
      if (isBlocked(m.sender)) return;
      (S.dms[m.sender] ||= []).push({ id: m.id, f: m.sender, t: m.body, kind: m.kind === "text" ? undefined : m.kind, ref: m.ref, art: m.art });
      const open = document.querySelector(`.ov.thread[data-who="${m.sender}"]`);
      if (open) { open.draw(); api.markRead(m.sender); }
      else S.unread[m.sender] = (S.unread[m.sender] || 0) + 1;
      softRender();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${ME}` }, async ({ new: n }) => {
      await loadPeople([n.actor]);
      if (isBlocked(n.actor)) return;
      if (n.type !== "message") scheduleRefresh(); // messages arrive on their own above
      if (!wantsNotif(n.type)) return;
      const item = liveNotif(n);
      S.notifs.unshift(item);
      const inThread = n.type === "message" && document.querySelector(`.ov.thread[data-who="${n.actor}"]`);
      if (S.tab === "notifs") { item.read = true; api.readNotifs(); softRender(); }
      else if (!inThread) { updateBell(); showBanner(item); }
    })
    .subscribe();
  // catch up when the app comes back to the foreground, and every couple of minutes
  if (catchUpStarted) return;
  catchUpStarted = true;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && ME) scheduleRefresh(100); });
  setInterval(() => { if (document.visibilityState === "visible" && ME) scheduleRefresh(0); }, 120000);
}

// ---------- the real server calls ----------
const liveApi = {
  async react(p, kind, on) {
    if (on) await call("save that", sb.from("post_reactions").insert({ post_id: p.id, kind }));
    else await call("save that", sb.from("post_reactions").delete().match({ post_id: p.id, user_id: ME, kind }));
  },
  async comment(p, c) {
    const r = await call("post your comment", sb.from("comments").insert({ post_id: p.id, body: c.t }).select("id").single());
    if (r) c.id = r.data.id;
  },
  async createPost(post) {
    try {
      const photo = await uploadPhoto("media", post.img);
      const r = await sb.from("posts").insert({
        caption: post.cap || "", art: post.art || null, image_url: photo.url, group_id: post.groupId || null,
        verse_text: post.verse ? post.verse.text : null, verse_ref: post.verse ? post.verse.ref : null
      }).select("id").single();
      if (r.error) throw r.error;
      post.id = r.data.id; post.img = photo.url;
    } catch (e) { S.posts = S.posts.filter(x => x !== post); render(); failed(e, "share your post"); }
  },
  async addPrayer(pr) {
    const r = await call("share your prayer request", sb.from("prayers").insert({ body: pr.t }).select("id").single());
    if (r) pr.id = r.data.id;
  },
  async markPrayed(pr, on) {
    if (on) await call("save that", sb.from("prayer_marks").insert({ prayer_id: pr.id }));
    else await call("save that", sb.from("prayer_marks").delete().match({ prayer_id: pr.id, user_id: ME }));
  },
  deletePost(p) { return call("delete the post", sb.from("posts").delete().eq("id", p.id)); },
  deleteComment(c) { if (c.id) return call("delete the comment", sb.from("comments").delete().eq("id", c.id)); },
  deletePrayer(pr) { if (pr.id) return call("delete the request", sb.from("prayers").delete().eq("id", pr.id)); },

  async send(ids, content, kind) {
    try {
      if (kind === "glass") {
        for (const id of ids) {
          const photo = await uploadPhoto("glass", content.img);
          const r = await sb.from("glasses").insert({ recipient: realId(id), art: content.art || null, image_path: photo.path,
            caption: content.cap || null, verse_text: content.verse ? content.verse.text : null, verse_ref: content.verse ? content.verse.ref : null });
          if (r.error) throw r.error;
        }
      } else {
        const body = content.cap || (content.verse && content.verse.ref) || "Shared a post";
        const r = await sb.from("messages").insert(ids.map(id => ({ recipient: realId(id), kind: "share", body, art: content.art || null })));
        if (r.error) throw r.error;
      }
      scheduleRefresh(800);
    } catch (e) { failed(e, "send that"); }
  },
  async message(id, m) {
    const row = m.kind === "verse" ? { recipient: id, kind: "verse", body: m.t, ref: m.ref } : { recipient: id, kind: "text", body: m.t };
    const r = await call("send your message", sb.from("messages").insert(row).select("id").single());
    if (r) m.id = r.data.id;
  },
  markRead(id) { sb.rpc("mark_thread_read", { friend: id }).then(() => {}); },
  async addStory(sl) {
    try {
      const photo = await uploadPhoto("media", sl.img);
      const r = await sb.from("stories").insert({ art: sl.art || null, image_url: photo.url, caption: sl.cap || null,
        verse_text: sl.verse ? sl.verse.text : null, verse_ref: sl.verse ? sl.verse.ref : null }).select("id").single();
      if (r.error) throw r.error;
      sl.id = r.data.id; sl.img = photo.url;
    } catch (e) { failed(e, "add to your story"); }
  },
  viewStory(id, slides) {
    if (id === "me") return;
    const rows = slides.filter(s => s.id).map(s => ({ story_id: s.id }));
    if (rows.length) sb.from("story_views").upsert(rows, { onConflict: "story_id,viewer", ignoreDuplicates: true }).then(() => {});
  },
  async openGlass(sn) {
    const r = await call("open the Looking Glass", sb.rpc("open_glass", { gid: sn.id }));
    if (!r || !r.data || !r.data.length) return null;
    const g = r.data[0];
    let img = null;
    if (g.image_path) {
      const u = await sb.storage.from("glass").createSignedUrl(g.image_path, 120);
      img = u.data && u.data.signedUrl;
    }
    return { art: g.art, img, cap: g.caption, verse: g.verse_text ? { text: g.verse_text, ref: g.verse_ref || "" } : null, path: g.image_path };
  },
  glassViewed(sn) {
    if (sn.path) sb.storage.from("glass").remove([sn.path]).then(() => {});
    S.snaps = S.snaps.filter(x => x !== sn);
  },
  async joinGroup(g, on) {
    if (on) await call("join the group", sb.from("group_members").insert({ group_id: g.id, user_id: ME }));
    else await call("leave the group", sb.from("group_members").delete().match({ group_id: g.id, user_id: ME }));
    scheduleRefresh(800);
  },
  async rsvp(e, on) {
    if (on) await call("save your RSVP", sb.from("event_rsvps").insert({ event_id: e.id, user_id: ME }));
    else await call("save your RSVP", sb.from("event_rsvps").delete().match({ event_id: e.id, user_id: ME }));
  },
  async createGroup(g) {
    const r = await call("create the group", sb.from("groups").insert({ name: g.name, about: g.about, meets: g.meets, art: g.art, created_by: ME }).select("id").single());
    return r && r.data.id;
  },
  async addEvent(g, e) {
    const r = await call("add the event", sb.from("events").insert({ group_id: g.id, title: e.title, starts_at: e.starts_at, place: e.place }).select("id").single());
    return r && r.data.id;
  },
  requestFriend(id) { return call("send the friend request", sb.from("friendships").insert({ requester: ME, addressee: id })); },
  async respondFriend(id, accept) {
    if (accept) await call("accept the request", sb.from("friendships").update({ status: "accepted" }).match({ requester: id, addressee: ME }));
    else await call("decline the request", sb.from("friendships").delete().match({ requester: id, addressee: ME }));
    scheduleRefresh(800);
  },
  async block(id) { await call("block them", sb.from("blocks").insert({ blocker: ME, blocked: id })); scheduleRefresh(800); },
  async unblock(id) { await call("unblock them", sb.from("blocks").delete().match({ blocker: ME, blocked: id })); scheduleRefresh(800); },
  report(rec) {
    return call("send your report", sb.from("reports").insert({
      reported_user: realId(rec.who), kind: rec.kind, reason: rec.reason, details: rec.details || "", content: (rec.ref || "").slice(0, 2000),
      post_id: rec.postId || null, comment_id: rec.commentId || null, prayer_id: rec.prayerId || null
    }));
  },
  readNotifs() { sb.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", ME).is("read_at", null).then(() => {}); },
  clearNotifs() { return call("clear notifications", sb.from("notifications").delete().eq("user_id", ME)); },
  async saveProfile(pf) {
    try {
      if (pf.handle !== S.profile.handle) {
        const { data: free } = await sb.rpc("username_available", { u: pf.handle });
        if (!free) { toast("That username is taken. Try another."); return false; }
      }
      const old = S.profile.photo;
      const photo = await uploadPhoto("avatars", pf.photo);
      const r = await sb.from("profiles").update({ name: pf.name, username: pf.handle, church: pf.church, avatar_url: photo.url }).eq("id", ME);
      if (r.error) throw r.error;
      // remove the previous picture once the new one is saved
      if (old && old !== photo.url && old.includes("/avatars/")) sb.storage.from("avatars").remove([old.split("/avatars/")[1]]).then(() => {});
      return { photo: photo.url };
    } catch (e) { failed(e, "save your profile"); return false; }
  },
  async searchPeople(q) {
    const term = q.replace(/[%,()]/g, " ").trim();
    if (!term) return [];
    const { data, error } = await sb.from("profiles").select("id,name,username,church,avatar_url")
      .or(`name.ilike.%${term}%,username.ilike.%${term}%`).neq("id", ME).limit(25);
    if (error) { console.warn(error); return []; }
    data.forEach(rememberPerson);
    return data.map(p => p.id);
  }
};

// ---------- account screens ----------
function authShell(inner) {
  let o = document.querySelector(".auth");
  if (!o) { o = document.createElement("div"); o.className = "ov auth"; $("#app").appendChild(o); }
  o.innerHTML = `<div class="authbox gut">${inner}</div>`;
  return o;
}
function hideAuth() { document.querySelector(".auth")?.remove(); }
function showAuth() {
  document.querySelectorAll(".ov:not(.auth)").forEach(x => x.remove());
  const o = authShell(`<div class="authhero"><div class="logo authlogo">Selah</div>
      <p>Share moments, read the Bible and pray together with your friends and church.</p></div>
    <button class="pill solid big" data-go="signup">Create an account</button>
    <button class="pill big" data-go="login">Log in</button>`);
  o.querySelector('[data-go="signup"]').onclick = showSignUp;
  o.querySelector('[data-go="login"]').onclick = () => showLogIn();
}
function authError(o, msg) { const e = o.querySelector(".autherr"); e.textContent = msg; e.hidden = !msg; }
function friendlyAuthError(e) {
  const m = (e && e.message || "").toLowerCase();
  if (m.includes("invalid login")) return "That email and password don't match. Check them and try again.";
  if (m.includes("already registered") || m.includes("already been registered")) return "There's already an account with that email. Log in instead.";
  if (m.includes("email not confirmed")) return "Confirm your email first. Check your inbox for the link we sent.";
  if (m.includes("password")) return "Passwords need at least 8 characters.";
  if (m.includes("rate") || m.includes("too many")) return "Too many tries. Wait a minute, then try again.";
  if (m.includes("fetch") || m.includes("network")) return "Couldn't reach Selah. Check your connection.";
  return e && e.message ? e.message : "Something went wrong. Please try again.";
}
function showSignUp() {
  const o = authShell(`<button class="back" data-back>${ICON.back}Back</button>
    <h2>Create your account</h2>
    <form class="authform" id="suForm" novalidate>
      <label class="eyebrow" for="suName">Your name</label><input class="field" id="suName" autocomplete="name" maxlength="40" required>
      <label class="eyebrow" for="suUser">Username</label><input class="field" id="suUser" autocomplete="username" maxlength="24" autocapitalize="none" spellcheck="false" required>
      <small class="hint" id="suUserHint">3 to 24 letters, numbers, dots or underscores</small>
      <label class="eyebrow" for="suEmail">Email</label><input class="field" id="suEmail" type="email" autocomplete="email" required>
      <label class="eyebrow" for="suPass">Password</label><input class="field" id="suPass" type="password" autocomplete="new-password" minlength="8" required>
      <small class="hint">At least 8 characters</small>
      <label class="toggle"><input type="checkbox" id="suAge"> I'm 13 or older</label>
      <label class="toggle"><input type="checkbox" id="suRules"><span>I agree to the <button type="button" class="linkish" id="suReadRules">community guidelines</button></span></label>
      <p class="autherr" hidden></p>
      <button class="pill solid big" id="suGo">Create account</button>
    </form>`);
  o.querySelector("[data-back]").onclick = showAuth;
  o.querySelector("#suReadRules").onclick = openGuidelines;
  const user = o.querySelector("#suUser"), hint = o.querySelector("#suUserHint");
  let checkTimer = 0;
  user.oninput = () => {
    user.value = user.value.toLowerCase().replace(/[^a-z0-9_.]/g, "");
    clearTimeout(checkTimer);
    if (user.value.length < 3) { hint.textContent = "3 to 24 letters, numbers, dots or underscores"; hint.className = "hint"; return; }
    checkTimer = setTimeout(async () => {
      const { data } = await sb.rpc("username_available", { u: user.value });
      hint.textContent = data ? `@${user.value} is available` : `@${user.value} is taken`;
      hint.className = "hint " + (data ? "good" : "bad");
    }, 350);
  };
  o.querySelector("#suForm").onsubmit = async e => {
    e.preventDefault();
    const name = o.querySelector("#suName").value.trim(), username = user.value, email = o.querySelector("#suEmail").value.trim(), password = o.querySelector("#suPass").value;
    if (!name) return authError(o, "Enter your name.");
    if (!/^[a-z0-9_.]{3,24}$/.test(username)) return authError(o, "Pick a username of 3 to 24 letters, numbers, dots or underscores.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError(o, "Enter a valid email address.");
    if (password.length < 8) return authError(o, "Passwords need at least 8 characters.");
    if (!o.querySelector("#suAge").checked) return authError(o, "You need to be 13 or older to use Selah.");
    if (!o.querySelector("#suRules").checked) return authError(o, "Please agree to the community guidelines.");
    const btn = o.querySelector("#suGo"); btn.disabled = true; btn.textContent = "Creating your account…"; authError(o, "");
    const { data: free } = await sb.rpc("username_available", { u: username });
    if (free === false) { btn.disabled = false; btn.textContent = "Create account"; return authError(o, `@${username} is taken. Try another username.`); }
    const { data, error } = await sb.auth.signUp({ email, password, options: {
      data: { name, username, age_confirmed: true, guidelines_accepted: new Date().toISOString() },
      emailRedirectTo: SELAH_CONFIG.siteUrl || location.origin + location.pathname } });
    if (error) { btn.disabled = false; btn.textContent = "Create account"; return authError(o, friendlyAuthError(error)); }
    if (data.session) return enterApp(data.user);
    authShell(`<div class="authhero"><span class="okicon">✓</span><h2>Check your email</h2>
      <p>We sent a link to <b>${esc(email)}</b>. Tap it to confirm your account, then come back and log in.</p></div>
      <button class="pill solid big" id="ceLogin">Log in</button>`).querySelector("#ceLogin").onclick = () => showLogIn(email);
  };
}
function showLogIn(email = "") {
  const o = authShell(`<button class="back" data-back>${ICON.back}Back</button>
    <h2>Welcome back</h2>
    <form class="authform" id="liForm" novalidate>
      <label class="eyebrow" for="liEmail">Email</label><input class="field" id="liEmail" type="email" autocomplete="email" value="${esc(email)}" required>
      <label class="eyebrow" for="liPass">Password</label><input class="field" id="liPass" type="password" autocomplete="current-password" required>
      <p class="autherr" hidden></p>
      <button class="pill solid big" id="liGo">Log in</button>
      <button type="button" class="linkish" id="liForgot" style="align-self:center">Forgot your password?</button>
    </form>`);
  o.querySelector("[data-back]").onclick = showAuth;
  o.querySelector("#liForm").onsubmit = async e => {
    e.preventDefault();
    const btn = o.querySelector("#liGo"); btn.disabled = true; btn.textContent = "Logging in…"; authError(o, "");
    const { data, error } = await sb.auth.signInWithPassword({ email: o.querySelector("#liEmail").value.trim(), password: o.querySelector("#liPass").value });
    if (error) { btn.disabled = false; btn.textContent = "Log in"; return authError(o, friendlyAuthError(error)); }
    enterApp(data.user);
  };
  o.querySelector("#liForgot").onclick = async () => {
    const em = o.querySelector("#liEmail").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(em)) return authError(o, "Enter your email above first, then tap “Forgot your password?” again.");
    const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: SELAH_CONFIG.siteUrl || location.origin + location.pathname });
    if (error) return authError(o, friendlyAuthError(error));
    authError(o, ""); toast("Check your email for a link to reset your password");
  };
}
function openNewPassword() {
  const o = sheet(`<h3>Choose a new password</h3>
    <label class="eyebrow" for="npPass">New password</label><input class="field" id="npPass" type="password" autocomplete="new-password" minlength="8">
    <small class="hint">At least 8 characters</small>
    <button class="pill solid big" id="npGo">Save password</button>`);
  o.querySelector("#npGo").onclick = async () => {
    const pw = o.querySelector("#npPass").value;
    if (pw.length < 8) return toast("Passwords need at least 8 characters");
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) return toast(friendlyAuthError(error));
    o.remove(); toast("Password updated");
  };
}
async function liveLogout() {
  await disablePush(true); // this device stops getting this account's notifications
  await sb.auth.signOut();
  Object.keys(PEOPLE).forEach(k => { if (k !== "me" && k.length > 20) delete PEOPLE[k]; });
}
function openDeleteAccount() {
  const o = sheet(`<h3>Delete your account?</h3>
    <p style="margin:0;color:var(--muted)">This permanently deletes your profile, posts, comments, stories, messages, prayer requests and photos. It can't be undone.</p>
    <label class="eyebrow" for="daConfirm">Type DELETE to confirm</label><input class="field" id="daConfirm" autocomplete="off" autocapitalize="characters">
    <div class="row"><button class="pill" data-no style="flex:1;justify-content:center;padding:12px">Cancel</button><button class="pill solid dangerbtn" data-yes style="flex:1;justify-content:center;padding:12px">Delete account</button></div>`);
  o.querySelector("[data-no]").onclick = () => o.remove();
  o.querySelector("[data-yes]").onclick = async () => {
    if (o.querySelector("#daConfirm").value.trim().toUpperCase() !== "DELETE") return toast("Type DELETE to confirm");
    const btn = o.querySelector("[data-yes]"); btn.disabled = true; btn.textContent = "Deleting…";
    // photos first (the database can't remove files), then everything else
    for (const bucket of ["avatars", "media", "glass"]) {
      const { data } = await sb.storage.from(bucket).list(ME, { limit: 1000 });
      if (data && data.length) await sb.storage.from(bucket).remove(data.map(f => `${ME}/${f.name}`));
    }
    const { error } = await sb.rpc("delete_my_account");
    if (error) { btn.disabled = false; btn.textContent = "Delete account"; return toast("Couldn't delete your account. Please try again."); }
    try { localStorage.removeItem("selah-live-" + ME); } catch (e) {}
    o.remove();
    await sb.auth.signOut();
    toast("Your account has been deleted");
  };
}

// ---------- push notifications ----------
// iPhone and Android use Capacitor's push plugin; the web version uses the browser's Web Push.
// Whether this device wants notifications is remembered on the device, not the account.
const PUSH_KEY = "selah-push", PUSH_ASKED = "selah-push-asked";
let pushListening = false, pendingPushOpen = null;
const devicePref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
const nativePush = () => window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.PushNotifications;
const webPushReady = () => !!(SELAH_CONFIG.vapidPublicKey && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
const isIOSBrowser = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.navigator.standalone && !nativePush();

// on | off | blocked | install (iPhone browser: add to Home Screen first) | unsupported
async function pushStatus() {
  const P = nativePush();
  if (P) {
    const perm = await P.checkPermissions();
    if (perm.receive === "denied") return "blocked";
    return perm.receive === "granted" && devicePref(PUSH_KEY) === "on" ? "on" : "off";
  }
  if (isIOSBrowser()) return "install";
  if (!webPushReady()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

async function enablePush() {
  const P = nativePush();
  try {
    if (P) {
      let perm = await P.checkPermissions();
      if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await P.requestPermissions();
      if (perm.receive !== "granted") return "blocked";
      devicePref(PUSH_KEY, "on");
      await P.register(); // the token arrives in the "registration" listener
      return "on";
    }
    if (!webPushReady()) return isIOSBrowser() ? "install" : "unsupported";
    if (await Notification.requestPermission() !== "granted") return "blocked";
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: b64ToBytes(SELAH_CONFIG.vapidPublicKey) });
    const token = JSON.stringify(sub);
    devicePref(PUSH_KEY + "-token", token);
    const { error } = await sb.rpc("register_push", { device_platform: "web", device_token: token });
    if (error) throw error;
    devicePref(PUSH_KEY, "on");
    return "on";
  } catch (e) { console.warn("push", e); toast("Couldn't turn on notifications. Please try again."); return "off"; }
}

async function disablePush(keepPreference) {
  const token = devicePref(PUSH_KEY + "-token");
  try {
    if (token && ME) await sb.rpc("unregister_push", { device_token: token });
    const P = nativePush();
    if (P) await P.unregister();
    else if (webPushReady()) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub && !keepPreference) await sub.unsubscribe();
    }
  } catch (e) { console.warn("push off", e); }
  if (!keepPreference) devicePref(PUSH_KEY, "off");
}

function b64ToBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// Set up once at start: receive this phone's token, and handle taps on notifications
// (including the tap that launched the app).
function listenForPushTaps() {
  if (pushListening) return;
  pushListening = true;
  const P = nativePush();
  if (P) {
    P.addListener("registration", async t => {
      devicePref(PUSH_KEY + "-token", t.value);
      if (ME) await sb.rpc("register_push", { device_platform: Capacitor.getPlatform(), device_token: t.value });
    });
    P.addListener("registrationError", e => console.warn("push registration", e));
    P.addListener("pushNotificationActionPerformed", a => openFromPush(a.notification && a.notification.data));
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "push-open") openFromPush(e.data.data); });
  }
  // the web version opened from a notification while it was closed
  const q = new URLSearchParams(location.search).get("push");
  if (q) {
    try { openFromPush(JSON.parse(q)); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.hash);
  }
}

function openFromPush(data) {
  if (!data || !data.type) return;
  if (!liveReady) { pendingPushOpen = data; return; }
  const n = S.notifs.find(x => String(x.id) === String(data.notification_id)) ||
    { type: data.type, from: pid(data.actor), postId: data.post_id ? Number(data.post_id) : undefined };
  openNotif(n);
  updateBell();
}

// After logging in: keep this device registered if notifications are on, open a tapped
// notification, and the first time, offer to turn notifications on.
async function afterLoginPush() {
  if (pendingPushOpen) { const d = pendingPushOpen; pendingPushOpen = null; openFromPush(d); }
  const status = await pushStatus().catch(() => "unsupported");
  if (status === "on") { const P = nativePush(); if (P) P.register(); else enablePush(); return; }
  if (status !== "off" || devicePref(PUSH_ASKED)) return;
  setTimeout(() => {
    if (!liveReady || document.querySelector(".ov")) return; // don't interrupt
    devicePref(PUSH_ASKED, "1");
    const o = sheet(`<div class="pushask"><span class="okicon" aria-hidden="true">${ICON.bell}</span>
        <h3>Know when friends reach out</h3>
        <p>Get a notification when someone messages you, sends a Looking Glass, prays for you or comments on your posts. You can change this any time in Settings.</p></div>
      <button class="pill solid big" data-yes>Turn on notifications</button>
      <button class="pill big" data-no>Not now</button>`);
    o.querySelector("[data-no]").onclick = () => o.remove();
    o.querySelector("[data-yes]").onclick = async () => {
      o.remove();
      const r = await enablePush();
      if (r === "on") toast("Notifications are on");
      else if (r === "blocked") toast("Notifications are blocked. You can allow them in your phone's settings.");
    };
  }, 2500);
}

// The "Push notifications" row in Settings
async function drawPushRow(row) {
  const st = await pushStatus().catch(() => "unsupported");
  const text = {
    on: "On for this device",
    off: "Get notified even when Selah is closed",
    blocked: "Blocked in this device's settings. Allow notifications for Selah there, then come back.",
    install: "On iPhone, first add Selah to your Home Screen: tap Share, then Add to Home Screen.",
    unsupported: "This browser can't show notifications."
  }[st];
  row.innerHTML = `<div class="m"><b>Push notifications</b><small>${text}</small></div>
    ${st === "on" || st === "off" ? `<input type="checkbox" role="switch" class="switch" id="pushSwitch" aria-label="Push notifications" ${st === "on" ? "checked" : ""}>` : ""}`;
  const sw = row.querySelector("#pushSwitch");
  if (sw) sw.onchange = async () => {
    sw.disabled = true;
    if (sw.checked) {
      const r = await enablePush();
      if (r === "on") toast("Notifications are on");
    } else { await disablePush(false); toast("Notifications are off for this device"); }
    drawPushRow(row);
  };
}
