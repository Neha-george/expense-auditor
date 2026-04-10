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
  default_currency  text default 'INR',
  fiscal_year_start int  default 1 check (fiscal_year_start between 1 and 12),
  invite_code       text unique not null default substring(md5(random()::text), 1, 8),
  auto_approve_threshold numeric default 1000,
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
  policy_analysis jsonb,
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
  employee_department text,
  employee_seniority text,
  location_city    text,
  location_country text,
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
  admin_verdict    text, -- null, 'approved', 'rejected'
  admin_note       text,
  parent_claim_id  uuid references claims(id) on delete set null,
  reviewed_by      uuid references profiles(id),
  status           text check (status in ('pending','approved','flagged','rejected')) default 'pending',
  confidence       numeric,
  requires_review  boolean default false,
  is_duplicate_warning boolean default false,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index idx_claims_baseline_dims on claims (
  organisation_id,
  employee_department,
  employee_seniority,
  category,
  location_country,
  location_city,
  created_at
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

create or replace function get_auth_user_role()
returns text
language sql stable security definer as $$
  select role from profiles where id = auth.uid();
$$;

-- Admins see all profiles within their org
create policy "admins see org profiles"
  on profiles for select
  using (
    auth_user_org_id() = organisation_id
    and get_auth_user_role() = 'admin'
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
    and get_auth_user_role() = 'admin'
  );

-- ── policy_documents ───────────────────────────────────────
create policy "admins manage org policies"
  on policy_documents for all
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
  );

-- ── policy_chunks ──────────────────────────────────────────
create policy "admins manage org chunks"
  on policy_chunks for all
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
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
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', '')
  );
  return new;
exception
  when others then
    -- Log the error temporarily for debugging if needed, but don't fail the insert
    raise notice 'Error setting up profile profile %', SQLERRM;
    return new;
end;
$$;
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
-- 13. SPEND LIMITS
-- ============================================================
create table spend_limits (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete cascade not null,
  seniority       text not null,
  category        text not null,
  monthly_limit   numeric(10,2) not null default 0,
  currency        text default 'USD',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(organisation_id, seniority, category)
);

alter table spend_limits enable row level security;

create policy "admins manage spend limits"
  on spend_limits for all
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
  );

create policy "members view spend limits"
  on spend_limits for select
  using (organisation_id = auth_user_org_id());

-- ============================================================
-- 13B. STATISTICAL BASELINES
-- ============================================================
create table statistical_baselines (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid references organisations(id) on delete cascade not null,
  department       text not null,
  seniority        text not null,
  category         text not null,
  location_country text not null,
  median_amount    numeric(10,2) not null,
  stddev_amount    numeric(10,2) not null,
  sample_size      int not null default 0,
  updated_at       timestamptz default now(),
  unique(organisation_id, department, seniority, category, location_country)
);

create index idx_statistical_baselines_lookup on statistical_baselines (
  organisation_id,
  department,
  seniority,
  category,
  location_country
);

alter table statistical_baselines enable row level security;

create policy "admins manage statistical baselines"
  on statistical_baselines for all
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
  );

create policy "members view statistical baselines"
  on statistical_baselines for select
  using (organisation_id = auth_user_org_id());

-- ============================================================
-- 14. AUDIT LOGS
-- ============================================================
create table audit_logs (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete cascade not null,
  actor_id        uuid references profiles(id) on delete set null,
  action          text not null,
  entity_type     text not null,
  entity_id       uuid not null,
  metadata        jsonb,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz default now()
);

alter table audit_logs enable row level security;

create policy "admins see audit logs"
  on audit_logs for select
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
  );

-- Deny updates/deletes securely
create policy "deny update audit logs" on audit_logs for update using (false);
create policy "deny delete audit logs" on audit_logs for delete using (false);

-- Trigger for claims logging
create or replace function log_claim_update()
returns trigger as $$
declare
  client_ip text;
  client_ua text;
begin
  if (old.status is distinct from new.status) or
     (old.amount is distinct from new.amount) or
     (old.category is distinct from new.category) or
     (old.admin_verdict is distinct from new.admin_verdict) then
    
    begin
      client_ip := current_setting('request.headers', true)::json->>'x-forwarded-for';
      client_ua := current_setting('request.headers', true)::json->>'user-agent';
    exception when others then
      -- Fallback if not evaluated in API context.
      client_ip := '127.0.0.1';
      client_ua := 'Unknown';
    end;
    
    insert into audit_logs (
      organisation_id, actor_id, action, entity_type, entity_id, metadata, ip_address, user_agent
    ) values (
      new.organisation_id,
      auth.uid(),
      'claim_updated',
      'claim',
      new.id,
      jsonb_build_object(
        'old_status', old.status, 'new_status', new.status, 
        'old_amount', old.amount, 'new_amount', new.amount,
        'old_category', old.category, 'new_category', new.category,
        'admin_verdict', new.admin_verdict
      ),
      coalesce(client_ip, '127.0.0.1'),
      client_ua
    );
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger trigger_log_claim_update
  after update on claims
  for each row execute function log_claim_update();

-- Enable Realtime for Claims
alter publication supabase_realtime add table claims;

-- Fraud Detection Indexes
create index idx_claims_fraud_check on claims (employee_id, merchant, amount, created_at);

-- ============================================================
-- 15. VERDICT FEEDBACK (AI LEARNING)
-- ============================================================
create table verdict_feedback (
  id                 uuid primary key default gen_random_uuid(),
  organisation_id    uuid references organisations(id) on delete cascade not null,
  claim_id           uuid references claims(id) on delete cascade not null,
  category           text not null,
  amount_range       text not null,  -- e.g. '0-50', '50-200', '200+'
  original_ai_verdict text not null,
  admin_verdict      text not null,
  admin_reason       text,
  created_at         timestamptz default now()
);

alter table verdict_feedback enable row level security;

create policy "admins manage verdict_feedback"
  on verdict_feedback for all
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
  );

create index idx_verdict_feedback_lookup on verdict_feedback (organisation_id, category, amount_range, created_at desc);

-- ============================================================
-- 16. GL ACCOUNT MAPPINGS (ERP EXPORTS)
-- ============================================================
create table gl_account_mappings (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id) on delete cascade not null,
  category        text not null,
  gl_code         text not null,
  gl_description  text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(organisation_id, category)
);

alter table gl_account_mappings enable row level security;

create policy "admins manage gl mappings"
  on gl_account_mappings for all
  using (
    organisation_id = auth_user_org_id()
    and get_auth_user_role() = 'admin'
  );

create policy "members view gl mappings"
  on gl_account_mappings for select
  using (organisation_id = auth_user_org_id());

-- ============================================================
-- Done. Next steps:
--   1. Run this SQL in Supabase SQL Editor (fresh schema).
--   2. Register as admin for Global Corp → /onboarding.
--   3. Register as employee via invite link → auto-join org.
--   4. Confirm cross-tenant data isolation.
-- ============================================================
