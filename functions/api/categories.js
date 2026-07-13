import { json, sb } from "../_utils.js";

export async function onRequestGet({ env }) {
  const rows = await sb(env, "categories?select=*&order=sort_order.asc");
  return json(rows);
}

export async function onRequestPatch({ request, env }) {
  const { id, monthly_budget } = await request.json();
  if (!id) return json({ error: "id required" }, 400);
  await sb(env, `categories?id=eq.${id}`, {
    method: "PATCH",
    body: { monthly_budget },
  });
  return json({ ok: true });
}
