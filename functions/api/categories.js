import { json, sb } from "../_utils.js";

export async function onRequestGet({ env }) {
  const rows = await sb(env, "categories?select=*&order=sort_order.asc");
  return json(rows);
}

export async function onRequestPost({ request, env }) {
  const { name, monthly_budget, is_fixed, exclude_from_budget } = await request.json();
  if (!name) return json({ error: "name required" }, 400);
  const [row] = await sb(env, "categories", {
    method: "POST",
    prefer: "return=representation",
    body: {
      name,
      monthly_budget: monthly_budget || 0,
      is_fixed: !!is_fixed,
      exclude_from_budget: !!exclude_from_budget,
      sort_order: 50,
    },
  });
  return json(row);
}

export async function onRequestPatch({ request, env }) {
  const { id, monthly_budget, name, exclude_from_budget } = await request.json();
  if (!id) return json({ error: "id required" }, 400);
  const body = {};
  if (monthly_budget !== undefined) body.monthly_budget = monthly_budget;
  if (name !== undefined) body.name = name;
  if (exclude_from_budget !== undefined) body.exclude_from_budget = exclude_from_budget;
  await sb(env, `categories?id=eq.${id}`, { method: "PATCH", body });
  return json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, 400);

  const uncategorized = await sb(env, "rpc/delete_category", {
    method: "POST",
    body: { target_id: id },
  });

  return json({ ok: true, uncategorized });
}
