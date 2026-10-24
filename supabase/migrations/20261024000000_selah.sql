-- Selah database: accounts, friends, posts, stories, Looking Glass, messages,
-- groups, prayer wall, notifications, reports and blocks.
-- Every table has row level security, so people only ever see what they're allowed to.

-------------------------------------------------------------------------------
-- People
-------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,24}$'),
  name text not null check (char_length(name) between 1 and 40),
  church text not null default '' check (char_length(church) <= 40),
  avatar_url text check (char_length(avatar_url) <= 500),
  created_at timestamptz not null default now()
);

-- Personal settings and Bible progress (highlights, reading plan, theme...), one row per person.
create table public.user_state (
  user_id uuid primary key references public.profiles on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.blocks (
  blocker uuid not null references public.profiles on delete cascade,
  blocked uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

create table public.friendships (
  requester uuid not null references public.profiles on delete cascade,
  addressee uuid not null references public.profiles on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
create unique index friendships_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));

-- Helpers used by the security rules. They only ever compare against the signed-in person.
create function public.is_blocked_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from blocks
    where (blocker = auth.uid() and blocked = other) or (blocker = other and blocked = auth.uid()));
$$;

create function public.is_friend(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships where status = 'accepted'
    and ((requester = auth.uid() and addressee = other) or (requester = other and addressee = auth.uid())));
$$;

-- Your own things, or things from friends you haven't blocked (and who haven't blocked you).
create function public.can_see_from(author uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select author = auth.uid() or (not is_blocked_with(author) and is_friend(author));
$$;

-------------------------------------------------------------------------------
-- Groups and events
-------------------------------------------------------------------------------
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 60),
  about text not null default '' check (char_length(about) <= 500),
  meets text not null default '' check (char_length(meets) <= 60),
  art text not null default 'sea' check (char_length(art) <= 20),
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups on delete cascade,
  title text not null check (char_length(title) between 2 and 80),
  starts_at timestamptz not null,
  place text not null default '' check (char_length(place) <= 80),
  created_at timestamptz not null default now()
);

create table public.event_rsvps (
  event_id uuid not null references public.events on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  primary key (event_id, user_id)
);

create function public.is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members where group_id = gid and user_id = auth.uid());
$$;

create function public.is_group_admin(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members where group_id = gid and user_id = auth.uid() and role = 'admin');
$$;

-------------------------------------------------------------------------------
-- Posts, reactions, comments
-------------------------------------------------------------------------------
create table public.posts (
  id bigint generated always as identity primary key,
  author uuid not null default auth.uid() references public.profiles on delete cascade,
  group_id uuid references public.groups on delete cascade,
  caption text not null default '' check (char_length(caption) <= 2000),
  art text check (char_length(art) <= 20),
  image_url text check (char_length(image_url) <= 500),
  verse_text text check (char_length(verse_text) <= 2000),
  verse_ref text check (char_length(verse_ref) <= 80),
  created_at timestamptz not null default now()
);
create index posts_created on public.posts (created_at desc);

-- Group posts are visible to everyone signed in; other posts only to friends.
create function public.can_see_post(pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from posts p where p.id = pid and (p.author = auth.uid()
    or (not is_blocked_with(p.author) and (p.group_id is not null or is_friend(p.author)))));
$$;

create table public.post_reactions (
  post_id bigint not null references public.posts on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  kind text not null check (kind in ('like', 'pray')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);

create table public.comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts on delete cascade,
  author uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index comments_post on public.comments (post_id, created_at);

-------------------------------------------------------------------------------
-- Stories (24 hours) and Looking Glass (opens once)
-------------------------------------------------------------------------------
create table public.stories (
  id bigint generated always as identity primary key,
  author uuid not null default auth.uid() references public.profiles on delete cascade,
  art text check (char_length(art) <= 20),
  image_url text check (char_length(image_url) <= 500),
  caption text check (char_length(caption) <= 200),
  verse_text text check (char_length(verse_text) <= 2000),
  verse_ref text check (char_length(verse_ref) <= 80),
  created_at timestamptz not null default now()
);
create index stories_recent on public.stories (created_at desc);

create table public.story_views (
  story_id bigint not null references public.stories on delete cascade,
  viewer uuid not null default auth.uid() references public.profiles on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer)
);

