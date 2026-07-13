import { json, sb } from "../_utils.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
  const [y, mo] = month.split("-").map(Number);
  const nextMonth = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, "0")}`;

  const categories = await sb(env, "categories?select=*&order=sort_order.asc");
  const txns = await sb(
    env,
    `transactions?select=amount,category_id&date=gte.${month}-01&date=lt.${nextMonth}-01`
  );

  const actualByCategory = {};
  for (const t of txns) {
    if (t.amount <= 0) continue; // skip refunds/incoming money for spend totals
    const key = t.category_id || "uncategorized";
    actualByCategory[key] = (actualByCategory[key] || 0) + Number(t.amount);
  }

  const summary = categories.map((c) => ({
    id: c.id,
    name: c.name,
    is_fixed: c.is_fixed,
    budget: Number(c.monthly_budget),
    actual: Number((actualByCategory[c.id] || 0).toFixed(2)),
  }));

  return json({ month, summary });
}
