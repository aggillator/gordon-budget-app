import { json, sb } from "../_utils.js";

// Permanently deletes a batch of transactions by id. This one is NOT
// undo-logged - unlike the categorization actions, "select and delete" is a
// deliberate, visible, one-at-a-time-reviewed action with its own
// confirmation dialog on the frontend, not something that silently ripples
// out to hundreds of rows the way a category propagation can.
export async function onRequestPost({ request, env }) {
  const { ids } = await request.json();
  if (!Array.isArray(ids) || !ids.length) {
    return json({ error: "ids array required" }, 400);
  }
  if (ids.length > 500) {
    return json({ error: "too many ids in one request (max 500)" }, 400);
  }
  const filter = ids.join(",");
  await sb(env, `transactions?id=in.(${filter})`, { method: "DELETE" });
  return json({ ok: true, deleted: ids.length });
}
