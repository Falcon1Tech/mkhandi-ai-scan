export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  return res.status(200).json({
    onesignalAppId: process.env.ONESIGNAL_APP_ID || "",
    supabaseUrl: process.env.SUPABASE_URL || "https://xrthszxomclwrleezkem.supabase.co",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "sb_publishable_UeJC9UkWWeaFrbOPbyWDNA_2dJZzkD4"
  });
}
