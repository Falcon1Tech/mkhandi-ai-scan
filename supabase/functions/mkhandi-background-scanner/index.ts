// MKHANDI server-owned background scanner and AI signal lifecycle.
// Runs from Supabase Cron; it does not depend on an open browser or Android WebView.
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
// MKHANDI_WORKER_SECRET. OneSignal secrets enable push delivery.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "content-type": "application/json", "cache-control": "no-store" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const env = (key: string) => Deno.env.get(key) || "";
const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const DEFAULT_MARKETS = [
  "Boom 1000 Index", "Boom 500 Index", "Crash 1000 Index", "Crash 900 Index",
  "Crash 600 Index", "Crash 300 Index", "Boom 300 Index", "Boom 600 Index",
  "Boom 900 Index", "Step Index"
];
const KNOWN_SYMBOLS: Record<string, string> = {
  "Boom 1000 Index": "BOOM1000",
  "Boom 500 Index": "BOOM500",
  "Crash 1000 Index": "CRASH1000",
  "Step Index": "stpRNG"
};

type Candle = { epoch: number; open: number; high: number; low: number; close: number };
const nowIso = () => new Date().toISOString();
const normalizeName = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function derivActiveSymbols(): Promise<any[]> {
  const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
  const requestId = 714001;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Deriv active_symbols request timed out")); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ active_symbols: "brief", req_id: requestId }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.req_id !== requestId) return;
      clearTimeout(timeout); ws.close();
      if (msg.error) return reject(new Error(msg.error.message || "Deriv symbol catalogue unavailable"));
      resolve(Array.isArray(msg.active_symbols) ? msg.active_symbols : []);
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Deriv symbol catalogue connection failed")); };
  });
}

function resolveSymbol(marketName: string, active: any[], legacy: Record<string, string>) {
  const target = normalizeName(marketName);
  const exact = active.find((item) => [item.display_name, item.underlying_symbol_name, item.symbol].some((v) => normalizeName(v) === target));
  if (exact) return String(exact.underlying_symbol || exact.symbol || "");
  const legacyMatch = Object.entries(legacy).find(([symbol, name]) => normalizeName(name) === target);
  if (legacyMatch) return legacyMatch[0];
  return KNOWN_SYMBOLS[marketName] || "";
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

const ema = (values: number[], period: number) => {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  return values.reduce((value, item, index) => index ? item * k + value * (1 - k) : item, values[0]);
};

function technical(candles: Candle[]) {
  const closes = candles.map((c) => c.close);
  if (closes.length < 60) return { action: "WAIT", bias: "NEUTRAL", score: 0, reason: "Waiting for at least 60 candles", price: closes.at(-1) ?? null, atr: 0, trigger: "NONE" };
  const fast = ema(closes.slice(-50), 9), slow = ema(closes.slice(-50), 21);
  const last = candles[candles.length - 1], previous = candles[candles.length - 2];
  const bias = fast > slow ? "BULLISH" : fast < slow ? "BEARISH" : "NEUTRAL";
  // Keep the setup monitorable after the crossover candle: a same-direction trend
  // plus a fresh candle break can activate the existing WAIT candidate later.
  const bullish = fast > slow && last.close > previous.high;
  const bearish = fast < slow && last.close < previous.low;
  const range = candles.slice(-20);
  const atr = range.reduce((sum, candle, index) => index ? sum + Math.max(candle.high - candle.low, Math.abs(candle.high - range[index - 1].close), Math.abs(candle.low - range[index - 1].close)) : sum, 0) / Math.max(1, range.length - 1);
  const score = Math.min(100, Math.round(50 + Math.abs(fast - slow) / Math.max(atr, Number.EPSILON) * 20));
  return {
    action: bullish ? "BUY" : bearish ? "SELL" : "WAIT", bias, score, price: last.close, atr, ema9: fast, ema21: slow,
    trigger: bullish ? "BULLISH EMA CROSS + BREAKOUT" : bearish ? "BEARISH EMA CROSS + BREAKOUT" : "WAITING FOR CROSSOVER + BREAKOUT",
    reason: bullish ? "Bullish EMA crossover and close above the previous candle high" : bearish ? "Bearish EMA crossover and close below the previous candle low" : "Waiting for a confirmed crossover and breakout",
    candles: candles.slice(-80)
  };
}

async function authenticateWithAI(symbol: string, direction: string, snapshot: any) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + env("OPENAI_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({
      model: env("OPENAI_MODEL") || "gpt-4.1",
      input: "You are MKHANDI's cautious independent Deep AI Scan engine. Review this live Deriv synthetic-index OHLC and multi-timeframe snapshot. The proposed direction is " + direction + ". Authenticate only when H1 and M15 direction agree, the M15 trigger is valid, invalidation is structurally sensible, and projected TP2 reward/risk is at least 1.5. If any condition is missing, return authenticated=false and explain what must happen before the same waiting setup becomes valid. Do not invent a trade. Return JSON only with {authenticated:boolean,confidence:number,entry:number,invalidation:number,tp1:number,tp2:number,rationale:string}. Market: " + symbol + ". Snapshot: " + JSON.stringify(snapshot),
      text: { format: { type: "json_object" } },
      max_output_tokens: 450
    })
  });
  if (!response.ok) throw new Error("Background Deep AI Scan failed: " + response.status);
  const data = await response.json();
  const output = (data.output || []).flatMap((item: any) => item.content || []).find((item: any) => item.type === "output_text")?.text;
  if (!output) throw new Error("AI returned no validation result");
  return JSON.parse(output);
}

