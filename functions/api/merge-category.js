import { json, sb } from "../_utils.js";

export async function onRequestPost({ request, env }) {
  const { source_id, target_id } = await request.json();
  if (!source_id || !target_id) {
    return json({ error: "source_id and target_id required" }, 400);
  }
  if (source_id === target_id) {
    return json({ error: "source and target must be different categories" }, 400);
  }

  const moved = await sb(env, "rpc/merge_category", {
    method: "POST",
    body: { source_id, target_id },
  });

  return json({ ok: true, moved });
}
