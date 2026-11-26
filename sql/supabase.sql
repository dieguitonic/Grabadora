-- Acta: esquema de la nube (Supabase). Pegar completo en Supabase > SQL Editor > Run.
-- Se puede correr más de una vez sin romper nada.

create table if not exists public.meetings (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at bigint not null,
  synced_at timestamptz not null default now()
);
create table if not exists public.blocks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  meeting_id text not null references public.meetings(id) on delete cascade,
  idx int not null,
  data jsonb not null,
  updated_at bigint not null,
  synced_at timestamptz not null default now(),
  primary key (meeting_id, idx)
);
create table if not exists public.notes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  meeting_id text not null references public.meetings(id) on delete cascade,
  kind text not null,
  key text not null,
  data jsonb not null,
  updated_at bigint not null,
  synced_at timestamptz not null default now(),
  primary key (meeting_id, kind, key)
);
create table if not exists public.audio_slices (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  meeting_id text not null references public.meetings(id) on delete cascade,
  part int not null,
  n int not null,
  path text not null,
  bytes int not null,
  chunks int not null,
  synced_at timestamptz not null default now(),
  primary key (meeting_id, part, n)
);

create index if not exists meetings_sync on public.meetings (user_id, synced_at);
create index if not exists blocks_sync on public.blocks (user_id, synced_at);
create index if not exists notes_sync on public.notes (user_id, synced_at);

-- synced_at lo pone el servidor (reloj único para todos los dispositivos)
create or replace function public.acta_touch() returns trigger language plpgsql as $$
begin new.synced_at := now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['meetings','blocks','notes','audio_slices'] loop
    execute format('drop trigger if exists acta_touch on public.%I', t);
    execute format('create trigger acta_touch before insert or update on public.%I for each row execute function public.acta_touch()', t);
  end loop;
end $$;

-- Cada usuario ve y modifica solo lo suyo
do $$ declare t text; begin
  foreach t in array array['meetings','blocks','notes','audio_slices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists acta_own on public.%I', t);
    execute format('create policy acta_own on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Audio: bucket privado; cada usuario solo su carpeta (la primera carpeta es su id)
insert into storage.buckets (id, name, public) values ('audio', 'audio', false) on conflict (id) do nothing;
drop policy if exists acta_audio_own on storage.objects;
create policy acta_audio_own on storage.objects for all to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
