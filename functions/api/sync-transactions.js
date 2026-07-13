import { json, plaid, sb, suggestCategory } from "../_utils.js";

// Processes ONE small batch per call (bounded subrequest count) instead of
// looping until fully caught up — Cloudflare Pages Functions cap requests at
// 50 subrequests each, and a full first-time history sync blows past that.
// The frontend calls this endpoint repeatedly (see app.js) until hasMore=false.
const BATCH_SIZE = 20;

export async function onRequestPost({ env }) {
  try {
    const items = await sb(env, "plaid_items?select=*");
    const accounts = await sb(env, "accounts?select=*");
    const rules = await sb(env, "category_rules?select=*");

    let added = 0,
      modified = 0,
      removed = 0,
      hasMore = false;

    for (const item of items) {
      const cursor = item.cursor || null;

      const page = await plaid(env, "/transactions/sync", {
        access_token: item.access_token,
        cursor: cursor || undefined,
        count: BATCH_SIZE,
      });

      for (const t of page.added) {
        const account = accounts.find((a) => a.plaid_account_id === t.account_id);
        if (!account) continue;
        const category_id = suggestCategory(rules, t);
        await sb(env, "transactions?on_conflict=plaid_transaction_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates",
          body: {
            plaid_transaction_id: t.transaction_id,
            account_id: account.id,
            date: t.date,
            name: t.name,
            merchant_name: t.merchant_name,
            amount: t.amount,
            pending: t.pending,
            category_id,
            category_source: category_id ? "auto" : "unassigned",
          },
        });
        added++;
      }

      for (const t of page.modified) {
        await sb(env, `transactions?plaid_transaction_id=eq.${t.transaction_id}`, {
          method: "PATCH",
          body: { amount: t.amount, pending: t.pending, name: t.name },
        });
        modified++;
      }

      for (const t of page.removed) {
        await sb(env, `transactions?plaid_transaction_id=eq.${t.transaction_id}`, {
          method: "DELETE",
        });
        removed++;
      }

      await sb(env, `plaid_items?id=eq.${item.id}`, {
        method: "PATCH",
        body: { cursor: page.next_cursor },
      });

      if (page.has_more) hasMore = true;
    }

    return json({ added, modified, removed, hasMore });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
