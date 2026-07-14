import { json, plaid, sb, suggestCategory } from "../_utils.js";

// Bulk-handles added, modified, AND removed transactions - one or two
// requests per item instead of one request per row - so subrequests stay
// far under Cloudflare's 50/invocation cap even on a large first-time
// history pull (e.g. 2 years, which can include hundreds of pending->posted
// transitions showing up as "modified" on the very first sync page).
const BATCH_SIZE = 100;

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

      // New transactions: full row, including a fresh category suggestion.
      const addedRows = [];
      for (const t of page.added) {
        const account = accounts.find((a) => a.plaid_account_id === t.account_id);
        if (!account) continue;
        const category_id = suggestCategory(rules, t);
        addedRows.push({
          plaid_transaction_id: t.transaction_id,
          account_id: account.id,
          date: t.date,
          name: t.name,
          merchant_name: t.merchant_name,
          amount: t.amount,
          pending: t.pending,
          category_id,
          category_source: category_id ? "auto" : "unassigned",
        });
      }
      if (addedRows.length) {
        await sb(env, "transactions?on_conflict=plaid_transaction_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates",
          body: addedRows,
        });
        added += addedRows.length;
      }

      // Modified transactions (e.g. pending -> posted): refresh only the raw
      // bank fields. category_id/category_source are deliberately omitted so
      // existing categorization - manual, AI, or rule-based - always survives.
      const modifiedRows = [];
      for (const t of page.modified) {
        const account = accounts.find((a) => a.plaid_account_id === t.account_id);
        if (!account) continue;
        modifiedRows.push({
          plaid_transaction_id: t.transaction_id,
          account_id: account.id,
          date: t.date,
          name: t.name,
          merchant_name: t.merchant_name,
          amount: t.amount,
          pending: t.pending,
        });
      }
      if (modifiedRows.length) {
        await sb(env, "transactions?on_conflict=plaid_transaction_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates",
          body: modifiedRows,
        });
        modified += modifiedRows.length;
      }

      // Removed transactions: one bulk DELETE instead of one per row.
      if (page.removed.length) {
        const ids = page.removed.map((t) => encodeURIComponent(t.transaction_id));
        await sb(env, `transactions?plaid_transaction_id=in.(${ids.join(",")})`, {
          method: "DELETE",
        });
        removed += page.removed.length;
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
