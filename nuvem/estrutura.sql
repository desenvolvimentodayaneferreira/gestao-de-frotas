-- Gestão de Frotas · estrutura na nuvem (Supabase) para as notas enviadas pelo celular.
-- Como usar: Supabase → SQL Editor → New query → colar este arquivo inteiro → Run.
-- Pode ser executado mais de uma vez sem perder dados.

-- ---------- Perfis: nome de cada pessoa e se é assessor ou escritório ----------
create table if not exists public.perfis (
  user_id uuid primary key references auth.users (id) on delete cascade,
  nome text not null,
  papel text not null default 'assessor' check (papel in ('assessor', 'escritorio')),
  criado_em timestamptz not null default now()
);

-- Toda conta criada em Authentication → Users ganha um perfil de assessor automaticamente.
create or replace function public.criar_perfil_automatico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.perfis (user_id, nome)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nome', initcap(split_part(new.email, '@', 1))))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario
  after insert on auth.users
  for each row execute function public.criar_perfil_automatico();

-- Contas que já existiam antes deste script também ganham perfil.
insert into public.perfis (user_id, nome)
select id, initcap(split_part(email, '@', 1)) from auth.users
on conflict (user_id) do nothing;

create or replace function public.is_escritorio()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.perfis where user_id = auth.uid() and papel = 'escritorio');
$$;

-- ---------- Veículos: lista publicada pelo programa do escritório ----------
create table if not exists public.veiculos (
  id text primary key,
  nome text not null,
  placa text,
  tipo text,
  ativo boolean not null default true,
  atualizado_em timestamptz not null default now()
);

-- ---------- Notas enviadas pelos assessores ----------
create table if not exists public.notas (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  user_id uuid not null default auth.uid() references auth.users (id),
  assessor_nome text,
  tipo text not null check (tipo in ('abastecimento', 'despesa')),
  veiculo_id text,
  km integer check (km is null or km >= 0),
  observacao text,
  foto_path text not null,
  status text not null default 'enviada' check (status in ('enviada', 'recebida', 'lancada', 'recusada')),
  motivo text,
  atualizado_em timestamptz not null default now()
);
create index if not exists notas_status_idx on public.notas (status, criado_em);

-- ---------- Regras de acesso (cada assessor vê só as próprias notas) ----------
alter table public.perfis enable row level security;
alter table public.veiculos enable row level security;
alter table public.notas enable row level security;

drop policy if exists perfis_ler on public.perfis;
create policy perfis_ler on public.perfis for select to authenticated
  using (user_id = auth.uid() or public.is_escritorio());

drop policy if exists perfis_editar on public.perfis;
create policy perfis_editar on public.perfis for update to authenticated
  using (public.is_escritorio()) with check (public.is_escritorio());

drop policy if exists veiculos_ler on public.veiculos;
create policy veiculos_ler on public.veiculos for select to authenticated using (true);

drop policy if exists veiculos_gravar on public.veiculos;
create policy veiculos_gravar on public.veiculos for all to authenticated
  using (public.is_escritorio()) with check (public.is_escritorio());

drop policy if exists notas_enviar on public.notas;
create policy notas_enviar on public.notas for insert to authenticated
  with check (user_id = auth.uid() and status = 'enviada');

drop policy if exists notas_ler on public.notas;
create policy notas_ler on public.notas for select to authenticated
  using (user_id = auth.uid() or public.is_escritorio());

drop policy if exists notas_atualizar on public.notas;
create policy notas_atualizar on public.notas for update to authenticated
  using (public.is_escritorio()) with check (public.is_escritorio());

-- ---------- Fotos das notas (pasta privada, uma subpasta por assessor) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('notas', 'notas', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists notas_foto_enviar on storage.objects;
create policy notas_foto_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'notas' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists notas_foto_ler on storage.objects;
create policy notas_foto_ler on storage.objects for select to authenticated
  using (bucket_id = 'notas' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_escritorio()));