async function notify(userId: string, signal: any, event: "AUTHENTICATED" | "TP2_REACHED" | "INVALIDATED" = "AUTHENTICATED") {
  if (!env("ONESIGNAL_APP_ID") || !env("ONESIGNAL_REST_API_KEY")) return;
  const copy = event === "AUTHENTICATED"
    ? { title: "The signal you were waiting for is now valid", body: signal.market_name + " · " + signal.direction + " passed the automatic background Deep AI Scan. Entry " + signal.entry + " · TP2 " + signal.tp2 }
    : event === "TP2_REACHED"
      ? { title: "MKHANDI target reached", body: signal.market_name + " reached TP2 at " + signal.tp2 }
      : { title: "MKHANDI signal invalidated", body: signal.market_name + " breached its invalidation level. Review the signal." };
  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: { authorization: "Key " + env("ONESIGNAL_REST_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify({
      app_id: env("ONESIGNAL_APP_ID"),
      include_aliases: { external_id: [userId] },
      target_channel: "push",
      headings: { en: copy.title },
      contents: { en: copy.body },
      data: { signal_id: signal.id, symbol: signal.symbol, direction: signal.direction, event }
    })
  });
  if (!response.ok) console.error("OneSignal notification failed", response.status, await response.text());
}

async function getOpenCandidate(userId: string, symbol: string) {
  const { data, error } = await supabase.from("mkhandi_signal_candidates").select("*")
    .eq("user_id", userId).eq("symbol", symbol)
    .in("status", ["WAITING", "AI_QUALIFYING", "AI_REJECTED"])
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function ensureCandidate(userId: string, symbol: string, marketName: string) {
  const existing = await getOpenCandidate(userId, symbol);
  if (existing) return existing;
  const { data, error } = await supabase.from("mkhandi_signal_candidates").insert({
    user_id: userId, symbol, market_name: marketName, status: "WAITING", direction: "WAIT",
    wait_reason: "Waiting for H1/M15 alignment and a confirmed technical trigger."
  }).select("*").single();
  if (error) throw error;
  return data;
}

async function processMarket(user: any, market: { name: string; symbol: string }) {
  const { name: marketName, symbol } = market;
  const userId = user.user_id;
  const timestamp = nowIso();
  try {
    const [m15, h1] = await Promise.all([derivHistory(symbol, 900), derivHistory(symbol, 3600)]);
    const t15 = technical(m15), t1 = technical(h1);
    const price = m15[m15.length - 1]?.close ?? null;
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: true, last_quote: price,
      last_quote_at: timestamp, last_scan_at: timestamp, ai_status: "MONITORING", last_error: null, updated_at: timestamp
    });

    const { data: active, error: activeError } = await supabase.from("mkhandi_signals").select("*")
      .eq("user_id", userId).eq("symbol", symbol).eq("status", "ACTIVE").like("source_id", "BG:%").maybeSingle();
    if (activeError) throw activeError;
    if (active) {
      const hitTp2 = active.direction === "BUY" ? Number(price) >= Number(active.tp2) : Number(price) <= Number(active.tp2);
      const invalid = active.direction === "BUY" ? Number(price) <= Number(active.invalidation) : Number(price) >= Number(active.invalidation);
      if (hitTp2 || invalid) {
        const event = hitTp2 ? "TP2_REACHED" : "INVALIDATED";
        const { error } = await supabase.from("mkhandi_signals").update({
          status: event, completed_at: timestamp,
          completion_reason: hitTp2 ? "TP2 reached by server-side price monitor" : "Invalidation breached by server-side price monitor",
          updated_at: timestamp
        }).eq("id", active.id);
        if (error) throw error;
        await supabase.from("mkhandi_signal_events").insert({ signal_id: active.id, user_id: userId, event_type: event, price, details: { source: "supabase-background-worker" } });
        await notify(userId, active, event);
        await supabase.from("mkhandi_signal_candidates").update({ status: "CLOSED", wait_reason: "Previous authenticated signal completed: " + event, updated_at: timestamp }).eq("published_signal_id", active.id);
      }
      return { symbol, state: hitTp2 ? "TP2_REACHED" : invalid ? "INVALIDATED" : "ACTIVE_MONITORED", price };
    }

    const candidate = await ensureCandidate(userId, symbol, marketName);
    const snapshot = { m15: t15, h1: { ...t1, candles: t1.candles?.slice(-40) }, observed_at: timestamp };
    const direction = (t15.action === "BUY" || t15.action === "SELL") && t1.bias === (t15.action === "BUY" ? "BULLISH" : "BEARISH") ? t15.action : "WAIT";
    const intervalMs = (Number(user.scan_interval_minutes) === 60 ? 60 : 30) * 60 * 1000;
    const lastAiAt = candidate.last_ai_at ? new Date(candidate.last_ai_at).getTime() : 0;
    const previousSnapshot = candidate.technical_snapshot || {};
    const previousM15 = previousSnapshot.m15 || {};
    const directionChanged = direction !== "WAIT" && direction !== candidate.direction;
    const triggerImproved = direction !== "WAIT" && (
      previousM15.action !== direction ||
      (Number(t15.score) >= Number(previousM15.score || 0) + 8) ||
      previousM15.trigger !== t15.trigger
    );
    const dueByCadence = !lastAiAt || Date.now() - lastAiAt >= intervalMs;
    const canRunAi = direction !== "WAIT" && (directionChanged || triggerImproved || dueByCadence);

    if (!canRunAi) {
      const waitReason = direction === "WAIT"
        ? (t15.action !== "WAIT" ? "Waiting for H1 and M15 direction to agree." : t15.reason)
        : "Setup remains under observation. The same candidate will be rechecked automatically.";
      const { error } = await supabase.from("mkhandi_signal_candidates").update({
        market_name: marketName, direction: direction === "WAIT" ? (t15.action === "WAIT" ? "WAIT" : t15.action) : direction,
        status: candidate.status === "AI_REJECTED" ? "AI_REJECTED" : "WAITING",
        technical_snapshot: snapshot, wait_reason: waitReason, last_seen_at: timestamp, updated_at: timestamp
      }).eq("id", candidate.id);
      if (error) throw error;
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
        last_scan_at: timestamp, ai_status: candidate.status === "AI_REJECTED" ? "WAITING · AI REVIEW" : "WAITING FOR TRIGGER",
        last_error: null, updated_at: timestamp
      });
      return { symbol, state: "WAITING", price, reason: waitReason, candidate_id: candidate.id };
    }

    await supabase.from("mkhandi_signal_candidates").update({
      market_name: marketName, direction, status: "AI_QUALIFYING", technical_snapshot: snapshot,
      last_seen_at: timestamp, last_ai_at: timestamp, next_ai_at: new Date(Date.now() + intervalMs).toISOString(),
      wait_reason: "Automatic background Deep AI Scan is validating this setup.", updated_at: timestamp
    }).eq("id", candidate.id);
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
      last_scan_at: timestamp, ai_status: "BACKGROUND DEEP AI SCAN", last_error: null, updated_at: timestamp
    });

    let verdict: any;
    try {
      verdict = await authenticateWithAI(marketName, direction, snapshot);
    } catch (error) {
      const reason = String(error).slice(0, 500);
      await supabase.from("mkhandi_signal_candidates").update({
        status: "AI_REJECTED", ai_result: { error: reason }, wait_reason: "Deep AI Scan could not finish. The same setup remains queued for its next automatic review.",
        updated_at: nowIso()
      }).eq("id", candidate.id);
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
        last_scan_at: timestamp, ai_status: "AI RETRY SCHEDULED", last_error: reason, updated_at: nowIso()
      });
      return { symbol, state: "AI_RETRY_SCHEDULED", candidate_id: candidate.id };
    }

    const geometry = Number.isFinite(Number(verdict.entry)) && Number.isFinite(Number(verdict.invalidation)) && Number.isFinite(Number(verdict.tp2)) &&
      (direction === "BUY" ? Number(verdict.invalidation) < Number(verdict.entry) && Number(verdict.tp2) > Number(verdict.entry)
        : Number(verdict.invalidation) > Number(verdict.entry) && Number(verdict.tp2) < Number(verdict.entry));
    const rr = geometry ? Math.abs(Number(verdict.tp2) - Number(verdict.entry)) / Math.abs(Number(verdict.entry) - Number(verdict.invalidation)) : 0;
    const confidence = Number(verdict.confidence);
    if (!verdict.authenticated || !geometry || rr < 1.5 || !Number.isFinite(confidence) || confidence < 65) {
      const reason = String(verdict.rationale || "Deep AI Scan has not confirmed a valid entry yet. Waiting for the setup to improve.");
      await supabase.from("mkhandi_signal_candidates").update({
        status: "AI_REJECTED", ai_result: verdict, wait_reason: reason.slice(0, 1200),
        technical_snapshot: snapshot, last_seen_at: timestamp, updated_at: nowIso()
      }).eq("id", candidate.id);
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
        last_scan_at: timestamp, ai_status: "WAITING · AI NOT YET VALID", last_error: null, updated_at: nowIso()
      });
      return { symbol, state: "AI_WAITING", candidate_id: candidate.id, confidence };
    }

    const row = {
      user_id: userId, source_id: "BG:" + candidate.id, symbol, market_name: marketName, direction,
      entry: Number(verdict.entry), invalidation: Number(verdict.invalidation), tp1: Number(verdict.tp1) || null,
      tp2: Number(verdict.tp2), confidence, rationale: String(verdict.rationale || "").slice(0, 1200),
      technical_snapshot: snapshot
    };
    const { data: signal, error: insertError } = await supabase.from("mkhandi_signals").insert(row).select("*").single();
    if (insertError) {
      if (insertError.code === "23505") return { symbol, state: "ALREADY_PUBLISHED", candidate_id: candidate.id };
      throw insertError;
    }
    await supabase.from("mkhandi_signal_events").insert({
      signal_id: signal.id, user_id: userId, event_type: "AUTHENTICATED", price,
      details: { confidence, risk_reward: Number(rr.toFixed(2)), source: "supabase-background-deep-ai" }
    });
    await supabase.from("mkhandi_signal_candidates").update({
      status: "AUTHENTICATED", published_signal_id: signal.id, ai_result: verdict,
      wait_reason: "Authenticated by automatic background Deep AI Scan.", updated_at: nowIso()
    }).eq("id", candidate.id);
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
      last_scan_at: timestamp, ai_status: "AUTHENTICATED · PUBLISHED", last_error: null, updated_at: nowIso()
    });
    await notify(userId, signal, "AUTHENTICATED");
    return { symbol, state: "AUTHENTICATED", signal_id: signal.id, candidate_id: candidate.id };
  } catch (error) {
    const reason = String(error).slice(0, 500);
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: false, last_error: reason, updated_at: nowIso()
    });
    return { symbol, state: "ERROR", error: reason.slice(0, 250) };
  }
}