create table public.glasses (
  id bigint generated always as identity primary key,
  sender uuid not null default auth.uid() references public.profiles on delete cascade,
  recipient uuid not null references public.profiles on delete cascade,
  art text check (char_length(art) <= 20),
  image_path text check (char_length(image_path) <= 300),
  caption text check (char_length(caption) <= 200),
  verse_text text check (char_length(verse_text) <= 2000),
  verse_ref text check (char_length(verse_ref) <= 80),
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  check (sender <> recipient)
);
create index glasses_people on public.glasses (recipient, sender, created_at);

-------------------------------------------------------------------------------
-- Direct messages
-------------------------------------------------------------------------------
create table public.messages (
  id bigint generated always as identity primary key,
  sender uuid not null default auth.uid() references public.profiles on delete cascade,
  recipient uuid not null references public.profiles on delete cascade,
  kind text not null default 'text' check (kind in ('text', 'verse', 'share')),
  body text not null check (char_length(body) between 1 and 2000),
  ref text check (char_length(ref) <= 80),
  art text check (char_length(art) <= 20),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender <> recipient)
);
create index messages_people on public.messages (sender, recipient, created_at);
create index messages_inbox on public.messages (recipient, read_at);

-------------------------------------------------------------------------------
-- Prayer wall
-------------------------------------------------------------------------------
create table public.prayers (
  id bigint generated always as identity primary key,
  author uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table public.prayer_marks (
  prayer_id bigint not null references public.prayers on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (prayer_id, user_id)
);

-------------------------------------------------------------------------------
-- Notifications, reports
-------------------------------------------------------------------------------
create table public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  actor uuid not null references public.profiles on delete cascade,
  type text not null check (type in ('like', 'pray', 'comment', 'message', 'glass', 'friend_request', 'friend_accept', 'prayed')),
  post_id bigint references public.posts on delete cascade,
  body text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_inbox on public.notifications (user_id, created_at desc);

-- Reports go to your team. Review them in the Supabase dashboard (Table Editor > reports).
create table public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null default auth.uid() references public.profiles on delete cascade,
  reported_user uuid references public.profiles on delete set null,
  kind text not null check (kind in ('post', 'comment', 'story', 'glass', 'message', 'prayer', 'account')),
  reason text not null check (reason in ('spam', 'bully', 'hate', 'sexual', 'violence', 'selfharm', 'false', 'other')),
  details text not null default '' check (char_length(details) <= 500),
  content text not null default '' check (char_length(content) <= 2000),
  post_id bigint,
  comment_id bigint,
  prayer_id bigint,
  status text not null default 'open' check (status in ('open', 'reviewed', 'action_taken')),
  created_at timestamptz not null default now()
);

-------------------------------------------------------------------------------
-- Security rules
-------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_state enable row level security;
alter table public.blocks enable row level security;
alter table public.friendships enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;
alter table public.posts enable row level security;
alter table public.post_reactions enable row level security;
alter table public.comments enable row level security;
alter table public.stories enable row level security;
alter table public.story_views enable row level security;
alter table public.glasses enable row level security;
alter table public.messages enable row level security;
alter table public.prayers enable row level security;
alter table public.prayer_marks enable row level security;
alter table public.notifications enable row level security;
alter table public.reports enable row level security;

-- profiles: anyone signed in can find people, except people who blocked them
create function public.has_blocked_me(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from blocks where blocker = other and blocked = auth.uid());
$$;
create policy "see profiles" on public.profiles for select to authenticated using (not has_blocked_me(id));
create policy "edit own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "own state" on public.user_state for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "see own blocks" on public.blocks for select to authenticated using (blocker = auth.uid());
create policy "block" on public.blocks for insert to authenticated with check (blocker = auth.uid());
create policy "unblock" on public.blocks for delete to authenticated using (blocker = auth.uid());

