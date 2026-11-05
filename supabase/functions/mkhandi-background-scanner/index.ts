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

class DerivClient {
  private ws: WebSocket;
  private nextId = 714000;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>();
  private opened: Promise<void>;
  private intentionalClose = false;

  constructor() {
    // Deriv's current public market-data WebSocket is unauthenticated and does
    // not require a legacy app_id. Use it for symbols and historical candles.
    this.ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public");
    this.opened = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Deriv WebSocket connection timed out; check outbound WebSocket access and DERIV_APP_ID"));
        try { this.ws.close(); } catch { /* ignore */ }
      }, 10000);
      this.ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (event) => {
        const detail = (event as ErrorEvent)?.message || "no browser/runtime detail";
        console.error("Deriv WebSocket transport error:", detail);
      };
      this.ws.onmessage = (event) => {
        let message: any;
        try { message = JSON.parse(event.data); } catch { return; }
        const id = Number(message.req_id);
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (message.error) pending.reject(new Error(message.error.message || "Deriv API error"));
        else pending.resolve(message);
      };
      this.ws.onclose = (event) => {
        const closeReason = "Deriv WebSocket closed (code=" + event.code + ", reason=" + (event.reason || "none") + ", clean=" + event.wasClean + ")";
        if (!this.intentionalClose) console.error(closeReason);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(closeReason));
        }
        for (const [id, item] of this.pending) {
          clearTimeout(item.timer);
          item.reject(new Error("Deriv WebSocket closed before request completed"));
          this.pending.delete(id);
        }
      };
    });
  }

  async request(payload: Record<string, unknown>, timeoutMs = 18000): Promise<any> {
    await this.opened;
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Deriv WebSocket is not open");
    const id = ++this.nextId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Deriv request timed out: " + String(payload.ticks_history || payload.active_symbols || "request")));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: id })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async activeSymbols(): Promise<any[]> {
    const result = await this.request({ active_symbols: "brief" }, 15000);
    if (!Array.isArray(result.active_symbols) || !result.active_symbols.length) {
      throw new Error("Deriv returned an empty active-symbol catalogue");
    }
    return result.active_symbols;
  }

  async history(symbol: string, granularity: number): Promise<Candle[]> {
    const result = await this.request({
      ticks_history: symbol, end: "latest", count: 120, style: "candles", granularity
    });
    const candles = (result.candles || []).map((c: any) => ({
      epoch: Number(c.epoch), open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close)
    }));
    if (candles.length < 60) throw new Error("Deriv returned fewer than 60 candles for " + symbol + " (" + granularity + ")");
    return candles;
  }

  close() {
    this.intentionalClose = true;
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

function resolveSymbol(marketName: string, active: any[], legacy: Record<string, string>) {
  const target = normalizeName(marketName);
  const exact = active.find((item) => [
    item.display_name, item.underlying_symbol_name, item.market_display_name
  ].some((v) => normalizeName(v) === target));
  // Deriv's 'symbol' is the tradeable contract code. Do not substitute the
  // descriptive underlying_symbol_name field when a contract symbol exists.
  if (exact?.symbol) return String(exact.symbol);
  const legacyMatch = Object.entries(legacy).find(([symbol, name]) => normalizeName(name) === target);
  if (legacyMatch) return legacyMatch[0];
  return KNOWN_SYMBOLS[marketName] || "";
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + env("OPENAI_API_KEY"), "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: env("OPENAI_MODEL") || "gpt-4.1",
        input: "You are MKHANDI's cautious independent Deep AI Scan engine. Review this live Deriv synthetic-index OHLC and multi-timeframe snapshot. The proposed direction is " + direction + ". Authenticate only when H1 and M15 direction agree, the M15 trigger is valid, invalidation is structurally sensible, and projected TP2 reward/risk is at least 1.5. If any condition is missing, return authenticated=false and explain what must happen before the same waiting setup becomes valid. Do not invent a trade. Confidence must be a percentage from 0 to 100. Return JSON only with {authenticated:boolean,confidence:number,entry:number,invalidation:number,tp1:number,tp2:number,rationale:string}. Market: " + symbol + ". Snapshot: " + JSON.stringify(snapshot),
        text: { format: { type: "json_object" } },
        max_output_tokens: 450
      })
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error("Background Deep AI Scan failed: " + response.status + " " + detail);
    }
    const data = await response.json();
    const output = (data.output || []).flatMap((item: any) => item.content || []).find((item: any) => item.type === "output_text")?.text;
    if (!output) throw new Error("AI returned no validation result");
    const verdict = JSON.parse(output);
    const rawConfidence = Number(verdict.confidence);
    if (Number.isFinite(rawConfidence)) verdict.confidence = rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence;
    return verdict;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Deep AI Scan timed out after 20 seconds");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