async function processUser(user: any, activeSymbols: any[]) {
  const legacy = (user.market_names || {}) as Record<string, string>;
  const requestedNames = Array.isArray(user.markets) && user.markets.length
    ? user.markets.slice(0, 10)
    : DEFAULT_MARKETS;
  const markets = requestedNames.map((name: string) => ({ name, symbol: resolveSymbol(name, activeSymbols, legacy) })).filter((item: any) => !!item.symbol);
  const marketNames = Object.fromEntries(markets.map((item: any) => [item.symbol, item.name]));
  await supabase.from("mkhandi_watchlists").update({
    symbols: markets.map((item: any) => item.symbol), market_names: marketNames, markets: requestedNames, updated_at: nowIso()
  }).eq("user_id", user.user_id);
  const results = [];
  for (const market of markets) results.push(await processMarket(user, market));
  for (const name of requestedNames) {
    if (!markets.some((item: any) => item.name === name)) {
      const symbol = KNOWN_SYMBOLS[name] || "UNRESOLVED:" + normalizeName(name).replace(/ /g, "_");
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: name, deriv_connected: false, last_error: "Market not present in Deriv active_symbols response.",
        updated_at: nowIso()
      });
      results.push({ market: name, state: "UNRESOLVED" });
    }
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (req.headers.get("x-mkhandi-worker-secret") !== env("MKHANDI_WORKER_SECRET")) return json({ error: "Unauthorized worker" }, 401);
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "MKHANDI_WORKER_SECRET"]) {
    if (!env(key)) return json({ error: "Missing server secret: " + key }, 503);
  }
  const { data: acquired, error: lockError } = await supabase.rpc("mkhandi_acquire_worker_lease");
  if (lockError) return json({ error: "Scanner lease unavailable: " + lockError.message }, 503);
  if (!acquired) return json({ ok: true, skipped: "Another scanner invocation is still running", scanned_at: nowIso() }, 202);
  try {
    const { data: users, error } = await supabase.from("mkhandi_watchlists")
      .select("user_id,symbols,markets,market_names,enabled,scan_interval_minutes").eq("enabled", true);
    if (error) return json({ error: error.message }, 500);
    if (!users?.length) return json({ ok: true, scanned_at: nowIso(), users: 0, results: [] });
    let active: any[];
    try { active = await derivActiveSymbols(); }
    catch (error) { return json({ error: "Could not resolve Deriv markets: " + String(error) }, 502); }
    const results = [];
    for (const user of users) results.push({ user_id: user.user_id, markets: await processUser(user, active) });
    return json({ ok: true, scanned_at: nowIso(), results });
  } finally {
    await supabase.rpc("mkhandi_release_worker_lease");
  }
});
