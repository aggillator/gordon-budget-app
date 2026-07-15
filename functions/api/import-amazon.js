import { json, sb } from "../_utils.js";

// Matches Amazon order-history rows (already grouped/parsed client-side) to
// existing transactions by amount (close match) + date (within ~10 days,
// since Amazon often charges a few days after ordering) and renames the
// transaction to the item title(s). Never touches a transaction that
// already has a custom_name - that's treated as already labeled, by you or
// a previous import run.
export async function onRequestPost({ request, env }) {
  try {
    const { orders } = await request.json();
    if (!Array.isArray(orders) || !orders.length) {
      return json({ error: "orders array required" }, 400);
    }

    const candidates = await sb(
      env,
      `transactions?select=id,date,amount&custom_name=is.null&or=(merchant_name.ilike.*amazon*,name.ilike.*amazon*)`
    );

    const used = new Set();
    let matched = 0;
    const unmatched = [];

    for (const order of orders) {
      if (!order.date || !order.amount) {
        unmatched.push(order);
        continue;
      }
      const orderDate = new Date(order.date);
      let best = null;
      let bestDiff = Infinity;

      for (const t of candidates) {
        if (used.has(t.id)) continue;
        if (Math.abs(Math.abs(t.amount) - order.amount) > 0.02) continue;
        const dateDiff = Math.abs(new Date(t.date) - orderDate) / 86400000;
        if (dateDiff > 10) continue;
        if (dateDiff < bestDiff) {
          bestDiff = dateDiff;
          best = t;
        }
      }

      if (best) {
        used.add(best.id);
        await sb(env, `transactions?id=eq.${best.id}`, {
          method: "PATCH",
          body: { custom_name: order.title },
        });
        matched++;
      } else {
        unmatched.push(order);
      }
    }

    return json({
      matched,
      total: orders.length,
      unmatched: unmatched.slice(0, 10),
    });
  } catch (err) {
    return json({ error: err.message, stack: err.stack }, 500);
  }
}
