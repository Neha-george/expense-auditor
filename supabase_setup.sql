-- Enable vector extension
create extension if not exists vector;

-- Profiles (extends auth.users)
create table profiles (
  id uuid references auth.users on delete cascade primary key,
  email text unique not null,
  full_name text,
  role text check (role in ('employee', 'admin')) default 'employee',
  department text,
  location text,
  seniority text check (seniority in ('junior','mid','senior','executive')) default 'mid',
  created_at timestamptz default now()
);

-- Policy documents metadata
create table policy_documents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  file_path text not null,
  is_active boolean default false,
  uploaded_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- Policy text chunks with vector embeddings
create table policy_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references policy_documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(768),
  created_at timestamptz default now()
);

-- Claims
create table claims (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references profiles(id) not null,
  receipt_url text not null,
  merchant text,
  amount numeric(10,2),
  currency text default 'USD',
  receipt_date date,
  category text,
  business_purpose text not null,
  ai_verdict text check (ai_verdict in ('approved','flagged','rejected')),
  ai_reason text,
  policy_reference text,
  admin_verdict text check (admin_verdict in ('approved','rejected')),
  admin_note text,
  reviewed_by uuid references profiles(id),
  status text check (status in ('pending','approved','flagged','rejected')) default 'pending',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger claims_updated_at
  before update on claims
  for each row execute function update_updated_at();

-- Vector similarity search function
create or replace function match_policy_chunks(
  query_embedding vector(768),
  match_count int default 4
)
returns table (
  id uuid,
  content text,
  similarity float
)
language sql stable as $$
  select
    pc.id,
    pc.content,
    1 - (pc.embedding <=> query_embedding) as similarity
  from policy_chunks pc
  join policy_documents pd on pd.id = pc.document_id
  where pd.is_active = true
  order by pc.embedding <=> query_embedding
  limit match_count;
$$;

-- HNSW index for fast vector search
create index on policy_chunks using hnsw (embedding vector_cosine_ops);

-- Row Level Security
alter table profiles enable row level security;
alter table claims enable row level security;
alter table policy_documents enable row level security;
alter table policy_chunks enable row level security;

-- Profiles: users see only their own row; admins see all
create policy "users see own profile"
  on profiles for select using (auth.uid() = id);

create policy "admins see all profiles"
  on profiles for select
  using (exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  ));

-- Claims: employees see only their own
create policy "employees see own claims"
  on claims for select using (employee_id = auth.uid());

create policy "employees insert own claims"
  on claims for insert with check (employee_id = auth.uid());

-- Admins see and update all claims
create policy "admins manage all claims"
  on claims for all
  using (exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  ));

-- Policy documents: admins only
create policy "admins manage policies"
  on policy_documents for all
  using (exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  ));

-- Policy chunks: admins only
create policy "admins manage chunks"
  on policy_chunks for all
  using (exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  ));

-- Auto-create profile on signup
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Request logs for rate limiting
create table request_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  endpoint text,
  created_at timestamptz default now()
);