async function persistWaitingSignal(args: {
  userId: string;
  candidate: any;
  marketName: string;
  symbol: string;
  snapshot: any;
  verdict: any;
  reason: string;
  candidateStatus: "WAITING" | "AI_REJECTED";
  candidateDirection: "WAIT" | "BUY" | "SELL";
  timestamp: string;
}) {
  const confidenceValue = Number(args.verdict.confidence);
  const row = {
    user_id: args.userId,
    source_id: "BG:" + args.candidate.id,
    symbol: args.symbol,
    market_name: args.marketName,
    direction: "WAIT",
    status: "WAITING",
    entry: null,
    invalidation: null,
    tp1: null,
    tp2: null,
    confidence: Number.isFinite(confidenceValue) ? confidenceValue : null,
    rationale: args.reason.slice(0, 1200),
    technical_snapshot: args.snapshot,
    authenticated_at: null,
    updated_at: args.timestamp
  };

  let signal: any;
  if (args.candidate.published_signal_id) {
    const { data, error } = await supabase.from("mkhandi_signals").update(row)
      .eq("id", args.candidate.published_signal_id).select("*").single();
    if (error) throw error;
    signal = data;
  } else {
    const { data, error } = await supabase.from("mkhandi_signals").insert(row).select("*").single();
    if (!error) {
      signal = data;
    } else if (error.code === "23505") {
      const { data: existing, error: lookupError } = await supabase.from("mkhandi_signals").select("*")
        .eq("user_id", args.userId).eq("source_id", "BG:" + args.candidate.id).maybeSingle();
      if (lookupError) throw lookupError;
      if (!existing) throw error;
      const { data: updated, error: updateError } = await supabase.from("mkhandi_signals").update(row)
        .eq("id", existing.id).select("*").single();
      if (updateError) throw updateError;
      signal = updated;
    } else {
      throw error;
    }
  }

  const { error: candidateError } = await supabase.from("mkhandi_signal_candidates").update({
    status: args.candidateStatus,
    direction: args.candidateDirection,
    ai_result: args.verdict,
    published_signal_id: signal.id,
    wait_reason: args.reason.slice(0, 1200),
    technical_snapshot: args.snapshot,
    last_seen_at: args.timestamp,
    updated_at: args.timestamp
  }).eq("id", args.candidate.id);
  if (candidateError) throw candidateError;
  return signal;
}

