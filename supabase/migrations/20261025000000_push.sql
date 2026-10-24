-- Push notifications: the devices each person gets notifications on, and a trigger that asks
-- the "push" server function to deliver every new notification.

-------------------------------------------------------------------------------
-- Devices
-------------------------------------------------------------------------------
-- token is an Apple device token (ios), a Firebase token (android) or a browser
-- push subscription as JSON (web).
create table public.push_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'web')),
  token text not null unique check (char_length(token) <= 2000),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index push_tokens_user on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;
create policy "see own devices" on public.push_tokens for select to authenticated using (user_id = auth.uid());
create policy "remove own devices" on public.push_tokens for delete to authenticated using (user_id = auth.uid());

-- A phone can change hands (log out, someone else logs in), so registering a token moves it
-- to whoever is signed in now.
create function public.register_push(device_platform text, device_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into push_tokens (user_id, platform, token) values (auth.uid(), device_platform, device_token)
  on conflict (token) do update set user_id = auth.uid(), platform = excluded.platform, last_seen = now();
end;
$$;

create function public.unregister_push(device_token text) returns void
language sql security definer set search_path = public as $$
  delete from push_tokens where token = device_token and user_id = auth.uid();
$$;

revoke execute on function public.register_push(text, text) from public, anon;
revoke execute on function public.unregister_push(text) from public, anon;
grant execute on function public.register_push(text, text) to authenticated;
grant execute on function public.unregister_push(text) to authenticated;

-------------------------------------------------------------------------------
-- Sending
-------------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

-- Where the push function lives, and the shared secret that proves a request came from here.
-- Not reachable through the app's API. Fill it in once (see README, "Turn on push notifications").
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.push_settings (
  id int primary key default 1 check (id = 1),
  function_url text not null,
  secret text not null
);

create function public.send_push() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare s private.push_settings;
begin
  select * into s from private.push_settings where id = 1;
  if s.function_url is null then return new; end if;
  if not exists (select 1 from push_tokens where user_id = new.user_id) then return new; end if;
  perform net.http_post(
    url := s.function_url,
    body := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', s.secret),
    timeout_milliseconds := 8000
  );
  return new;
end;
$$;
create trigger on_notification_push after insert on public.notifications
  for each row execute function public.send_push();
