import { json, sb, logAction } from "../_utils.js";

export async function onRequestGet({ env }) {
  const rows = await sb(env, "categories?select=*&order=sort_order.asc");
  return json(rows);
}

export async function onRequestPost({ request, env }) {
  const { name, monthly_budget, is_fixed, exclude_from_budget, exclude_from_trends } = await request.json();
  if (!name) return json({ error: "name required" }, 400);
  const [row] = await sb(env, "categories", {
    method: "POST",
    prefer: "return=representation",
    body: {
      name,
      monthly_budget: monthly_budget || 0,
      is_fixed: !!is_fixed,
      exclude_from_budget: !!exclude_from_budget,
      exclude_from_trends: !!exclude_from_trends,
      sort_order: 50,
    },
  });
  return json(row);
}

export async function onRequestPatch({ request, env }) {
  const { id, monthly_budget, name, exclude_from_budget, exclude_from_trends } = await request.json();
  if (!id) return json({ error: "id required" }, 400);
  const body = {};
  if (monthly_budget !== undefined) body.monthly_budget = monthly_budget;
  if (name !== undefined) body.name = name;
  if (exclude_from_budget !== undefined) body.exclude_from_budget = exclude_from_budget;
  if (exclude_from_trends !== undefined) body.exclude_from_trends = exclude_from_trends;
  await sb(env, `categories?id=eq.${id}`, { method: "PATCH", body });
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, 400);

  const [category] = await sb(env, `categories?id=eq.${id}&select=*`);
  if (!category) return json({ error: "not found" }, 404);

  const affected = await sb(
    env,
    `transactions?category_id=eq.${id}&select=id,category_id,category_source`
  );

  const uncategorized = await sb(env, "rpc/delete_category", {
    method: "POST",
    body: { target_id: id },
  });

  await logAction(env, "category_delete", `Deleted category "${category.name}"`, {
    category,
    transactions: affected.map((t) => ({
      id: t.id,
      prior_category_id: t.category_id,
      prior_category_source: t.category_source,
    })),
  });

  return json({ ok: true, uncategorized });
}
