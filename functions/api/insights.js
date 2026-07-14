import { json, sb } from "../_utils.js";

// Per-category spending stats across the full transaction history:
// average monthly spend (total / number of calendar months tracked, so
// occasional categories average out correctly), plus the min/max single
// month and how many of those months actually had activity.
export async function onRequestGet({ env }) {
  const categories = await sb(
    env,
    "categories?select=*&exclude_from_budget=eq.false&order=name.asc"
  );
  const txns = await sb(env, "transactions?select=amount,category_id,date&order=date.asc");

  if (!txns.length) {
    return json({ months_tracked: 0, categories: [] });
  }

  const firstDate = new Date(txns[0].date);
  const lastDate = new Date(txns[txns.length - 1].date);
  const monthsTracked =
    (lastDate.getUTCFullYear() - firstDate.getUTCFullYear()) * 12 +
    (lastDate.getUTCMonth() - firstDate.getUTCMonth()) +
    1;

  const byCategoryMonth = {};
  for (const t of txns) {
    if (t.amount <= 0) continue; // spend only, skip refunds/deposits
    if (!t.category_id) continue;
    const month = t.date.slice(0, 7);
    (byCategoryMonth[t.category_id] ||= {})[month] =
      (byCategoryMonth[t.category_id]?.[month] || 0) + Number(t.amount);
  }

  const result = categories.map((c) => {
    const monthMap = byCategoryMonth[c.id] || {};
    const monthTotals = Object.values(monthMap);
    const total = monthTotals.reduce((a, b) => a + b, 0);
    return {
      id: c.id,
      name: c.name,
      budget: Number(c.monthly_budget),
      total: Number(total.toFixed(2)),
      average: Number((monthsTracked > 0 ? total / monthsTracked : 0).toFixed(2)),
      min: Number((monthTotals.length ? Math.min(...monthTotals) : 0).toFixed(2)),
      max: Number((monthTotals.length ? Math.max(...monthTotals) : 0).toFixed(2)),
      active_months: monthTotals.length,
    };
  });

  return json({ months_tracked: monthsTracked, categories: result });
}
