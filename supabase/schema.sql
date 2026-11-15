create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  username text unique,
  full_name text,
  date_of_birth date,
  avatar_url text,
  onboarding_completed boolean not null default false,
  is_online boolean not null default false,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format_check check (
    username is null or (
      char_length(username) >= 4
      and char_length(username) <= 32
      and username ~ '^[a-z0-9_]+$'
    )
  )
);

create index idx_users_username on public.users (username);
create index idx_users_onboarding on public.users (onboarding_completed);

create table public.follow_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id) on delete cascade,
  receiver_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unique_follow_pair unique (sender_id, receiver_id),
  constraint prevent_self_follow check (sender_id <> receiver_id)
);

create index idx_follow_requests_sender on public.follow_requests (sender_id, status);
create index idx_follow_requests_receiver on public.follow_requests (receiver_id, status);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  participant_one uuid not null references public.users(id) on delete cascade,
  participant_two uuid not null references public.users(id) on delete cascade,
  last_message_text text,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint ordered_participants check (participant_one < participant_two),
  constraint unique_conversation_participants unique (participant_one, participant_two)
);

create index idx_conversations_p1 on public.conversations (participant_one, last_message_at desc);
create index idx_conversations_p2 on public.conversations (participant_two, last_message_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade,
  receiver_id uuid not null references public.users(id) on delete cascade,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'video', 'audio')),
  content text,
  media_url text,
  media_duration integer,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_messages_conversation_created on public.messages (conversation_id, created_at asc);
create index idx_messages_receiver_unread on public.messages (receiver_id, read_at) where read_at is null;

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.users(id) on delete cascade,
  content text not null default '',
  image_url text,
  privacy text not null default 'public' check (privacy in ('public', 'followers_only')),
  likes_count integer not null default 0,
  comments_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint post_not_empty check (char_length(trim(content)) > 0 or image_url is not null)
);

create index idx_posts_author_created on public.posts (author_id, created_at desc);
create index idx_posts_created on public.posts (created_at desc);

create table public.post_likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint unique_post_like unique (post_id, user_id)
);

create index idx_post_likes_post on public.post_likes (post_id);
create index idx_post_likes_user on public.post_likes (user_id);

create table public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) > 0),
  created_at timestamptz not null default now()
);

create index idx_post_comments_post_created on public.post_comments (post_id, created_at asc);

create or replace function public.are_users_connected(user_a uuid, user_b uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.follow_requests
    where status = 'accepted'
      and (
        (sender_id = user_a and receiver_id = user_b)
        or (sender_id = user_b and receiver_id = user_a)
      )
  );
$$;

create or replace function public.is_accepted_follower(viewer_id uuid, author_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.follow_requests
    where status = 'accepted'
      and (
        (sender_id = viewer_id and receiver_id = author_id)
        or (sender_id = author_id and receiver_id = viewer_id)
      )
  );
$$;

create or replace function public.check_username_available(candidate_username text, current_uid uuid default null)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  normalized text;
begin
  normalized := lower(trim(candidate_username));
  if char_length(normalized) < 4 or char_length(normalized) > 32 or normalized !~ '^[a-z0-9_]+$' then
    return false;
  end if;

  return not exists (
    select 1
    from public.users
    where username = normalized
      and (current_uid is null or id <> current_uid)
  );
end;
$$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, onboarding_completed, created_at, updated_at)
  values (new.id, coalesce(new.email, ''), false, now(), now())
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.handle_follow_accepted_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p1 uuid;
  p2 uuid;
begin
  if new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted') then
    p1 := least(new.sender_id, new.receiver_id);
    p2 := greatest(new.sender_id, new.receiver_id);

    insert into public.conversations (participant_one, participant_two, last_message_text, last_message_at)
    values (p1, p2, 'تم فتح المحادثة', now())
    on conflict (participant_one, participant_two) do nothing;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists on_follow_request_accepted on public.follow_requests;
create trigger on_follow_request_accepted
  before insert or update on public.follow_requests
  for each row execute function public.handle_follow_accepted_conversation();

create or replace function public.handle_new_message_conversation_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  preview text;
begin
  if new.message_type = 'text' then
    preview := left(coalesce(new.content, ''), 120);
  elsif new.message_type = 'image' then
    preview := 'أرسل صورة';
  elsif new.message_type = 'video' then
    preview := 'أرسل فيديو';
  elsif new.message_type = 'audio' then
    preview := 'أرسل رسالة صوتية';
  else
    preview := 'رسالة جديدة';
  end if;

  update public.conversations
  set last_message_text = preview,
      last_message_at = new.created_at
  where id = new.conversation_id;

  return new;
end;
$$;

drop trigger if exists on_message_inserted on public.messages;
create trigger on_message_inserted
  after insert on public.messages
  for each row execute function public.handle_new_message_conversation_sync();

create or replace function public.handle_post_likes_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set likes_count = likes_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set likes_count = greatest(0, likes_count - 1) where id = old.post_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists on_post_like_change on public.post_likes;
create trigger on_post_like_change
  after insert or delete on public.post_likes
  for each row execute function public.handle_post_likes_count();

create or replace function public.handle_post_comments_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comments_count = comments_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set comments_count = greatest(0, comments_count - 1) where id = old.post_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists on_post_comment_change on public.post_comments;
create trigger on_post_comment_change
  after insert or delete on public.post_comments
  for each row execute function public.handle_post_comments_count();

alter table public.users enable row level security;
alter table public.follow_requests enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;

