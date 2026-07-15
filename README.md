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
- **Categorization**: new transactions are auto-suggested using the keyword rules in the `category_rules` table (seeded with a few of yours — Aisle One → Groceries, GasBuddy → Gas, etc.). Anything left unassigned can be run through **Categorize with AI**, which uses Claude Haiku to pick the best-fitting existing category — and if nothing fits, it can propose and create a brand-new category on its own (capped at 5 new categories per run, as a safety limit). It's instructed to keep categories broad (a spending TYPE, like "Eating Out" or "Insurance") rather than merchant-specific ("Dunkin", "Life Insurance") - if it still drifts too specific, just merge categories in Supabase's Table Editor and it'll settle over time as more transactions land in the broader one. New categories start at a $0 budget — edit the cap in "Manage categories" once you see what landed there. Every dropdown in the transaction list also lets you override manually; overrides are remembered as "manual" so future syncs and AI runs won't touch them. This is enforced by a database trigger (`protect_manual_category`), not just app logic — once a transaction is manually categorized, nothing can silently change it back, regardless of which code path touches the row.
- **Category propagation**: manually setting a transaction's category applies it to every other transaction from that same merchant that isn't already manually set, and saves a keyword rule so future syncs categorize that merchant automatically too.
- **Filtering**: the category dropdown in the header filters the transaction list to just that category, or to everything still unassigned.
- **Source account**: each transaction shows which connected account it came from (Amex, Schwab checking, PayPal, etc.) under the merchant name.
- **Budgets & categories**: the "Manage categories" panel at the bottom lets you edit any monthly cap directly, or add a brand-new custom category.
- **Quick-add categories**: every transaction's category dropdown also has a "+ New category..." option at the bottom - pick it, type a name, and choose whether it should count toward the budget or not. No need to scroll to "Manage categories" for one-off additions.
- **Non-budget categories**: categories marked "not a budget category" (income, Maaser, transfers, etc.) are fully usable for filtering and searching, but never show up in the Budget vs. Actual view, and their budget field is locked at $0 in "Manage categories" - they're for tracking, not capping.
- **Deleting categories**: the × next to each category in "Manage categories" deletes it. Transactions in that category aren't deleted - they just become uncategorized again, ready to be re-sorted by a rule, AI, or manually.
- **Click a category to filter**: clicking any row in "Budget vs. actual" filters the transaction list to that category and scrolls you down to it. "× Clear filter" next to the category dropdown resets back to the full list.
- **Editable transaction names**: click into the merchant/description text on any transaction to rename it for display. This is stored separately from the raw bank data, so a future sync never overwrites your rename.
- **Alphabetized everywhere**: the category filter, every per-transaction category picker, and the "Manage categories" list are all sorted A-Z. The Budget vs. Actual summary keeps its original logical order (fixed bills first, etc.) since that's a different use case.
- **Advanced filters**: collapsible panel with date range (overrides the month picker when set), deposits-only/withdrawals-only, min/max amount, and which connected account. All combine with the category filter and search. Whatever's active also applies to the PDF export, so what you see is what you get.
- **Spending breakdown chart**: collapsible pie chart of the selected month's actual spend by category. Opens lazily (only renders when you expand it) and updates when you change the month while it's open.
- **Manage categories moved to the top** of the page, still collapsed by default so it stays out of the way until you need it.
- **Connected accounts panel**: lists every linked institution with its account names and transaction count, and a Disconnect button per institution. Disconnecting revokes Plaid's access token (stops billing/syncing on Plaid's side) and permanently deletes that account's transaction history from Supabase. This does NOT free up a Trial-plan Item slot - Plaid counts every Item ever created, removed or not.
- **Spending averages**: collapsible table of average monthly spend per category, computed across your full transaction history (total spend ÷ number of calendar months tracked, so a category you don't hit every month still averages correctly). Also shows the lowest and highest single month for each category. Click any column header to sort by it, click again to flip direction.
- **Sort transactions**: dropdown next to the search box - newest/oldest first, or highest/lowest amount first.
- **Amazon order import**: upload a CSV export of your Amazon order history and it matches item titles to your existing Amazon transactions by amount + date, renaming them via the same `custom_name` field used elsewhere. Column names in Amazon's export have changed over the years, so there's a mapping step - it guesses which CSV column is date/title/amount/order-ID and lets you correct it if the guess is wrong. Never overwrites a transaction you've already renamed (manually or from a prior import).
- **Bank/credit card CSV import**: for history older than what your bank shares through Plaid, upload a statement CSV directly - pick the account, map the columns (handles both a single signed amount column and separate withdrawal/deposit columns), and it imports the same way a Plaid sync would. Before inserting anything, it checks whether a real Plaid-synced transaction already covers that account+date+amount and skips it if so - this is what prevents the same real-world transaction from ending up as two separate rows (one from Plaid, one from the CSV), which is what caused a duplicate-transactions bug earlier. Safe to re-upload the same file; repeat rows just get merged.
- **Confirmation before category propagation**: setting a transaction's category now shows how many *other* transactions share the same merchant (or item name, if it has one) before applying to all of them - you can choose "just this one" instead. This also fixed a real bug: propagation now matches on `custom_name` (the specific item title) when one exists, instead of always falling back to the generic merchant name - previously, recategorizing one Amazon item could sweep in every other Amazon purchase, since they all share the same generic merchant name. Matching on the item title instead is much more precise.
- **Undo for bulk actions**: an AI categorization run, a category deletion, or a category-with-propagation change can all be undone from the "Recent actions" panel. Each restores the prior category assignment for everything that action touched. A transaction manually recategorized *after* the action being undone is protected and won't get reverted out from under a newer edit (enforced by the same database trigger that protects manual categorization elsewhere). Bulk transaction deletion (below) is intentionally not undoable - it's a deliberate, reviewed action with its own confirmation dialog, not something that silently ripples outward the way propagation can.
- **Bulk transaction selection**: checkboxes on each transaction, "Select all shown" (respects whatever filters/search are active), and a "Delete selected" button with a confirmation dialog. Deletion is permanent.

## Backfilling more than 90 days of history

Plaid defaults to 90 days of history for a newly linked account, unless `days_requested` is set - which `create-link-token.js` now does (730 days / 2 years). This can't be applied retroactively to an already-linked account; Plaid requires removing and re-linking it. To backfill an existing account:

1. Open "Connected accounts" → Disconnect the institution you want more history for
2. Click "Connect a bank" and re-link that same institution - it'll now request 2 years of history
3. Hit Sync
4. Repeat for each account you want backfilled

Each re-link uses a new Trial-plan Item slot (10 total, non-renewable even after disconnecting) - worth doing deliberately rather than for every account reflexively if you're close to the limit.

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
