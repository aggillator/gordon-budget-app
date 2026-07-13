import { json, plaid } from "../_utils.js";

export async function onRequestPost({ env }) {
  const data = await plaid(env, "/link/token/create", {
    user: { client_user_id: "gordon-budget-app-single-user" },
    client_name: "Gordon Budget Tracker",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  });
  return json({ link_token: data.link_token });
}