async function processMarket(user: any, market: { name: string; symbol: string }, deriv: DerivClient) {
  const { name: marketName, symbol } = market;
  const userId = user.user_id;
  const timestamp = nowIso();
  let derivConnected = false;
  try {
    const [m15, h1] = await Promise.all([deriv.history(symbol, 900), deriv.history(symbol, 3600)]);
    derivConnected = true;
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
    const nextAiAt = candidate.next_ai_at ? new Date(candidate.next_ai_at).getTime() : 0;
    const aiResult = candidate.ai_result || {};
    const hasAiVerdict = typeof aiResult.authenticated === "boolean";
    const hasAiError = typeof aiResult.error === "string";
    const previousSnapshot = candidate.technical_snapshot || {};
    const previousM15 = previousSnapshot.m15 || {};
    const directionChanged = direction !== "WAIT" && direction !== candidate.direction;
    const triggerImproved = direction !== "WAIT" && (
      previousM15.action !== direction ||
      (Number(t15.score) >= Number(previousM15.score || 0) + 8) ||
      previousM15.trigger !== t15.trigger
    );
    // A candidate left AI_QUALIFYING without a verdict must be retried immediately.
    // Transient AI errors retry after five minutes; genuine verdicts follow the configured cadence.
    const dueByCadence = (!hasAiVerdict && !hasAiError) ||
      (hasAiError ? (!nextAiAt || Date.now() >= nextAiAt) : (!nextAiAt ? (!lastAiAt || Date.now() - lastAiAt >= intervalMs) : Date.now() >= nextAiAt));
    const canRunAi = direction === "WAIT" ? dueByCadence : (directionChanged || triggerImproved || dueByCadence);

    if (!canRunAi) {
      const waitReason = direction === "WAIT"
        ? (t15.action !== "WAIT" ? "Waiting for H1 and M15 direction to agree." : t15.reason)
        : "Setup remains under observation. The same candidate will be rechecked automatically.";
      const { error } = await supabase.from("mkhandi_signal_candidates").update({
        market_name: marketName, direction,
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

    const { error: qualifyingError } = await supabase.from("mkhandi_signal_candidates").update({
      market_name: marketName, direction, status: "AI_QUALIFYING", technical_snapshot: snapshot,
      last_seen_at: timestamp, last_ai_at: timestamp, next_ai_at: new Date(Date.now() + intervalMs).toISOString(),
      wait_reason: "Automatic background Deep AI Scan is validating this setup.", updated_at: timestamp
    }).eq("id", candidate.id);
    if (qualifyingError) throw qualifyingError;
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
      last_scan_at: timestamp, ai_status: "BACKGROUND DEEP AI SCAN", last_error: null, updated_at: timestamp
    });

    let verdict: any;
    try {
      verdict = await authenticateWithAI(marketName, direction, snapshot);
    } catch (error) {
      const reason = String(error).slice(0, 500);
      const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { error: retryUpdateError } = await supabase.from("mkhandi_signal_candidates").update({
        status: "AI_REJECTED", next_ai_at: retryAt,
        wait_reason: "Deep AI Scan could not finish. The same setup is queued for automatic retry in five minutes.",
        updated_at: nowIso()
      }).eq("id", candidate.id);
      if (retryUpdateError) throw retryUpdateError;
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
        last_scan_at: timestamp, ai_status: "AI RETRY SCHEDULED", last_error: reason, updated_at: nowIso()
      });
      return { symbol, state: "AI_RETRY_SCHEDULED", candidate_id: candidate.id };
    }

    if (direction === "WAIT") {
      const reason = String(verdict.rationale || "Deep AI Scan completed. Waiting for a valid directional setup and trigger.");
      const waitingVerdict = { ...verdict, authenticated: false };
      const signal = await persistWaitingSignal({
        userId, candidate, marketName, symbol, snapshot, verdict: waitingVerdict, reason,
        candidateStatus: "WAITING", candidateDirection: "WAIT", timestamp: nowIso()
      });
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
        last_scan_at: timestamp, ai_status: "DEEP AI SCANNED · WAITING · PUBLISHED", last_error: null, updated_at: nowIso()
      });
      return { symbol, state: "AI_WAITING", candidate_id: candidate.id, signal_id: signal.id, reason };
    }

    const tp1 = Number(verdict.tp1);
    const geometry = Number.isFinite(Number(verdict.entry)) && Number.isFinite(Number(verdict.invalidation)) &&
      Number.isFinite(tp1) && Number.isFinite(Number(verdict.tp2)) &&
      (direction === "BUY"
        ? Number(verdict.invalidation) < Number(verdict.entry) && tp1 > Number(verdict.entry) && Number(verdict.tp2) >= tp1
        : Number(verdict.invalidation) > Number(verdict.entry) && tp1 < Number(verdict.entry) && Number(verdict.tp2) <= tp1);
    const rr = geometry ? Math.abs(Number(verdict.tp2) - Number(verdict.entry)) / Math.abs(Number(verdict.entry) - Number(verdict.invalidation)) : 0;
    const confidence = Number(verdict.confidence);
    if (verdict.authenticated !== true || !geometry || rr < 1.5 || !Number.isFinite(confidence) || confidence < 65) {
      const baseReason = String(verdict.rationale || "Deep AI Scan has not confirmed a valid entry yet. Waiting for the setup to improve.");
      const systemReason = !geometry
        ? "System risk gate: entry, invalidation, TP1 and TP2 geometry is incomplete or invalid. "
        : rr < 1.5
          ? "System risk gate: TP2 reward/risk is below 1.5. "
          : confidence < 65
            ? "System risk gate: AI confidence is below 65%. "
            : "";
      const reason = systemReason + baseReason;
      const rejectedVerdict = { ...verdict, authenticated: false, rationale: reason };
      const signal = await persistWaitingSignal({
        userId, candidate, marketName, symbol, snapshot, verdict: rejectedVerdict, reason,
        candidateStatus: "AI_REJECTED", candidateDirection: direction, timestamp: nowIso()
      });
      await supabase.from("mkhandi_scanner_health").upsert({
        symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
        last_scan_at: timestamp, ai_status: "WAITING · AI NOT YET VALID · PUBLISHED", last_error: null, updated_at: nowIso()
      });
      return { symbol, state: "AI_WAITING", candidate_id: candidate.id, signal_id: signal.id, confidence };
    }

    if (verdict.authenticated !== true) {
      throw new Error("Deep AI verdict did not return authenticated=true; publication blocked");
    }
    const row = {
      user_id: userId, source_id: "BG:" + candidate.id, symbol, market_name: marketName, direction,
      status: "ACTIVE", entry: Number(verdict.entry), invalidation: Number(verdict.invalidation),
      tp1: Number(verdict.tp1), tp2: Number(verdict.tp2), confidence,
      rationale: String(verdict.rationale || "").slice(0, 1200),
      technical_snapshot: snapshot, authenticated_at: nowIso(), updated_at: nowIso()
    };
    let signal: any;
    if (candidate.published_signal_id) {
      const { data, error } = await supabase.from("mkhandi_signals").update(row)
        .eq("id", candidate.published_signal_id).select("*").single();
      if (error) throw error;
      signal = data;
    } else {
      const { data, error } = await supabase.from("mkhandi_signals").insert(row).select("*").single();
      if (!error) {
        signal = data;
      } else if (error.code === "23505") {
        const { data: existing, error: lookupError } = await supabase.from("mkhandi_signals").select("*")
          .eq("user_id", userId).eq("source_id", "BG:" + candidate.id).maybeSingle();
        if (lookupError) throw lookupError;
        if (!existing) throw error;
        const { data: updated, error: updateError } = await supabase.from("mkhandi_signals").update(row)
          .eq("id", existing.id).select("*").single();
        if (updateError) throw updateError;
        signal = updated;
      } else {
        throw error;
      }
    }
    await supabase.from("mkhandi_signal_events").insert({
      signal_id: signal.id, user_id: userId, event_type: "AUTHENTICATED", price,
      details: { confidence, risk_reward: Number(rr.toFixed(2)), source: "supabase-background-deep-ai" }
    });
    const { error: candidatePublishError } = await supabase.from("mkhandi_signal_candidates").update({
      status: "AUTHENTICATED", published_signal_id: signal.id, ai_result: verdict,
      wait_reason: "Authenticated by automatic background Deep AI Scan.", updated_at: nowIso()
    }).eq("id", candidate.id);
    if (candidatePublishError) throw candidatePublishError;
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: true, last_quote: price, last_quote_at: timestamp,
      last_scan_at: timestamp, ai_status: "AUTHENTICATED · PUBLISHED", last_error: null, updated_at: nowIso()
    });
    await notify(userId, signal, "AUTHENTICATED");
    return { symbol, state: "AUTHENTICATED", signal_id: signal.id, candidate_id: candidate.id };
  } catch (error) {
    const reason = String(error).slice(0, 500);
    await supabase.from("mkhandi_scanner_health").upsert({
      symbol, market_name: marketName, deriv_connected: derivConnected, last_scan_at: nowIso(), last_error: reason, updated_at: nowIso()
    });
    return { symbol, state: "ERROR", error: reason.slice(0, 250) };
  }
}

