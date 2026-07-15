import { json, sb } from "../_utils.js";

// Per-month income, spending, and net across the requested date range
// (defaults to full history). Uses exclude_from_trends specifically -
// NOT exclude_from_budget - since those are different concerns: a category
// can legitimately be hidden from the spend-focused Budget view (like
// "Income", which isn't a spend category at all) while still needing to
// count fully here. exclude_from_trends is for actual internal transfers -
// money moving between your own accounts (card payments, savings,
// Maaser) - that shouldn't be counted as new income or new spending twice.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  const excluded = await sb(env, "categories?select=id&exclude_from_trends=eq.true");
  const excludedIds = new Set(excluded.map((c) => c.id));

  let path = "transactions?select=date,amount,category_id&order=date.asc";
  if (dateFrom) path += `&date=gte.${dateFrom}`;
  if (dateTo) path += `&date=lte.${dateTo}`;

  const txns = await sb(env, path);

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
