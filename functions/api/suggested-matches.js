import { json, sb } from "../_utils.js";

export async function onRequestGet({ env }) {
  const rows = await sb(
    env,
    `suggested_matches?resolved=eq.false&select=*,txn_a:transactions!suggested_matches_transaction_id_a_fkey(id,date,name,merchant_name,custom_name,amount),txn_b:transactions!suggested_matches_transaction_id_b_fkey(id,date,name,merchant_name,custom_name,amount),categories(name)&order=created_at.desc`
  );
  return json(rows);
}

// action: "accept" applies the match (refund: excludes both sides;
// transfer: excludes only transaction_id_a, the identified pass-through
// side). "reject" just marks it resolved without changing any transaction.
export async function onRequestPost({ request, env }) {
  const { id, action } = await request.json();
  if (!id || !["accept", "reject"].includes(action)) {
    return json({ error: "id and action ('accept'|'reject') required" }, 400);
  }

  const [entry] = await sb(env, `suggested_matches?id=eq.${id}&select=*`);
  if (!entry) return json({ error: "not found" }, 404);

  if (action === "accept") {
    const idsToExclude =
      entry.match_type === "refund"
        ? [entry.transaction_id_a, entry.transaction_id_b]
        : [entry.transaction_id_a];
    await sb(env, `transactions?id=in.(${idsToExclude.join(",")})`, {
      method: "PATCH",
      body: { category_id: entry.category_id, category_source: "manual" },
    });
  }

  await sb(env, `suggested_matches?id=eq.${id}`, {
    method: "PATCH",
    body: { resolved: true },
  });

  return json({ ok: true });
}
