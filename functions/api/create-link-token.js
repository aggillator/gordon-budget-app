import { json, plaid } from "../_utils.js";

export async function onRequestPost({ env }) {
  const data = await plaid(env, "/link/token/create", {
    user: { client_user_id: "gordon-budget-app-single-user" },
    client_name: "Gordon Budget Tracker",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    transactions: { days_requested: 730 }, // 2 years instead of Plaid's 90-day default
  });
  return json({ link_token: data.link_token });
}
