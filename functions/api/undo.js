import { json, sb } from "../_utils.js";

// Lists the last 10 undoable actions.
export async function onRequestGet({ env }) {
  const rows = await sb(
    env,
    "action_log?select=*&order=created_at.desc&limit=10"
  );
  return json(rows);
}

// Replays a logged action's snapshot in reverse. Each action_type stores
// exactly what it needs to restore prior state - see the snapshot shape
// written by categorize-ai.js, categories.js (DELETE), and transactions.js
// (the propagation path).
export async function onRequestPost({ request, env }) {
  const { id } = await request.json();
  if (!id) return json({ error: "id required" }, 400);

  const [entry] = await sb(env, `action_log?id=eq.${id}&select=*`);
  if (!entry) return json({ error: "not found" }, 404);
  if (entry.undone) return json({ error: "already undone" }, 400);

  const snap = entry.snapshot;

  if (entry.action_type === "ai_categorize" || entry.action_type === "propagate_category") {
    const txns = snap.transactions || [];
    for (const t of txns) {
      await sb(env, `transactions?id=eq.${t.id}`, {
        method: "PATCH",
        body: {
          category_id: t.prior_category_id,
          category_source: t.prior_category_source,
        },
      });
    }
  } else if (entry.action_type === "category_delete") {
    // Recreate the category with its original id so the transactions'
    // prior category_id references are valid again.
    if (snap.category) {
      await sb(env, "categories", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: snap.category,
      });
    }
    const txns = snap.transactions || [];
    for (const t of txns) {
      await sb(env, `transactions?id=eq.${t.id}`, {
        method: "PATCH",
        body: {
          category_id: t.prior_category_id,
          category_source: t.prior_category_source,
        },
      });
    }
  } else {
    return json({ error: `unknown action_type: ${entry.action_type}` }, 400);
  }

  await sb(env, `action_log?id=eq.${id}`, {
    method: "PATCH",
    body: { undone: true },
  });

  return json({ ok: true, restored: (snap.transactions || []).length });
}