create policy "users_select_authenticated"
  on public.users
  for select
  to authenticated
  using (true);

create policy "users_insert_own"
  on public.users
  for insert
  to authenticated
  with check (auth.uid() = id);

create policy "users_update_own"
  on public.users
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "follow_requests_select_involved_or_accepted"
  on public.follow_requests
  for select
  to authenticated
  using (
    auth.uid() = sender_id
    or auth.uid() = receiver_id
    or status = 'accepted'
  );

create policy "follow_requests_insert_sender"
  on public.follow_requests
  for insert
  to authenticated
  with check (
    auth.uid() = sender_id
    and sender_id <> receiver_id
    and status = 'pending'
  );

create policy "follow_requests_update_receiver_or_sender"
  on public.follow_requests
  for update
  to authenticated
  using (auth.uid() = receiver_id or auth.uid() = sender_id)
  with check (
    (auth.uid() = receiver_id and status in ('accepted', 'rejected'))
    or (auth.uid() = sender_id and status = 'pending')
  );

create policy "follow_requests_delete_participants"
  on public.follow_requests
  for delete
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "conversations_select_participants"
  on public.conversations
  for select
  to authenticated
  using (
    (auth.uid() = participant_one or auth.uid() = participant_two)
    and public.are_users_connected(participant_one, participant_two)
  );

create policy "conversations_insert_connected"
  on public.conversations
  for insert
  to authenticated
  with check (
    (auth.uid() = participant_one or auth.uid() = participant_two)
    and participant_one < participant_two
    and public.are_users_connected(participant_one, participant_two)
  );

create policy "conversations_update_participants"
  on public.conversations
  for update
  to authenticated
  using (
    (auth.uid() = participant_one or auth.uid() = participant_two)
    and public.are_users_connected(participant_one, participant_two)
  )
  with check (
    (auth.uid() = participant_one or auth.uid() = participant_two)
    and public.are_users_connected(participant_one, participant_two)
  );

create policy "messages_select_participants"
  on public.messages
  for select
  to authenticated
  using (
    (auth.uid() = sender_id or auth.uid() = receiver_id)
    and public.are_users_connected(sender_id, receiver_id)
  );

create policy "messages_insert_connected_sender"
  on public.messages
  for insert
  to authenticated
  with check (
    auth.uid() = sender_id
    and public.are_users_connected(sender_id, receiver_id)
    and exists (
      select 1
      from public.conversations c
      where c.id = conversation_id
        and c.participant_one = least(sender_id, receiver_id)
        and c.participant_two = greatest(sender_id, receiver_id)
    )
  );

create policy "messages_update_receipts"
  on public.messages
  for update
  to authenticated
  using (auth.uid() = receiver_id or auth.uid() = sender_id)
  with check (auth.uid() = receiver_id or auth.uid() = sender_id);

create policy "posts_select_visibility"
  on public.posts
  for select
  to authenticated
  using (
    privacy = 'public'
    or author_id = auth.uid()
    or (
      privacy = 'followers_only'
      and public.is_accepted_follower(auth.uid(), author_id)
    )
  );

create policy "posts_insert_own"
  on public.posts
  for insert
  to authenticated
  with check (auth.uid() = author_id);

create policy "posts_update_own"
  on public.posts
  for update
  to authenticated
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

create policy "posts_delete_own"
  on public.posts
  for delete
  to authenticated
  using (auth.uid() = author_id);

create policy "post_likes_select_visible_post"
  on public.post_likes
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.posts p
      where p.id = post_id
        and (
          p.privacy = 'public'
          or p.author_id = auth.uid()
          or public.is_accepted_follower(auth.uid(), p.author_id)
        )
    )
  );

create policy "post_likes_insert_visible_post"
  on public.post_likes
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.posts p
      where p.id = post_id
        and (
          p.privacy = 'public'
          or p.author_id = auth.uid()
          or public.is_accepted_follower(auth.uid(), p.author_id)
        )
    )
  );

create policy "post_likes_delete_own"
  on public.post_likes
  for delete
  to authenticated
  using (auth.uid() = user_id);

create policy "post_comments_select_visible_post"
  on public.post_comments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.posts p
      where p.id = post_id
        and (
          p.privacy = 'public'
          or p.author_id = auth.uid()
          or public.is_accepted_follower(auth.uid(), p.author_id)
        )
    )
  );

create policy "post_comments_insert_visible_post"
  on public.post_comments
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.posts p
      where p.id = post_id
        and (
          p.privacy = 'public'
          or p.author_id = auth.uid()
          or public.is_accepted_follower(auth.uid(), p.author_id)
        )
    )
  );

create policy "post_comments_delete_own"
  on public.post_comments
  for delete
  to authenticated
  using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('post-media', 'post-media', true, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('chat-media', 'chat-media', true, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg'])
on conflict (id) do nothing;

create policy "avatars_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

create policy "avatars_user_upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_user_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "post_media_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'post-media');

create policy "post_media_user_upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'post-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "chat_media_authenticated_read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'chat-media');

create policy "chat_media_user_upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

alter table public.users replica identity full;
alter table public.follow_requests replica identity full;
alter table public.conversations replica identity full;
alter table public.messages replica identity full;
alter table public.posts replica identity full;
alter table public.post_likes replica identity full;
alter table public.post_comments replica identity full;

alter publication supabase_realtime add table public.users;
alter publication supabase_realtime add table public.follow_requests;
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.posts;
alter publication supabase_realtime add table public.post_likes;
alter publication supabase_realtime add table public.post_comments;