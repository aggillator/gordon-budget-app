import { json, sb } from "../_utils.js";

// Per-month income, spending, and net across full history, excluding
// anything in a budget-excluded category (internal transfers, refunded
// purchases, Maaser, etc.) so transfers between your own accounts don't
// inflate either side.
export async function onRequestGet({ env }) {
  const excluded = await sb(env, "categories?select=id&exclude_from_budget=eq.true");
  const excludedIds = new Set(excluded.map((c) => c.id));

  const txns = await sb(env, "transactions?select=date,amount,category_id&order=date.asc");

  const byMonth = {};
  for (const t of txns) {
    if (t.category_id && excludedIds.has(t.category_id)) continue;
    const month = t.date.slice(0, 7);
    (byMonth[month] ||= { income: 0, spending: 0 });
    if (t.amount < 0) byMonth[month].income += -t.amount;
    else byMonth[month].spending += t.amount;
  }

  const months = Object.keys(byMonth).sort();
  const rows = months.map((m) => ({
    month: m,
    income: Number(byMonth[m].income.toFixed(2)),
    spending: Number(byMonth[m].spending.toFixed(2)),
    net: Number((byMonth[m].income - byMonth[m].spending).toFixed(2)),
  }));

  const avg = (key) =>
    rows.length ? rows.reduce((s, r) => s + r[key], 0) / rows.length : 0;

  return json({
    months: rows,
    averages: {
      income: Number(avg("income").toFixed(2)),
      spending: Number(avg("spending").toFixed(2)),
      net: Number(avg("net").toFixed(2)),
    },
  });
}
