// Supabase Edge Function: server-owned Deriv scanner and signal lifecycle.
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
// ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY, MKHANDI_WORKER_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "content-type": "application/json", "cache-control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const env = (key: string) => Deno.env.get(key) || "";
const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

type Candle = { epoch: number; open: number; high: number; low: number; close: number };
const ema = (values: number[], period: number) => {
  const k = 2 / (period + 1);
  return values.reduce((v, x, i) => i ? x * k + v * (1 - k) : x, values[0]);
};
function technical(candles: Candle[]) {
  const closes = candles.map(x => x.close);
  if (closes.length < 60) return { action: "WAIT", reason: "Insufficient candle history" };
  const fast = ema(closes.slice(-50), 9), slow = ema(closes.slice(-50), 21);
  const priorFast = ema(closes.slice(-51, -1), 9), priorSlow = ema(closes.slice(-51, -1), 21);
  const last = candles[candles.length - 1], previous = candles[candles.length - 2];
  const bullish = fast > slow && priorFast <= priorSlow && last.close > previous.high;
  const bearish = fast < slow && priorFast >= priorSlow && last.close < previous.low;
  const range = candles.slice(-20);
  const atr = range.reduce((sum, c, i) => i ? sum + Math.max(c.high-c.low,Math.abs(c.high-range[i-1].close),Math.abs(c.low-range[i-1].close)) : sum, 0) / 19;
  return { action: bullish ? "BUY" : bearish ? "SELL" : "WAIT", price: last.close, atr, ema9: fast, ema21: slow, candles: candles.slice(-80), reason: bullish ? "Bullish EMA cross and close above prior candle high" : bearish ? "Bearish EMA cross and close below prior candle low" : "No qualifying crossover and breakout" };
}
async function derivHistory(symbol: string, granularity: number): Promise<Candle[]> {
  const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
  const requestId = Math.floor(Math.random() * 1e9);
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Deriv history request timed out")); }, 18000);
    ws.onopen = () => ws.send(JSON.stringify({ ticks_history: symbol, end: "latest", count: 120, style: "candles", granularity, req_id: requestId }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.req_id !== requestId) return;
      clearTimeout(timeout); ws.close();
      if (msg.error) return reject(new Error(msg.error.message || "Deriv API error"));
      resolve((msg.candles || []).map((c: any) => ({ epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) })));
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Deriv WebSocket connection failed")); };
  });
}
async function authenticateWithAI(symbol: string, direction: string, snapshot: any) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + env("OPENAI_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({
      model: env("OPENAI_MODEL") || "gpt-4.1",
      input: "You are MKHANDI's cautious independent signal validator. Review this Deriv synthetic-index OHLC/indicator snapshot. Only authenticate if direction, H1/M15 agreement, invalidation and at least 1.5R projected reward are coherent. Return JSON only with {authenticated:boolean,confidence:number,entry:number,invalidation:number,tp1:number,tp2:number,rationale:string}. Direction: " + direction + ". Market: " + symbol + ". Snapshot: " + JSON.stringify(snapshot),
      text: { format: { type: "json_object" } },
      max_output_tokens: 350
    })
  });
  if (!response.ok) throw new Error("AI validation failed: " + response.status);
  const data = await response.json();
  const text = (data.output || []).flatMap((x: any) => x.content || []).find((x: any) => x.type === "output_text")?.text;
  if (!text) throw new Error("AI returned no validation");
  return JSON.parse(text);
}
async function notify(userId: string, signal: any) {
  if (!env("ONESIGNAL_APP_ID") || !env("ONESIGNAL_REST_API_KEY")) return;
  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { authorization: "Key " + env("ONESIGNAL_REST_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({
      app_id: env("ONESIGNAL_APP_ID"),
      include_aliases: { external_id: [userId] },
      target_channel: "push",
      headings: { en: "MKHANDI " + signal.direction + " authenticated" },
      contents: { en: signal.market_name + " · Entry " + signal.entry + " · TP2 " + signal.tp2 },
      data: { signal_id: signal.id, symbol: signal.symbol, direction: signal.direction }
    })
  });
  if (!response.ok) console.error("OneSignal notification failed", response.status, await response.text());
}
async function processUser(user: any) {
  const symbols = Array.isArray(user.symbols) ? user.symbols.slice(0, 10) : [];
  const results = [];
  for (const symbol of symbols) {
    const marketName = symbol;
    try {
      const [m15, h1] = await Promise.all([derivHistory(symbol, 900), derivHistory(symbol, 3600)]);
      const t15 = technical(m15), t1 = technical(h1);
      const price = m15[m15.length - 1]?.close;
      await supabase.from("mkhandi_scanner_health").upsert({ symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: new Date().toISOString(), last_scan_at: new Date().toISOString(), ai_status: "MONITORING", last_error: null });
      const { data: active } = await supabase.from("mkhandi_signals").select("*").eq("user_id", user.user_id).eq("symbol", symbol).eq("status", "ACTIVE").maybeSingle();
      if (active) {
        const hitTp2 = active.direction === "BUY" ? price >= Number(active.tp2) : price <= Number(active.tp2);
        const invalid = active.direction === "BUY" ? price <= Number(active.invalidation) : price >= Number(active.invalidation);
        if (hitTp2 || invalid) {
          const status = hitTp2 ? "TP2_REACHED" : "INVALIDATED";
          await supabase.from("mkhandi_signals").update({ status, completed_at: new Date().toISOString(), completion_reason: hitTp2 ? "TP2 reached by server price monitor" : "Invalidation breached by server price monitor", updated_at: new Date().toISOString() }).eq("id", active.id);
          await supabase.from("mkhandi_signal_events").insert({ signal_id: active.id, user_id: user.user_id, event_type: status, price, details: { source: "background-worker" } });
        }
        results.push({ symbol, state: "ACTIVE_MONITORED", price });
        continue;
      }
      const { data: scanState } = await supabase.from("mkhandi_scanner_state").select("last_qualification_at").eq("user_id", user.user_id).eq("symbol", symbol).maybeSingle();
      const intervalMs = (Number(user.scan_interval_minutes) === 60 ? 60 : 30) * 60 * 1000;
      const lastQualified = scanState?.last_qualification_at ? new Date(scanState.last_qualification_at).getTime() : 0;
      if (Date.now() - lastQualified < intervalMs) {
        results.push({ symbol, state: "WAITING_FOR_QUALIFICATION_WINDOW", price, next_scan_at: new Date(lastQualified + intervalMs).toISOString() });
        continue;
      }
      await supabase.from("mkhandi_scanner_state").upsert({ user_id: user.user_id, symbol, last_qualification_at: new Date().toISOString(), last_quote: price, last_quote_at: new Date().toISOString() });
      const direction = t15.action;
      if (direction === "WAIT" || t1.action !== direction) { results.push({ symbol, state: "NO_CANDIDATE", price }); continue; }
      const snapshot = { m15: t15, h1: { ...t1, candles: t1.candles?.slice(-40) }, observed_at: new Date().toISOString() };
      await supabase.from("mkhandi_scanner_health").upsert({ symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: new Date().toISOString(), last_scan_at: new Date().toISOString(), ai_status: "QUALIFYING", last_error: null });
      const verdict = await authenticateWithAI(symbol, direction, snapshot);
      const geometry = Number.isFinite(verdict.entry) && Number.isFinite(verdict.invalidation) && Number.isFinite(verdict.tp2) &&
        (direction === "BUY" ? verdict.invalidation < verdict.entry && verdict.tp2 > verdict.entry : verdict.invalidation > verdict.entry && verdict.tp2 < verdict.entry);
      const rr = geometry ? Math.abs(verdict.tp2-verdict.entry)/Math.abs(verdict.entry-verdict.invalidation) : 0;
      if (!verdict.authenticated || !geometry || rr < 1.5 || Number(verdict.confidence) < 65) {
        await supabase.from("mkhandi_scanner_health").upsert({ symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: new Date().toISOString(), last_scan_at: new Date().toISOString(), ai_status: "REJECTED", last_error: null });
        results.push({ symbol, state: "AI_REJECTED", confidence: verdict.confidence }); continue;
      }
      const row = { user_id: user.user_id, symbol, market_name: marketName, direction, entry: verdict.entry, invalidation: verdict.invalidation, tp1: verdict.tp1, tp2: verdict.tp2, confidence: verdict.confidence, rationale: String(verdict.rationale || "").slice(0, 1200), technical_snapshot: snapshot };
      const { data: signal, error } = await supabase.from("mkhandi_signals").insert(row).select("*").single();
      if (error) { results.push({ symbol, state: "SIGNAL_INSERT_FAILED", error: error.message }); continue; }
      await supabase.from("mkhandi_signal_events").insert({ signal_id: signal.id, user_id: user.user_id, event_type: "AUTHENTICATED", price, details: { confidence: verdict.confidence, rr } });
      await supabase.from("mkhandi_scanner_health").upsert({ symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: new Date().toISOString(), last_scan_at: new Date().toISOString(), ai_status: "AUTHENTICATED", last_error: null });
      await notify(user.user_id, signal);
      results.push({ symbol, state: "AUTHENTICATED", signal_id: signal.id });
    } catch (error) {
      await supabase.from("mkhandi_scanner_health").upsert({ symbol, market_name: marketName, deriv_connected: false, last_error: String(error).slice(0, 500), updated_at: new Date().toISOString() });
      results.push({ symbol, state: "ERROR", error: String(error).slice(0, 250) });
    }
  }
  return results;
}
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (req.headers.get("x-mkhandi-worker-secret") !== env("MKHANDI_WORKER_SECRET")) return json({ error: "Unauthorized worker" }, 401);
  for (const key of ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","OPENAI_API_KEY","MKHANDI_WORKER_SECRET"]) if (!env(key)) return json({ error: "Missing server secret: " + key }, 503);
  const { data: acquired, error: lockError } = await supabase.rpc("mkhandi_acquire_worker_lease");
  if (lockError) return json({ error: "Scanner lease unavailable: " + lockError.message }, 503);
  if (!acquired) return json({ ok: true, skipped: "Another scanner invocation is still running", scanned_at: new Date().toISOString() }, 202);
  try {
    const { data: users, error } = await supabase.from("mkhandi_watchlists").select("user_id,symbols,enabled,scan_interval_minutes").eq("enabled", true);
    if (error) return json({ error: error.message }, 500);
    const results = [];
    for (const user of users || []) results.push({ user_id: user.user_id, markets: await processUser(user) });
    return json({ ok: true, scanned_at: new Date().toISOString(), results });
  } finally {
    await supabase.rpc("mkhandi_release_worker_lease");
  }
});