create policy "see own friendships" on public.friendships for select to authenticated
  using (auth.uid() in (requester, addressee));
create policy "send friend request" on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending' and not is_blocked_with(addressee));
create policy "accept friend request" on public.friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "remove friendship" on public.friendships for delete to authenticated
  using (auth.uid() in (requester, addressee));

create policy "see groups" on public.groups for select to authenticated using (true);
create policy "create group" on public.groups for insert to authenticated with check (created_by = auth.uid());
create policy "admins edit group" on public.groups for update to authenticated using (is_group_admin(id));
create policy "admins delete group" on public.groups for delete to authenticated using (is_group_admin(id));

create policy "see members" on public.group_members for select to authenticated using (true);
create policy "join group" on public.group_members for insert to authenticated
  with check (user_id = auth.uid() and role = 'member');
create policy "leave or remove" on public.group_members for delete to authenticated
  using (user_id = auth.uid() or is_group_admin(group_id));

create policy "see events" on public.events for select to authenticated using (true);
create policy "admins add events" on public.events for insert to authenticated with check (is_group_admin(group_id));
create policy "admins edit events" on public.events for update to authenticated using (is_group_admin(group_id));
create policy "admins delete events" on public.events for delete to authenticated using (is_group_admin(group_id));

create policy "see rsvps" on public.event_rsvps for select to authenticated using (true);
create policy "rsvp" on public.event_rsvps for insert to authenticated
  with check (user_id = auth.uid() and is_group_member((select group_id from events e where e.id = event_id)));
create policy "cancel rsvp" on public.event_rsvps for delete to authenticated using (user_id = auth.uid());

create policy "see posts" on public.posts for select to authenticated
  using (author = auth.uid() or (not is_blocked_with(author) and (group_id is not null or is_friend(author))));
create policy "create post" on public.posts for insert to authenticated
  with check (author = auth.uid() and (group_id is null or is_group_member(group_id)));
create policy "delete own post" on public.posts for delete to authenticated using (author = auth.uid());

create policy "see reactions" on public.post_reactions for select to authenticated using (can_see_post(post_id));
create policy "react" on public.post_reactions for insert to authenticated
  with check (user_id = auth.uid() and can_see_post(post_id));
create policy "unreact" on public.post_reactions for delete to authenticated using (user_id = auth.uid());

create policy "see comments" on public.comments for select to authenticated
  using (can_see_post(post_id) and not is_blocked_with(author));
create policy "comment" on public.comments for insert to authenticated
  with check (author = auth.uid() and can_see_post(post_id));
create policy "delete comment" on public.comments for delete to authenticated
  using (author = auth.uid() or exists (select 1 from posts p where p.id = post_id and p.author = auth.uid()));

create policy "see recent stories" on public.stories for select to authenticated
  using (created_at > now() - interval '24 hours' and can_see_from(author));
create policy "add story" on public.stories for insert to authenticated with check (author = auth.uid());
create policy "delete own story" on public.stories for delete to authenticated using (author = auth.uid());

create policy "see story views" on public.story_views for select to authenticated
  using (viewer = auth.uid() or exists (select 1 from stories s where s.id = story_id and s.author = auth.uid()));
create policy "view story" on public.story_views for insert to authenticated with check (viewer = auth.uid());

-- Looking Glass: people can list theirs, but the photo and words only come through open_glass(), once.
create policy "see own glasses" on public.glasses for select to authenticated using (auth.uid() in (sender, recipient));
create policy "send glass" on public.glasses for insert to authenticated
  with check (sender = auth.uid() and is_friend(recipient) and not is_blocked_with(recipient));
revoke select on public.glasses from anon, authenticated;
grant select (id, sender, recipient, created_at, opened_at) on public.glasses to authenticated;

create policy "see own messages" on public.messages for select to authenticated using (auth.uid() in (sender, recipient));
create policy "send message" on public.messages for insert to authenticated
  with check (sender = auth.uid() and is_friend(recipient) and not is_blocked_with(recipient));

