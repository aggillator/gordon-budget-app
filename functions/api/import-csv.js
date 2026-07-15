import { json, sb, suggestCategory } from "../_utils.js";

// Manually-uploaded bank/credit-card CSV import. Unlike Plaid sync, there's
// no natural unique transaction id, so a deterministic one gets built from
// account + date + amount + description. Re-uploading the same file is
// therefore safe - matching rows just get merged, never duplicated.
//
// Separately: before inserting anything, this checks for a real (Plaid-
// synced) transaction already covering the same account+date+amount. If
// one exists, the CSV row is skipped entirely rather than inserted under a
// synthetic id - otherwise the same real-world transaction ends up as two
// rows (one from Plaid, one from this importer), since neither recognizes
// the other's id format as a match.
//
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

    const dates = rows.map((r) => r.date).filter(Boolean);
    const minDate = dates.reduce((min, d) => (d < min ? d : min), dates[0]);
    const maxDate = dates.reduce((max, d) => (d > max ? d : max), dates[0]);

    // Only real Plaid-sourced rows count as "already covered" - a prior
    // CSV import's own synthetic rows shouldn't block a fresh one (that
    // case is already handled below via the on_conflict upsert).
    const existing = await sb(
      env,
      `transactions?account_id=eq.${account_id}&date=gte.${minDate}&date=lte.${maxDate}&plaid_transaction_id=not.ilike.csv:*&select=date,amount`
    );
    const existingKeys = new Set(existing.map((t) => `${t.date}|${t.amount}`));

    const seen = new Map();
    let skipped = 0;
    const insertRows = [];

    for (const r of rows) {
      const name = (r.name || "").trim();
      const amount = Number(r.amount);
      const date = r.date;

      if (existingKeys.has(`${date}|${amount}`)) {
        skipped++;
        continue;
      }

      // Two or more genuinely identical-looking transactions on the same
      // day (e.g. two $4.50 coffees) would otherwise generate the same key
      // and make Postgres' ON CONFLICT fail with "cannot affect row a
      // second time" - so a repeat within this batch gets a numbered
      // suffix instead of colliding.
      const baseKey = `csv:${account_id}:${date}:${amount}:${name.slice(0, 40)}`;
      const count = seen.get(baseKey) || 0;
      seen.set(baseKey, count + 1);
      const key = count === 0 ? baseKey : `${baseKey}:dup${count}`;

      const category_id = suggestCategory(rules, { name, merchant_name: name });
      insertRows.push({
        plaid_transaction_id: key,
        account_id,
        date,
        name,
        merchant_name: name,
        amount,
        pending: false,
        category_id,
        category_source: category_id ? "auto" : "unassigned",
      });
    }

    if (insertRows.length) {
      await sb(env, "transactions?on_conflict=plaid_transaction_id", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: insertRows,
      });
    }

    return json({ ok: true, imported: insertRows.length, skipped });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
