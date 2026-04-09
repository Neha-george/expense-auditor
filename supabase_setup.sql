-- ============================================================
-- PolicyLens — Multi-Tenant Schema (Clean Slate)
-- Run this entire file in the Supabase SQL Editor.
-- ============================================================

-- 1. EXTENSIONS
-- ============================================================
create extension if not exists vector;
create extension if not exists pgcrypto;   -- for gen_random_uuid()


-- 2. ORGANISATIONS
-- ============================================================
create table organisations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  slug              text unique not null,
  plan              text check (plan in ('free','pro','enterprise')) default 'free',
  default_currency  text default 'USD',
  fiscal_year_start int  default 1 check (fiscal_year_start between 1 and 12),
  invite_code       text unique not null default substring(md5(random()::text), 1, 8),
  created_at        timestamptz default now()
);


-- 3. PROFILES  (extends auth.users)
-- ============================================================
create table profiles (
  id                  uuid references auth.users on delete cascade primary key,
  organisation_id     uuid references organisations(id) on delete set null,
  email               text unique not null,
  full_name           text,
  role                text check (role in ('employee', 'admin')) default 'employee',
  department          text,
  location            text,
  seniority           text check (seniority in ('junior','mid','senior','executive')) default 'mid',
  onboarding_complete boolean default false,
  created_at          timestamptz default now()
);


-- 4. POLICY DOCUMENTS
-- ============================================================
create table policy_documents (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete cascade not null,
  name            text not null,
  file_path       text not null,
  is_active       boolean default false,
  uploaded_by     uuid references profiles(id),
  created_at      timestamptz default now()
);


-- 5. POLICY CHUNKS  (with pgvector)
-- ============================================================
create table policy_chunks (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete cascade not null,
  document_id     uuid references policy_documents(id) on delete cascade,
  chunk_index     int not null,
  content         text not null,
  embedding       vector(768),
  created_at      timestamptz default now()
);

-- GIN index for fast org-scoped look-ups (as recommended)
create index policy_chunks_org_idx on policy_chunks(organisation_id);

-- HNSW index for fast vector similarity search
create index on policy_chunks using hnsw (embedding vector_cosine_ops);


-- 6. CLAIMS
-- ============================================================
create table claims (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid references organisations(id) on delete cascade not null,
  employee_id      uuid references profiles(id) not null,
  receipt_url      text not null,
  merchant         text,
  amount           numeric(10,2),
  currency         text default 'USD',
  receipt_date     date,
  category         text,
  business_purpose text not null,
  ai_verdict       text check (ai_verdict in ('approved','flagged','rejected')),
  ai_reason        text,
  policy_reference text,
  admin_verdict    text check (admin_verdict in ('approved','rejected')),
  admin_note       text,
  reviewed_by      uuid references profiles(id),
  status           text check (status in ('pending','approved','flagged','rejected')) default 'pending',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger claims_updated_at
  before update on claims
  for each row execute function update_updated_at();


-- 7. REQUEST LOGS  (for rate limiting)
-- ============================================================
create table request_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references profiles(id),
  endpoint   text,
  created_at timestamptz default now()
);


-- 8. HELPER — get calling user's organisation_id
-- ============================================================
-- Used by RLS policies to avoid repeated sub-queries per row.
create or replace function auth_user_org_id()
returns uuid
language sql stable security definer as $$
  select organisation_id from profiles where id = auth.uid();
$$;


-- 9. VECTOR SEARCH FUNCTION  (multi-tenant isolated)
-- ============================================================
create or replace function match_policy_chunks(
  query_embedding  vector(768),
  match_count      int default 4,
  p_organisation_id uuid default null
)
returns table (
  id          uuid,
  content     text,
  similarity  float
)
language sql stable as $$
  select
    pc.id,
    pc.content,
    1 - (pc.embedding <=> query_embedding) as similarity
  from policy_chunks pc
  join policy_documents pd on pd.id = pc.document_id
  where pd.is_active = true
    and pc.organisation_id = p_organisation_id
  order by pc.embedding <=> query_embedding
  limit match_count;
$$;


-- 10. ROW LEVEL SECURITY
-- ============================================================
alter table profiles        enable row level security;
alter table organisations   enable row level security;
alter table claims          enable row level security;
alter table policy_documents enable row level security;
alter table policy_chunks   enable row level security;
alter table request_logs    enable row level security;

-- ── organisations ──────────────────────────────────────────
-- Users can only see their own organisation
create policy "members see own organisation"
  on organisations for select
  using (id = auth_user_org_id());

-- ── profiles ───────────────────────────────────────────────
-- Users always see their own profile
create policy "users see own profile"
  on profiles for select
  using (auth.uid() = id);

-- Admins see all profiles within their org
create policy "admins see org profiles"
  on profiles for select
  using (
    auth_user_org_id() = organisation_id
    and exists (
      select 1 from profiles p2
      where p2.id = auth.uid() and p2.role = 'admin'
    )
  );

-- Users can update their own profile
create policy "users update own profile"
  on profiles for update
  using (auth.uid() = id);

-- ── claims ─────────────────────────────────────────────────
-- Employees see only their own claims (within their org)
create policy "employees see own claims"
  on claims for select
  using (employee_id = auth.uid() and organisation_id = auth_user_org_id());

-- Employees can insert claims tagged to their org
create policy "employees insert own claims"
  on claims for insert
  with check (employee_id = auth.uid() and organisation_id = auth_user_org_id());

-- Admins see and manage ALL claims within their org only
create policy "admins manage org claims"
  on claims for all
  using (
    organisation_id = auth_user_org_id()
    and exists (
      select 1 from profiles where id = auth.uid() and role = 'admin'
    )
  );

-- ── policy_documents ───────────────────────────────────────
create policy "admins manage org policies"
  on policy_documents for all
  using (
    organisation_id = auth_user_org_id()
    and exists (
      select 1 from profiles where id = auth.uid() and role = 'admin'
    )
  );

-- ── policy_chunks ──────────────────────────────────────────
create policy "admins manage org chunks"
  on policy_chunks for all
  using (
    organisation_id = auth_user_org_id()
    and exists (
      select 1 from profiles where id = auth.uid() and role = 'admin'
    )
  );

-- ── request_logs ───────────────────────────────────────────
create policy "users see own logs"
  on request_logs for select
  using (user_id = auth.uid());

create policy "users insert own logs"
  on request_logs for insert
  with check (user_id = auth.uid());


-- 11. AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================
-- Note: organisation_id is intentionally NULL on signup.
-- Middleware will redirect to /onboarding until it is set.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ============================================================
-- 12. SEED DATA — Two isolated demo organisations
--     (Admins/employees are added via the app's Auth flow)
-- ============================================================

-- Org A: "Global Corp"
insert into organisations (id, name, slug, plan, invite_code)
values (
  '11111111-1111-1111-1111-111111111111',
  'Global Corp',
  'global-corp',
  'pro',
  'GLOBALCORP'
);

-- Org B: "Startup Inc"
insert into organisations (id, name, slug, plan, invite_code)
values (
  '22222222-2222-2222-2222-222222222222',
  'Startup Inc',
  'startup-inc',
  'free',
  'STARTUPINC'
);

-- ============================================================
-- Done. Next steps:
--   1. Run this SQL in Supabase SQL Editor (fresh schema).
--   2. Register as admin for Global Corp → /onboarding.
--   3. Register as employee via invite link → auto-join org.
--   4. Confirm cross-tenant data isolation.
-- ============================================================