async function processUser(user: any, activeSymbols: any[], deriv: DerivClient) {
  const legacy = (user.market_names || {}) as Record<string, string>;
  const requestedNames = Array.isArray(user.markets) && user.markets.length
    ? user.markets.slice(0, 10)
    : DEFAULT_MARKETS;
  const markets = requestedNames.map((name: string) => ({ name, symbol: resolveSymbol(name, activeSymbols, legacy) })).filter((item: any) => !!item.symbol);
  const marketNames = Object.fromEntries(markets.map((item: any) => [item.symbol, item.name]));
  await supabase.from("mkhandi_watchlists").update({
    symbols: markets.map((item: any) => item.symbol), market_names: marketNames, markets: requestedNames, updated_at: nowIso()
  }).eq("user_id", user.user_id);
  const results = await mapWithConcurrency(markets, 3, async (market) => {
    const result = await processMarket(user, market, deriv);
    console.log("Market scan result:", JSON.stringify({ user_id: user.user_id, market: market.name, ...result }));
    return result;
  });
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

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runBackgroundScanner() {
  const { data: acquired, error: lockError } = await supabase.rpc("mkhandi_acquire_worker_lease");
  if (lockError) {
    console.error("Scanner lease unavailable:", lockError.message);
    return;
  }
  if (!acquired) {
    console.log("Scanner invocation skipped: another worker owns the lease.");
    return;
  }

  try {
    const { data: users, error } = await supabase.from("mkhandi_watchlists")
      .select("user_id,symbols,markets,market_names,enabled,scan_interval_minutes")
      .eq("enabled", true);
    if (error) throw error;
    if (!users?.length) {
      console.log("Background scan completed: no enabled watchlists.");
      return;
    }

    const deriv = new DerivClient();
    try {
      const activeSymbols = await deriv.activeSymbols();
      console.log("Deriv active-symbol catalogue loaded:", activeSymbols.length);

      const results = [];
      for (const user of users) {
        const markets = await processUser(user, activeSymbols, deriv);
        results.push({ user_id: user.user_id, markets });
      }
      console.log("Background scan completed:", JSON.stringify({
        users: users.length,
        markets_processed: results.reduce((total, item) => total + item.markets.length, 0),
        results
      }));
    } finally {
      deriv.close();
    }
  } catch (error) {
    console.error("Background scanner run failed:", String(error));
  } finally {
    const { error } = await supabase.rpc("mkhandi_release_worker_lease");
    if (error) console.error("Could not release scanner lease:", error.message);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  if (req.headers.get("x-mkhandi-worker-secret") !== env("MKHANDI_WORKER_SECRET")) {
    return json({ error: "Unauthorized worker" }, 401);
  }
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "MKHANDI_WORKER_SECRET"]) {
    if (!env(key)) return json({ error: "Missing server secret: " + key }, 503);
  }

  // Acknowledge Supabase Cron immediately. The scan itself continues as a
  // managed background task, avoiding pg_net's short HTTP response timeout.
  EdgeRuntime.waitUntil(runBackgroundScanner().catch((error) => {
    console.error("Unhandled background scanner failure:", String(error));
  }));
  return json({ ok: true, accepted: true, source: "supabase-cron", accepted_at: nowIso() }, 202);
});
