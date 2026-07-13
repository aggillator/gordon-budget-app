import { json, plaid, sb } from "../_utils.js";

export async function onRequestPost({ request, env }) {
  const { public_token } = await request.json();
  if (!public_token) return json({ error: "public_token required" }, 400);

  const exch = await plaid(env, "/item/public_token/exchange", { public_token });
  const { access_token, item_id } = exch;

  const acctData = await plaid(env, "/accounts/get", { access_token });
  const institutionName =
    acctData.item?.institution_id || acctData.accounts?.[0]?.name || "Bank";

  const [item] = await sb(env, "plaid_items", {
    method: "POST",
    prefer: "return=representation",
    body: {
      item_id,
      access_token,
      institution_name: institutionName,
    },
  });

  for (const a of acctData.accounts) {
    await sb(env, "accounts?on_conflict=plaid_account_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: {
        plaid_item_id: item.id,
        plaid_account_id: a.account_id,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
      },
    });
  }

  return json({ ok: true, accounts: acctData.accounts.length });
}
