-- Churches: Selah hosts many churches, and each one is its own private space.
-- The feed, prayer wall, groups and events belong to one church and only its members see them.
-- People join with an invite code. Church admins approve members, manage roles and handle reports.
-- Friendships, messages, stories and Looking Glasses stay personal and can cross churches.

-------------------------------------------------------------------------------
-- Churches and members
-------------------------------------------------------------------------------
create table public.churches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  city text not null default '' check (char_length(city) <= 80),
  invite_code text not null unique,
  requires_approval boolean not null default false,
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);

-- status: active members see everything; pending ones wait for an admin; removed ones can't rejoin.
create table public.church_members (
  church_id uuid not null references public.churches on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin', 'owner')),
  status text not null default 'active' check (status in ('pending', 'active', 'removed')),
  joined_at timestamptz not null default now(),
  primary key (church_id, user_id)
);
create index church_members_user on public.church_members (user_id);

-- 8 letters and digits, leaving out ones that are easy to mix up (0/O, 1/I).
create function public.new_invite_code() returns text
language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + get_byte(gen_random_bytes(1), 0) % 32, 1);
    end loop;
    exit when not exists (select 1 from churches where invite_code = code);
  end loop;
  return code;
end;
$$;

create function public.is_church_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from church_members where church_id = cid and user_id = auth.uid() and status = 'active');
$$;

create function public.is_church_admin(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from church_members where church_id = cid and user_id = auth.uid()
                 and status = 'active' and role in ('admin', 'owner'));
$$;

