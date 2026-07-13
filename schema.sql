-- Budget Tracker schema
-- Run this in Supabase: Dashboard > SQL Editor > New query > paste > Run

create table if not exists plaid_items (
  id uuid primary key default gen_random_uuid(),
  item_id text unique not null,
  access_token text not null,          -- Plaid access token (server-side only, never exposed to frontend)
  institution_name text,
  cursor text,                          -- Plaid transactions sync cursor
  created_at timestamptz default now()
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  plaid_item_id uuid references plaid_items(id) on delete cascade,
  plaid_account_id text unique not null,
  name text not null,
  mask text,
  type text,
  subtype text,
  created_at timestamptz default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  monthly_budget numeric(10,2) not null default 0,
  is_fixed boolean default false,       -- true = fixed bill (rent, tuition), false = variable/discretionary
  sort_order int default 0
);

create table if not exists category_rules (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,                -- lowercase substring matched against merchant/name
  category_id uuid references categories(id) on delete cascade
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  plaid_transaction_id text unique not null,
  account_id uuid references accounts(id) on delete cascade,
  date date not null,
  name text not null,
  merchant_name text,
  amount numeric(10,2) not null,        -- positive = money out, negative = money in (Plaid convention)
  category_id uuid references categories(id),
  category_source text default 'unassigned', -- 'auto' | 'manual' | 'unassigned'
  pending boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_transactions_date on transactions(date);
create index if not exists idx_transactions_category on transactions(category_id);

-- Seed categories from the current budget (edit amounts any time in the app)
insert into categories (name, monthly_budget, is_fixed, sort_order) values
  ('Rent', 1850, true, 1),
  ('Tuition', 445, true, 2),
  ('Car Insurance', 208, true, 3),
  ('Renters Insurance', 28.32, true, 4),
  ('Electric (PSEG)', 265, true, 5),
  ('Phone/Internet', 108, true, 6),  -- Verizon+Boost+Ooma combined, split later if you want
  ('Life Insurance', 37, true, 7),
  ('Child Support', 800, true, 8),
  ('Credit Card Payments', 476, true, 9),
  ('Groceries', 600, false, 10),
  ('Gas', 150, false, 11),
  ('Uber Rides', 100, false, 12),
  ('Uber Eats', 75, false, 13),
  ('CVS/Pharmacy', 50, false, 14),
  ('Dunkin', 40, false, 15),
  ('Kids/Misc', 160, false, 16),
  ('Knife/EDC Hobby', 75, false, 17),
  ('Uncategorized', 0, false, 99)
on conflict (name) do nothing;

-- A few starter auto-categorization rules — add more from the app as you go
insert into category_rules (keyword, category_id)
  select 'aisle one', id from categories where name = 'Groceries'
union all select 'gasbuddy', id from categories where name = 'Gas'
union all select 'uber eats', id from categories where name = 'Uber Eats'
union all select 'uber', id from categories where name = 'Uber Rides'
union all select 'cvs', id from categories where name = 'CVS/Pharmacy'
union all select 'dunkin', id from categories where name = 'Dunkin'
union all select 'paypal', id from categories where name = 'Credit Card Payments'
on conflict do nothing;
