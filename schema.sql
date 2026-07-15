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
  exclude_from_budget boolean default false, -- true = tracked but not counted in the monthly Budget vs Actual view
  exclude_from_trends boolean default false, -- true = not counted in whole-household income/spending trends (internal transfers, card payments, etc.) - separate concern from exclude_from_budget: e.g. "Income" is excluded from budget but must NOT be excluded from trends
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
  category_source text default 'unassigned', -- 'auto' | 'manual' | 'unassigned' | 'ai' | 'rule'
  custom_name text, -- user-set display name override, e.g. from the Amazon import - never touched by sync
  plaid_category text, -- Plaid's own merchant-categorization engine output, when provided - fed to the AI categorizer as an extra hint
  pending boolean default false,
  created_at timestamptz default now()
);

create index if not exists idx_transactions_date on transactions(date);
create index if not exists idx_transactions_category on transactions(category_id);

-- Once a transaction is manually categorized, nothing (sync, AI, keyword
-- rules) is ever allowed to silently change it back - this is enforced here
-- at the database level so it holds regardless of which code path touches
-- the row, now or in the future.
create or replace function protect_manual_category()
returns trigger as $$
begin
  if OLD.category_source = 'manual' and NEW.category_source is distinct from 'manual' then
    NEW.category_id := OLD.category_id;
    NEW.category_source := OLD.category_source;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists trg_protect_manual_category on transactions;
create trigger trg_protect_manual_category
before update on transactions
for each row execute function protect_manual_category();

-- Deletes a category, uncategorizing any transactions currently assigned to
-- it first. Deliberately bypasses the trigger above for this operation only -
-- deleting the category itself is an explicit user action that should always
-- free up its transactions, manual or not.
create or replace function delete_category(target_id uuid)
returns integer as $$
declare
  affected integer;
begin
  set local session_replication_role = replica;
  update transactions set category_id = null, category_source = 'unassigned' where category_id = target_id;
  get diagnostics affected = row_count;
  set local session_replication_role = default;
  delete from categories where id = target_id;
  return affected;
end;
$$ language plpgsql security definer;

-- Merges one category into another: moves every transaction and keyword
-- rule from source to target, combines their budgets, deletes source. Same
-- trigger-bypass reasoning as delete_category above.
create or replace function merge_category(source_id uuid, target_id uuid)
returns integer as $$
declare
  affected integer;
begin
  if source_id = target_id then
    raise exception 'source and target categories are the same';
  end if;

  set local session_replication_role = replica;
  update transactions set category_id = target_id where category_id = source_id;
  get diagnostics affected = row_count;
  set local session_replication_role = default;

  update category_rules set category_id = target_id where category_id = source_id;

  update categories set monthly_budget = monthly_budget + (select monthly_budget from categories where id = source_id)
  where id = target_id;

  delete from categories where id = source_id;

  return affected;
end;
$$ language plpgsql security definer;

-- Undo log for bulk actions (AI categorize runs, category deletion,
-- category-with-propagation changes). Each row stores exactly what's needed
-- to reverse it - see functions/api/undo.js.
create table if not exists action_log (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  description text not null,
  snapshot jsonb not null,
  created_at timestamptz default now(),
  undone boolean default false
);

create index if not exists idx_action_log_created on action_log(created_at desc);

-- Queue of possible refund/transfer matches the automatic matcher wasn't
-- confident enough to apply on its own - see find-refunds.js,
-- find-transfers.js, and suggested-matches.js.
create table if not exists suggested_matches (
  id uuid primary key default gen_random_uuid(),
  match_type text not null, -- 'transfer' | 'refund'
  transaction_id_a uuid references transactions(id) on delete cascade,
  transaction_id_b uuid references transactions(id) on delete cascade,
  category_id uuid references categories(id) on delete cascade,
  reason text,
  created_at timestamptz default now(),
  resolved boolean default false
);

create index if not exists idx_suggested_matches_pending on suggested_matches(resolved) where resolved = false;

-- Seed categories (broad spending types, not specific merchants/brands -
-- edit amounts any time in the app)
insert into categories (name, monthly_budget, is_fixed, sort_order) values
  ('Rent', 1850, true, 1),
  ('Tuition', 445, true, 2),
  ('Insurance', 273.32, true, 3),
  ('Electric (PSEG)', 265, true, 5),
  ('Phone/Internet', 108, true, 6),  -- Verizon+Boost+Ooma combined, split later if you want
  ('Child Support', 800, true, 8),
  ('Credit Card Payments', 476, true, 9),
  ('Groceries', 600, false, 10),
  ('Gas', 150, false, 11),
  ('Rideshare', 100, false, 12),
  ('Eating Out', 40, false, 13),
  ('Healthcare', 50, false, 14),
  ('Kids/Misc', 160, false, 16),
  ('Knife/EDC Hobby', 75, false, 17),
  ('Food Delivery', 75, false, 18),
  ('Uncategorized', 0, false, 99)
on conflict (name) do nothing;

-- A few starter auto-categorization rules — add more from the app as you go.
-- The AI categorizer is instructed to prefer broad categories like these
-- (a spending TYPE) over specific merchant/brand names.
insert into category_rules (keyword, category_id)
  select 'aisle one', id from categories where name = 'Groceries'
union all select 'gasbuddy', id from categories where name = 'Gas'
union all select 'uber eats', id from categories where name = 'Food Delivery'
union all select 'uber', id from categories where name = 'Rideshare'
union all select 'cvs', id from categories where name = 'Healthcare'
union all select 'dunkin', id from categories where name = 'Eating Out'
union all select 'paypal', id from categories where name = 'Credit Card Payments'
on conflict do nothing;