create function public.church_role(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from church_members where church_id = cid and user_id = auth.uid() and status = 'active';
$$;

-- Who you can see at all: yourself, people in one of your churches (admins also see people waiting
-- to join), friends, people you have a friend request with, and people you've blocked.
create function public.can_see_person(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select other = auth.uid()
    or exists (select 1 from friendships where (requester = auth.uid() and addressee = other) or (requester = other and addressee = auth.uid()))
    or exists (select 1 from blocks where blocker = auth.uid() and blocked = other)
    or exists (select 1 from church_members me join church_members them on them.church_id = me.church_id
               where me.user_id = auth.uid() and me.status = 'active' and them.user_id = other
                 and (them.status = 'active' or (them.status = 'pending' and me.role in ('admin', 'owner'))));
$$;

alter table public.churches enable row level security;
alter table public.church_members enable row level security;

create policy "see your churches" on public.churches for select to authenticated
  using (exists (select 1 from church_members m where m.church_id = id and m.user_id = auth.uid() and m.status <> 'removed'));
create policy "admins edit church" on public.churches for update to authenticated
  using (is_church_admin(id)) with check (is_church_admin(id));
revoke update on public.churches from anon, authenticated;
grant update (name, city, requires_approval) on public.churches to authenticated;

create policy "see church members" on public.church_members for select to authenticated
  using (user_id = auth.uid() or (status = 'active' and is_church_member(church_id)) or is_church_admin(church_id));

-------------------------------------------------------------------------------
-- What churches people can do (all checks happen here, not in the app)
-------------------------------------------------------------------------------
create function public.create_church(church_name text, church_city text default '', approval boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into churches (name, city, requires_approval, created_by, invite_code)
  values (trim(church_name), trim(coalesce(church_city, '')), coalesce(approval, false), auth.uid(), new_invite_code())
  returning id into cid;
  insert into church_members (church_id, user_id, role, status) values (cid, auth.uid(), 'owner', 'active');
  return cid;
end;
$$;

-- Invite codes are typed by people, so ignore spaces, dashes and lower case.
create function public.clean_code(code text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- Shows which church a code belongs to before joining.
create function public.church_preview(code text)
returns table (id uuid, name text, city text, requires_approval boolean, members int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.city, c.requires_approval,
         (select count(*)::int from church_members m where m.church_id = c.id and m.status = 'active')
  from churches c where c.invite_code = clean_code(code) and auth.uid() is not null;
$$;

-- Returns 'active', 'pending' (waiting for an admin) or raises a readable error.
create function public.join_church(code text) returns text
language plpgsql security definer set search_path = public as $$
declare c churches; existing church_members;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into c from churches where invite_code = clean_code(code);
  if not found then raise exception 'That invite code didn''t match a church. Check it and try again.'; end if;
  select * into existing from church_members where church_id = c.id and user_id = auth.uid();
  if found then
    if existing.status = 'removed' then raise exception 'You can''t join this church. Contact its leaders if you think that''s a mistake.'; end if;
    return existing.status;
  end if;
  insert into church_members (church_id, user_id, role, status)
  values (c.id, auth.uid(), 'member', case when c.requires_approval then 'pending' else 'active' end);
  return case when c.requires_approval then 'pending' else 'active' end;
end;
$$;

create function public.approve_member(cid uuid, member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_church_admin(cid) then raise exception 'Only church admins can do that'; end if;
  update church_members set status = 'active', joined_at = now() where church_id = cid and user_id = member and status = 'pending';
end;
$$;

create function public.decline_member(cid uuid, member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_church_admin(cid) then raise exception 'Only church admins can do that'; end if;
  delete from church_members where church_id = cid and user_id = member and status = 'pending';
end;
$$;

-- Admins can make members admins and back. Only the owner can hand over ownership
-- (they become an admin).
create function public.set_member_role(cid uuid, member uuid, new_role text) returns void
language plpgsql security definer set search_path = public as $$
declare mine text := church_role(cid); theirs text;
begin
  select role into theirs from church_members where church_id = cid and user_id = member and status = 'active';
  if theirs is null then raise exception 'That person isn''t a member of this church'; end if;
  if member = auth.uid() then raise exception 'You can''t change your own role'; end if;
  if new_role = 'owner' then
    if mine <> 'owner' then raise exception 'Only the owner can hand over the church'; end if;
    update church_members set role = 'admin' where church_id = cid and user_id = auth.uid();
    update church_members set role = 'owner' where church_id = cid and user_id = member;
  elsif new_role in ('member', 'admin') then
    if mine is null or mine = 'member' then raise exception 'Only church admins can do that'; end if;
    if theirs = 'owner' then raise exception 'The owner''s role can''t be changed'; end if;
    if theirs = 'admin' and mine <> 'owner' then raise exception 'Only the owner can change another admin''s role'; end if;
    update church_members set role = new_role where church_id = cid and user_id = member;
  else
    raise exception 'Unknown role';
  end if;
end;
$$;

-- Removes someone from the church and its groups. They can't rejoin with the invite code.
create function public.remove_member(cid uuid, member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare mine text := church_role(cid); theirs text;
begin
  if mine is null or mine = 'member' then raise exception 'Only church admins can do that'; end if;
  select role into theirs from church_members where church_id = cid and user_id = member;
  if theirs is null then return; end if;
  if member = auth.uid() then raise exception 'To leave, use Leave church instead'; end if;
  if theirs = 'owner' or (theirs = 'admin' and mine <> 'owner') then raise exception 'You can''t remove this person'; end if;
  update church_members set status = 'removed', role = 'member' where church_id = cid and user_id = member;
  delete from group_members where user_id = member and group_id in (select id from groups where church_id = cid);
end;
$$;

-- Lets someone back in after being removed (they still need the invite code).
create function public.allow_back(cid uuid, member uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_church_admin(cid) then raise exception 'Only church admins can do that'; end if;
  delete from church_members where church_id = cid and user_id = member and status = 'removed';
end;
$$;

create function public.leave_church(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare mine text;
begin
  select role into mine from church_members where church_id = cid and user_id = auth.uid() and status <> 'removed';
  if mine is null then return; end if;
  if mine = 'owner' then
    if exists (select 1 from church_members where church_id = cid and user_id <> auth.uid() and status = 'active') then
      raise exception 'You''re the owner. Make someone else the owner first, or delete the church.';
    end if;
    delete from churches where id = cid; -- the last person leaving closes it
    return;
  end if;
  delete from group_members where user_id = auth.uid() and group_id in (select id from groups where church_id = cid);
  delete from church_members where church_id = cid and user_id = auth.uid();
end;
$$;

create function public.delete_church(cid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if church_role(cid) is distinct from 'owner' then raise exception 'Only the owner can delete the church'; end if;
  delete from churches where id = cid;
end;
$$;

create function public.new_church_code(cid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare code text := new_invite_code();
begin
  if not is_church_admin(cid) then raise exception 'Only church admins can do that'; end if;
  update churches set invite_code = code where id = cid;
  return code;
end;
$$;

-- The invite code is only for members to share, so it's read through this, not the table.
create function public.church_code(cid uuid) returns text
language sql stable security definer set search_path = public as $$
  select invite_code from churches where id = cid and is_church_member(cid);
$$;
revoke select on public.churches from anon, authenticated;
grant select (id, name, city, requires_approval, created_by, created_at) on public.churches to authenticated;

do $$
declare f text;
begin
  foreach f in array array['create_church(text,text,boolean)', 'church_preview(text)', 'join_church(text)',
    'approve_member(uuid,uuid)', 'decline_member(uuid,uuid)', 'set_member_role(uuid,uuid,text)', 'remove_member(uuid,uuid)',
    'allow_back(uuid,uuid)', 'leave_church(uuid)', 'delete_church(uuid)', 'new_church_code(uuid)', 'church_code(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-------------------------------------------------------------------------------
-- Posts, prayers and groups belong to a church
-------------------------------------------------------------------------------
alter table public.groups add column church_id uuid references public.churches on delete cascade;
alter table public.posts add column church_id uuid references public.churches on delete cascade;
alter table public.prayers add column church_id uuid references public.churches on delete cascade;
alter table public.reports add column church_id uuid references public.churches on delete set null;

create function public.group_church(gid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select church_id from groups where id = gid;
$$;

-- Existing data moves into a first church, owned by whoever signed up first. Rename it in the app
-- (Profile › your church › Church settings). With no accounts yet, the unowned starter groups are removed.
do $$
declare first_user uuid; cid uuid;
begin
  select id into first_user from profiles order by created_at limit 1;
  if first_user is null then
    delete from groups;
  else
    insert into churches (name, created_by, invite_code) values ('My Church', first_user, new_invite_code()) returning id into cid;
    insert into church_members (church_id, user_id, role, status)
      select cid, id, case when id = first_user then 'owner' else 'member' end, 'active' from profiles;
    update groups set church_id = cid;
    update posts set church_id = cid;
    update prayers set church_id = cid;
  end if;
end $$;

alter table public.groups alter column church_id set not null;
alter table public.posts alter column church_id set not null;
alter table public.prayers alter column church_id set not null;
create index posts_church on public.posts (church_id, created_at desc);
create index prayers_church on public.prayers (church_id, created_at desc);
create index groups_church on public.groups (church_id);

-- A group post always belongs to the group's church.
create function public.post_church() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.group_id is not null then new.church_id := group_church(new.group_id); end if;
  return new;
end;
$$;
create trigger before_post before insert on public.posts for each row execute function public.post_church();

-- Reports go to the admins of the church the content belongs to. Reports about messages,
-- stories, Looking Glasses or whole accounts aren't tied to one church and go to you, the app owner.
create function public.report_church() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.church_id := coalesce(
    (select church_id from posts where id = new.post_id),
    (select p.church_id from comments c join posts p on p.id = c.post_id where c.id = new.comment_id),
    (select church_id from prayers where id = new.prayer_id));
  return new;
end;
$$;
create trigger before_report before insert on public.reports for each row execute function public.report_church();

create function public.resolve_report(rid bigint, new_status text) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select church_id into cid from reports where id = rid;
  if cid is null or not is_church_admin(cid) then raise exception 'Only church admins can do that'; end if;
  if new_status not in ('open', 'reviewed', 'action_taken') then raise exception 'Unknown status'; end if;
  update reports set status = new_status where id = rid;
end;
$$;
revoke execute on function public.resolve_report(bigint, text) from public, anon;
grant execute on function public.resolve_report(bigint, text) to authenticated;

-------------------------------------------------------------------------------
-- Updated security rules
-------------------------------------------------------------------------------
drop policy "see profiles" on public.profiles;
create policy "see profiles" on public.profiles for select to authenticated
  using (not has_blocked_me(id) and can_see_person(id));

drop policy "send friend request" on public.friendships;
create policy "send friend request" on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'pending' and not is_blocked_with(addressee) and can_see_person(addressee));

create or replace function public.can_see_post(pid bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from posts p where p.id = pid
    and (p.author = auth.uid() or (not is_blocked_with(p.author) and is_church_member(p.church_id))));
$$;

drop policy "see posts" on public.posts;
drop policy "create post" on public.posts;
drop policy "delete own post" on public.posts;
create policy "see posts" on public.posts for select to authenticated
  using (author = auth.uid() or (not is_blocked_with(author) and is_church_member(church_id)));
create policy "create post" on public.posts for insert to authenticated
  with check (author = auth.uid() and is_church_member(church_id) and (group_id is null or is_group_member(group_id)));
create policy "delete post" on public.posts for delete to authenticated
  using (author = auth.uid() or is_church_admin(church_id));

drop policy "delete comment" on public.comments;
create policy "delete comment" on public.comments for delete to authenticated
  using (author = auth.uid() or exists (select 1 from posts p where p.id = post_id
    and (p.author = auth.uid() or is_church_admin(p.church_id))));

drop policy "see prayers" on public.prayers;
drop policy "add prayer" on public.prayers;
drop policy "delete own prayer" on public.prayers;
create policy "see prayers" on public.prayers for select to authenticated
  using (author = auth.uid() or (not is_blocked_with(author) and is_church_member(church_id)));
create policy "add prayer" on public.prayers for insert to authenticated
  with check (author = auth.uid() and is_church_member(church_id));
create policy "delete prayer" on public.prayers for delete to authenticated
  using (author = auth.uid() or is_church_admin(church_id));

drop policy "see groups" on public.groups;
drop policy "create group" on public.groups;
drop policy "admins edit group" on public.groups;
drop policy "admins delete group" on public.groups;
create policy "see groups" on public.groups for select to authenticated using (is_church_member(church_id));
create policy "create group" on public.groups for insert to authenticated
  with check (created_by = auth.uid() and is_church_member(church_id));
create policy "admins edit group" on public.groups for update to authenticated
  using (is_group_admin(id) or is_church_admin(church_id)) with check (is_church_member(church_id));
create policy "admins delete group" on public.groups for delete to authenticated
  using (is_group_admin(id) or is_church_admin(church_id));

drop policy "see members" on public.group_members;
drop policy "join group" on public.group_members;
drop policy "leave or remove" on public.group_members;
create policy "see members" on public.group_members for select to authenticated using (is_church_member(group_church(group_id)));
create policy "join group" on public.group_members for insert to authenticated
  with check (user_id = auth.uid() and role = 'member' and is_church_member(group_church(group_id)));
create policy "leave or remove" on public.group_members for delete to authenticated
  using (user_id = auth.uid() or is_group_admin(group_id) or is_church_admin(group_church(group_id)));

drop policy "see events" on public.events;
drop policy "admins add events" on public.events;
drop policy "admins edit events" on public.events;
drop policy "admins delete events" on public.events;
create policy "see events" on public.events for select to authenticated using (is_church_member(group_church(group_id)));
create policy "admins add events" on public.events for insert to authenticated
  with check (is_group_admin(group_id) or is_church_admin(group_church(group_id)));
create policy "admins edit events" on public.events for update to authenticated
  using (is_group_admin(group_id) or is_church_admin(group_church(group_id)));
create policy "admins delete events" on public.events for delete to authenticated
  using (is_group_admin(group_id) or is_church_admin(group_church(group_id)));

drop policy "see rsvps" on public.event_rsvps;
create policy "see rsvps" on public.event_rsvps for select to authenticated
  using (exists (select 1 from events e where e.id = event_id));

drop policy "see own reports" on public.reports;
create policy "see reports" on public.reports for select to authenticated
  using (reporter = auth.uid() or (church_id is not null and is_church_admin(church_id)));

-------------------------------------------------------------------------------
-- Notifications about joining
-------------------------------------------------------------------------------
-- "Ben asked to join Grace Church" goes to the church's admins; "approved" goes back to Ben;
-- "Ann made you an admin" goes to whoever was promoted.
alter table public.notifications add column church_id uuid references public.churches on delete cascade;
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in
  ('like', 'pray', 'comment', 'message', 'glass', 'friend_request', 'friend_accept', 'prayed', 'join_request', 'join_approved', 'made_admin'));

create function public.notify_membership() returns trigger
language plpgsql security definer set search_path = public as $$
declare church_name text := (select name from churches where id = new.church_id);
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    insert into notifications (user_id, actor, type, body, church_id)
      select m.user_id, new.user_id, 'join_request', church_name, new.church_id from church_members m
      where m.church_id = new.church_id and m.status = 'active' and m.role in ('admin', 'owner');
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'active' and auth.uid() is not null then
    insert into notifications (user_id, actor, type, body, church_id) values (new.user_id, auth.uid(), 'join_approved', church_name, new.church_id);
  elsif tg_op = 'UPDATE' and new.status = 'active' and new.role in ('admin', 'owner') and old.role = 'member'
        and auth.uid() is not null and new.user_id <> auth.uid() then
    -- "Ann made you an admin of Grace Church"
    insert into notifications (user_id, actor, type, body, church_id) values (new.user_id, auth.uid(), 'made_admin', church_name, new.church_id);
  elsif tg_op = 'UPDATE' and new.role = 'owner' and old.role = 'admin' and auth.uid() is not null and new.user_id <> auth.uid() then
    insert into notifications (user_id, actor, type, body, church_id) values (new.user_id, auth.uid(), 'made_admin', 'owner:' || church_name, new.church_id);
  end if;
  return new;
end;
$$;
create trigger on_membership after insert or update on public.church_members
  for each row execute function public.notify_membership();
