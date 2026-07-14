# Ledger — a free, self-hosted budget tracker

Cloudflare Pages (hosting + API) + Supabase (database) + Plaid (bank sync).
Total cost: $0, as long as you stay on free tiers (should be permanent for one person, a few accounts).

## 1. Plaid — bank connection (free Trial plan)

1. Sign up at https://dashboard.plaid.com/signup
2. Because your team is created after April 15, 2026, you're automatically on the **free Trial plan** — real bank data, up to 10 connected accounts, no cost. (Dashboard → Team Settings → Plan will confirm this.)
3. Dashboard → Keys: copy your `client_id` and `secret` (use the **Production** secret — Trial runs on production infrastructure, not sandbox, so you can link your real Amex/PayPal/bank accounts).
4. Note: some smaller banks may need manual "Limited Production" approval for OAuth — the big ones (Chase, BofA, Wells Fargo, Amex) work immediately on Trial.

## 2. Supabase — database (free tier)

1. Create a project at https://supabase.com/dashboard
2. Go to SQL Editor → paste the contents of `schema.sql` from this project → Run. This creates all tables and seeds your current categories/budgets.
3. Go to Project Settings → API. Copy:
   - **Project URL**
   - **service_role key** (NOT the anon key — the frontend never talks to Supabase directly, only your Cloudflare Functions do, using this key)

## 3. Cloudflare Pages — hosting + API

1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build settings: no build command needed, output directory = `public`.
4. Deploy, then go to Settings → Environment variables and add these (as **secrets**, all environments):

   | Variable | Value |
   |---|---|
   | `PLAID_CLIENT_ID` | from Plaid dashboard |
   | `PLAID_SECRET` | from Plaid dashboard (production secret) |
   | `PLAID_ENV` | `production` |
   | `SUPABASE_URL` | from Supabase settings |
   | `SUPABASE_SERVICE_KEY` | service_role key from Supabase |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com (only needed for AI categorization — costs a small amount per use, unlike everything else here) |

5. Redeploy (Deployments → Retry deployment) so the functions pick up the new env vars.

## 4. Lock the site down — important

This app will hold live bank transaction data with no login screen built in. Before you put real credentials behind it:

- Cloudflare Zero Trust → Access → Applications → add your Pages domain, restrict to your email only. Free for up to 50 users, and it's the easiest way to keep this private without writing your own auth.

## 5. Using it

- **Connect a bank**: click "Connect a bank," log in through Plaid's widget (same flow your bank's own app uses), done.
- **Sync transactions**: click "Sync transactions" any time to pull new activity. You can also hit `POST /api/sync-transactions` from a scheduled trigger (Cloudflare Cron Triggers, free) if you want it to run daily on its own — ask me if you want that wired up.
- **Search**: the search box above the transaction list matches merchant name or description across all months (not just the one currently selected) - it's meant for "did I buy this somewhere" lookups, not month-scoped browsing.
- **Categorization**: new transactions are auto-suggested using the keyword rules in the `category_rules` table (seeded with a few of yours — Aisle One → Groceries, GasBuddy → Gas, etc.). Anything left unassigned can be run through **Categorize with AI**, which uses Claude Haiku to pick the best-fitting existing category — and if nothing fits, it can propose and create a brand-new category on its own (capped at 5 new categories per run, as a safety limit). It's instructed to keep categories broad (a spending TYPE, like "Eating Out" or "Insurance") rather than merchant-specific ("Dunkin", "Life Insurance") - if it still drifts too specific, just merge categories in Supabase's Table Editor and it'll settle over time as more transactions land in the broader one. New categories start at a $0 budget — edit the cap in "Manage categories" once you see what landed there. Every dropdown in the transaction list also lets you override manually; overrides are remembered as "manual" so future syncs and AI runs won't touch them.
- **Category propagation**: manually setting a transaction's category applies it to every other transaction from that same merchant that isn't already manually set, and saves a keyword rule so future syncs categorize that merchant automatically too.
- **Filtering**: the category dropdown in the header filters the transaction list to just that category, or to everything still unassigned.
- **Source account**: each transaction shows which connected account it came from (Amex, Schwab checking, PayPal, etc.) under the merchant name.
- **Budgets & categories**: the "Manage categories" panel at the bottom lets you edit any monthly cap directly, or add a brand-new custom category.

## What's not built yet (intentionally left for a v2)

- Multi-month trend charts
- Automatic nightly sync (needs a Cloudflare Cron Trigger, ~5 min to add)
- Splitting "Phone/Internet" back into Verizon/Boost/Ooma if you want that granularity
- Deleting/archiving categories from the UI (currently add/edit only — delete via Supabase Table Editor)

## File map

```
schema.sql                       — run once in Supabase
functions/_utils.js              — shared Supabase/Plaid helpers
functions/api/create-link-token  — starts the Plaid Link flow
functions/api/exchange-token     — finishes linking a bank, saves accounts
functions/api/sync-transactions  — pulls transactions from Plaid into Supabase
functions/api/transactions       — list + recategorize transactions
functions/api/categories         — list categories/budgets
functions/api/summary            — budget vs. actual per category per month
public/                          — the dashboard (plain HTML/JS, no build step)
```
