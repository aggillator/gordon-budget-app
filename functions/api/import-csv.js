import { json, sb, suggestCategory } from "../_utils.js";

// Manually-uploaded bank/credit-card CSV import. Unlike Plaid sync, there's
// no natural unique transaction id, so we build a deterministic one from
// account + date + amount + description. Re-uploading the same file is
// therefore safe - matching rows just get merged, never duplicated.
// amount convention matches the rest of the app: positive = money out,
// negative = money in. If the source CSV uses the opposite convention,
// the frontend flips sign client-side before sending.
export async function onRequestPost({ request, env }) {
  try {
    const { account_id, rows } = await request.json();
    if (!account_id) return json({ error: "account_id required" }, 400);
    if (!Array.isArray(rows) || !rows.length) {
      return json({ error: "rows array required" }, 400);
    }

    const rules = await sb(env, "category_rules?select=*");

    const insertRows = rows.map((r) => {
      const name = (r.name || "").trim();
      const amount = Number(r.amount);
      const date = r.date;
      const key = `csv:${account_id}:${date}:${amount}:${name.slice(0, 40)}`;
      const category_id = suggestCategory(rules, { name, merchant_name: name });
      return {
        plaid_transaction_id: key,
        account_id,
        date,
        name,
        merchant_name: name,
        amount,
        pending: false,
        category_id,
        category_source: category_id ? "auto" : "unassigned",
      };
    });

    await sb(env, "transactions?on_conflict=plaid_transaction_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: insertRows,
    });

    return json({ ok: true, imported: insertRows.length });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