create policy "see prayers" on public.prayers for select to authenticated using (can_see_from(author));
create policy "add prayer" on public.prayers for insert to authenticated with check (author = auth.uid());
create policy "delete own prayer" on public.prayers for delete to authenticated using (author = auth.uid());

create policy "see prayer marks" on public.prayer_marks for select to authenticated
  using (exists (select 1 from prayers p where p.id = prayer_id));
create policy "mark prayed" on public.prayer_marks for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from prayers p where p.id = prayer_id));
create policy "unmark prayed" on public.prayer_marks for delete to authenticated using (user_id = auth.uid());

create policy "own notifications" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "read notifications" on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "clear notifications" on public.notifications for delete to authenticated using (user_id = auth.uid());

create policy "send report" on public.reports for insert to authenticated with check (reporter = auth.uid());
create policy "see own reports" on public.reports for select to authenticated using (reporter = auth.uid());

-------------------------------------------------------------------------------
-- Functions the app calls
-------------------------------------------------------------------------------
create function public.username_available(u text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where username = lower(u));
$$;

-- Opens a Looking Glass once: returns its contents and wipes the words from the database.
create function public.open_glass(gid bigint)
returns table (id bigint, sender uuid, art text, image_path text, caption text, verse_text text, verse_ref text)
language plpgsql security definer set search_path = public as $$
declare g glasses;
begin
  select * into g from glasses where glasses.id = gid and recipient = auth.uid() and opened_at is null for update;
  if not found then return; end if;
  update glasses set opened_at = now(), art = null, caption = null, verse_text = null, verse_ref = null where glasses.id = gid;
  return query select g.id, g.sender, g.art, g.image_path, g.caption, g.verse_text, g.verse_ref;
end;
$$;

-- Looking Glass streaks: days in a row that you and a friend both sent each other one.
create function public.glass_streaks() returns table (friend uuid, days int)
language sql stable security definer set search_path = public as $$
  with days as (
    select case when sender = auth.uid() then recipient else sender end as friend,
           (created_at at time zone 'utc')::date as d,
           bool_or(sender = auth.uid()) as i_sent, bool_or(recipient = auth.uid()) as they_sent
    from glasses where auth.uid() in (sender, recipient) and created_at > now() - interval '400 days'
    group by 1, 2
  ), both_sent as (
    select friend, d, d - (row_number() over (partition by friend order by d))::int as run from days where i_sent and they_sent
  ), latest as (
    select distinct on (friend) friend, run, d from both_sent order by friend, d desc
  )
  select b.friend, count(*)::int from both_sent b join latest l on l.friend = b.friend and l.run = b.run
  where l.d >= (now() at time zone 'utc')::date - 1
  group by b.friend;
$$;

create function public.mark_thread_read(friend uuid) returns void
language sql security definer set search_path = public as $$
  update messages set read_at = now() where recipient = auth.uid() and sender = friend and read_at is null;
$$;

-- Deletes your account and everything you've posted. Required by the App Store and Google Play.
create function public.delete_my_account() returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.users where id = auth.uid();
$$;

revoke execute on function public.delete_my_account() from public, anon;
revoke execute on function public.open_glass(bigint) from public, anon;
revoke execute on function public.glass_streaks() from public, anon;
revoke execute on function public.mark_thread_read(uuid) from public, anon;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.open_glass(bigint) to authenticated;
grant execute on function public.glass_streaks() to authenticated;
grant execute on function public.mark_thread_read(uuid) to authenticated;

