import { json, sb } from "../_utils.js";

// Matches Amazon order-history rows (already grouped/parsed client-side) to
// existing transactions by amount (close match) + date (within ~10 days,
// since Amazon often charges a few days after ordering) and renames the
// transaction to the item title(s). Never touches a transaction that
// already has a custom_name - that's treated as already labeled, by you or
// a previous import run.
//
// Two-pass matching: first try the full order total against one
// transaction. If that fails, fall back to matching each item in the order
// individually - Amazon frequently splits one order into several separate
// charges as items ship at different times, so the combined total often
// won't equal any single real transaction even though every item in it
// does correspond to one.
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

    function findMatch(orderDate, amount) {
      let best = null;
      let bestDiff = Infinity;
      for (const t of candidates) {
        if (used.has(t.id)) continue;
        if (Math.abs(Math.abs(t.amount) - amount) > 0.02) continue;
        const dateDiff = Math.abs(new Date(t.date) - orderDate) / 86400000;
        if (dateDiff > 21) continue;
        if (dateDiff < bestDiff) {
          bestDiff = dateDiff;
          best = t;
        }
      }
      return best;
    }

    for (const order of orders) {
      if (!order.date) {
        unmatched.push(order);
        continue;
      }
      const orderDate = new Date(order.date);
      let matchedAny = false;

      if (order.amount) {
        const best = findMatch(orderDate, order.amount);
        if (best) {
          used.add(best.id);
          await sb(env, `transactions?id=eq.${best.id}`, {
            method: "PATCH",
            body: { custom_name: order.title },
          });
          matched++;
          matchedAny = true;
        }
      }

      if (!matchedAny && Array.isArray(order.items) && order.items.length > 1) {
        for (const item of order.items) {
          if (!item.amount) continue;
          const best = findMatch(orderDate, item.amount);
          if (best) {
            used.add(best.id);
            await sb(env, `transactions?id=eq.${best.id}`, {
              method: "PATCH",
              body: { custom_name: item.title },
            });
            matched++;
            matchedAny = true;
          }
        }
      }

      if (!matchedAny) unmatched.push(order);
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
