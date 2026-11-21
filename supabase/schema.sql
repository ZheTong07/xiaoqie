-- 企鹅小窝 · 云端表结构 / 权限 / 存储策略
-- 用法：Supabase Dashboard → SQL Editor → 全文粘贴执行（可重复执行，不会丢数据）。
--
-- 背景：当前 entries / media 两张表存在，但 anon 角色没有任何表权限，
-- 前端一读就会得到 42501 permission denied。本文件把权限补齐。

-- ============================================================
-- 1. 表结构（已存在则只补缺失的列）
-- ============================================================

create table if not exists public.entries (
  id              text primary key,
  owner_id        text not null default 'local-user',
  relationship_id text not null default 'cloud-rel-1',
  occurred_at     date not null,
  title           text not null,
  content         text not null default '',
  place           text not null default '',
  mood_tags       text[] not null default '{}',
  is_milestone    boolean not null default false,
  attribution     text not null default 'both',
  media_ids       text[] not null default '{}',
  created_at      bigint not null,
  updated_at      bigint not null
);

alter table public.entries add column if not exists owner_id        text not null default 'local-user';
alter table public.entries add column if not exists relationship_id text not null default 'cloud-rel-1';
alter table public.entries add column if not exists occurred_at     date not null default current_date;
alter table public.entries add column if not exists title           text not null default '';
alter table public.entries add column if not exists content         text not null default '';
alter table public.entries add column if not exists place           text not null default '';
alter table public.entries add column if not exists mood_tags       text[] not null default '{}';
alter table public.entries add column if not exists is_milestone    boolean not null default false;
alter table public.entries add column if not exists attribution     text not null default 'both';
alter table public.entries add column if not exists media_ids       text[] not null default '{}';
alter table public.entries add column if not exists created_at      bigint not null default 0;
alter table public.entries add column if not exists updated_at      bigint not null default 0;

create table if not exists public.media (
  id              text primary key,
  owner_id        text not null default 'local-user',
  relationship_id text not null default 'cloud-rel-1',
  entry_id        text,
  kind            text not null default 'image',
  mime_type       text not null default 'application/octet-stream',
  size            bigint not null default 0,
  file_name       text not null default '',
  storage_path    text not null default '',
  url             text not null default '',
  created_at      bigint not null
);

alter table public.media add column if not exists owner_id        text not null default 'local-user';
alter table public.media add column if not exists relationship_id text not null default 'cloud-rel-1';
alter table public.media add column if not exists entry_id        text;
alter table public.media add column if not exists kind            text not null default 'image';
alter table public.media add column if not exists mime_type       text not null default 'application/octet-stream';
alter table public.media add column if not exists size            bigint not null default 0;
alter table public.media add column if not exists file_name       text not null default '';
alter table public.media add column if not exists storage_path    text not null default '';
alter table public.media add column if not exists url             text not null default '';
alter table public.media add column if not exists created_at      bigint not null default 0;

-- 列表按「关系 + 日期」取，建个复合索引
create index if not exists entries_relationship_occurred_idx
  on public.entries (relationship_id, occurred_at desc, created_at desc);
create index if not exists media_entry_id_idx
  on public.media (entry_id);

-- ============================================================
-- 2. 表权限（GRANT）
--    Supabase SQL Editor 建的表不会自动授权给 anon / authenticated，
--    缺了这一段就会 42501 permission denied。
-- ============================================================

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.entries to anon, authenticated;
grant select, insert, update, delete on public.media   to anon, authenticated;

-- ============================================================
-- 3. RLS 策略
--    v1 没有登录，前端只能带 publishable key（匿名角色）。
--    因此这里给 anon 放开整表 —— 安全边界是「拿到 key 的人」。
--    ⚠️ 第一版可以接受；接入 Supabase Auth 后请立刻改为按 owner_id / relationship_id 过滤。
-- ============================================================

alter table public.entries enable row level security;
alter table public.media   enable row level security;

drop policy if exists "xiaoqie v1 anon all" on public.entries;
create policy "xiaoqie v1 anon all" on public.entries
  for all to anon, authenticated
  using (true) with check (true);

drop policy if exists "xiaoqie v1 anon all" on public.media;
create policy "xiaoqie v1 anon all" on public.media
  for all to anon, authenticated
  using (true) with check (true);

-- ============================================================
-- 4. Storage：media 桶 + 对象策略
-- ============================================================

insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;   -- getPublicUrl 需要 public = true

drop policy if exists "xiaoqie media anon select" on storage.objects;
create policy "xiaoqie media anon select" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'media');

drop policy if exists "xiaoqie media anon insert" on storage.objects;
create policy "xiaoqie media anon insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'media');

drop policy if exists "xiaoqie media anon update" on storage.objects;
create policy "xiaoqie media anon update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'media') with check (bucket_id = 'media');

drop policy if exists "xiaoqie media anon delete" on storage.objects;
create policy "xiaoqie media anon delete" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'media');

-- ============================================================
-- 5. 悄悄话小纸条（notes）
-- ============================================================

create table if not exists public.notes (
  id              uuid primary key,
  relationship_id text not null default 'cloud-rel-1',
  content         text not null,
  created_at      bigint not null
);

alter table public.notes add column if not exists relationship_id text not null default 'cloud-rel-1';
alter table public.notes add column if not exists content         text not null default '';
alter table public.notes add column if not exists created_at      bigint not null default 0;

create index if not exists notes_relationship_created_idx
  on public.notes (relationship_id, created_at desc);

grant select, insert, update, delete on public.notes to anon, authenticated;

alter table public.notes enable row level security;

drop policy if exists "xiaoqie v1 anon all" on public.notes;
create policy "xiaoqie v1 anon all" on public.notes
  for all to anon, authenticated
  using (true) with check (true);

-- ============================================================
-- 6. 自检：执行完下面这条，确认列名与前端映射一致
--    （前端映射见 data/repository.js、data/notesRepository.js 的 toRow / fromRow）
-- ============================================================
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('entries', 'media', 'notes')
order by table_name, ordinal_position;