-------------------------------------------------------------------------------
-- Automatic work
-------------------------------------------------------------------------------
-- A profile is created from the name and username given at sign-up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username, name)
  values (new.id, lower(new.raw_user_meta_data->>'username'),
          coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), 'New member'));
  insert into user_state (user_id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Whoever creates a group becomes its admin.
create function public.handle_new_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into group_members (group_id, user_id, role) values (new.id, new.created_by, 'admin');
  return new;
end;
$$;
create trigger on_group_created after insert on public.groups
  for each row when (new.created_by is not null) execute function public.handle_new_group();

-- Blocking someone also ends the friendship.
create function public.handle_block() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from friendships where (requester = new.blocker and addressee = new.blocked)
                             or (requester = new.blocked and addressee = new.blocker);
  return new;
end;
$$;
create trigger on_block after insert on public.blocks for each row execute function public.handle_block();

-- Notifications
create function public.add_notification(target uuid, who uuid, kind text, post bigint, words text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if target is null or target = who then return; end if;
  if exists (select 1 from blocks where (blocker = target and blocked = who) or (blocker = who and blocked = target)) then return; end if;
  insert into notifications (user_id, actor, type, post_id, body) values (target, who, kind, post, left(words, 140));
end;
$$;
revoke execute on function public.add_notification(uuid, uuid, text, bigint, text) from public, anon, authenticated;

create function public.notify_reaction() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform add_notification((select author from posts where id = new.post_id), new.user_id, new.kind, new.post_id,
                           (select caption from posts where id = new.post_id));
  return new;
end;
$$;
create trigger on_reaction after insert on public.post_reactions for each row execute function public.notify_reaction();

create function public.notify_comment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform add_notification((select author from posts where id = new.post_id), new.author, 'comment', new.post_id, new.body);
  return new;
end;
$$;
create trigger on_comment after insert on public.comments for each row execute function public.notify_comment();

create function public.notify_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform add_notification(new.recipient, new.sender, 'message', null,
    case new.kind when 'verse' then new.ref when 'share' then 'Shared a post' else new.body end);
  return new;
end;
$$;
create trigger on_message after insert on public.messages for each row execute function public.notify_message();

create function public.notify_glass() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform add_notification(new.recipient, new.sender, 'glass', null, null);
  return new;
end;
$$;
create trigger on_glass after insert on public.glasses for each row execute function public.notify_glass();

create function public.notify_friendship() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform add_notification(new.addressee, new.requester, 'friend_request', null, null);
  elsif new.status = 'accepted' and old.status = 'pending' then
    perform add_notification(new.requester, new.addressee, 'friend_accept', null, null);
  end if;
  return new;
end;
$$;
create trigger on_friendship after insert or update on public.friendships for each row execute function public.notify_friendship();

create function public.notify_prayed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform add_notification((select author from prayers where id = new.prayer_id), new.user_id, 'prayed', null,
                           (select body from prayers where id = new.prayer_id));
  return new;
end;
$$;
create trigger on_prayed after insert on public.prayer_marks for each row execute function public.notify_prayed();

-- Live updates for new messages and notifications
alter publication supabase_realtime add table public.messages, public.notifications;

-------------------------------------------------------------------------------
-- Photo storage
-------------------------------------------------------------------------------
-- avatars and media: public links, but people can only upload into their own folder.
-- glass: private. Only the sender, or the recipient for a few minutes after opening, can load the photo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp']),
  ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('glass', 'glass', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "upload to own folder" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars', 'media', 'glass') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replace own files" on storage.objects for update to authenticated
  using (bucket_id in ('avatars', 'media') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own files" on storage.objects for delete to authenticated
  using (bucket_id in ('avatars', 'media', 'glass') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "list own files" on storage.objects for select to authenticated
  using (bucket_id in ('avatars', 'media') and (storage.foldername(name))[1] = auth.uid()::text);

create function public.can_load_glass(path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from glasses g where g.image_path = path and g.recipient = auth.uid()
    and g.opened_at is not null and g.opened_at > now() - interval '5 minutes');
$$;
create policy "load glass photo" on storage.objects for select to authenticated
  using (bucket_id = 'glass' and ((storage.foldername(name))[1] = auth.uid()::text or can_load_glass(name)));
create policy "recipient removes opened glass photo" on storage.objects for delete to authenticated
  using (bucket_id = 'glass' and can_load_glass(name));
