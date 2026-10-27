// MKHANDI AI SCAN — server-side chart analysis endpoint
// Vercel Node.js function. OpenAI credentials remain server-side.
export const config = { api: { bodyParser: false }, maxDuration: 60 };

const MAX_BODY_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Uploaded charts are too large. Please use smaller screenshots."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("Expected a multipart chart upload. Please retry the upload."), { status: 400 });
  const boundary = Buffer.from("--" + (match[1] || match[2]).trim());
  const fields = Object.create(null);
  let cursor = 0;

  while (cursor < buffer.length) {
    const marker = buffer.indexOf(boundary, cursor);
    if (marker < 0) break;
    let partStart = marker + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === "--") break;
    if (buffer.subarray(partStart, partStart + 2).toString() === "\r\n") partStart += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd < 0) break;
    const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
    if (nextBoundary < 0) break;

    const headers = buffer.subarray(partStart, headerEnd).toString("latin1");
    let dataEnd = nextBoundary;
    if (buffer.subarray(dataEnd - 2, dataEnd).toString() === "\r\n") dataEnd -= 2;
    const data = buffer.subarray(headerEnd + 4, dataEnd);

    const headerLines = headers.split(/\r?\n/);
    const disposition = headerLines.find(line => /^content-disposition:/i.test(line)) || "";
    const nameMatch = /(?:^|;)\s*name="([^"]+)"/i.exec(disposition);
    const filenameMatch = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition);
    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        const typeLine = headerLines.find(line => /^content-type:/i.test(line)) || "";
        const typeMatch = /^content-type:\s*([^\r\n]+)/i.exec(typeLine);
        fields[name] = {
          filename: filenameMatch[1],
          contentType: (typeMatch?.[1] || "application/octet-stream").trim().toLowerCase(),
          data: Buffer.from(data)
        };
      } else {
        fields[name] = data.toString("utf8");
      }
    }
    cursor = nextBoundary;
  }
  return fields;
}

function imageToDataUrl(file, label) {
  if (!file || !Buffer.isBuffer(file.data) || !file.data.length) throw Object.assign(new Error("Missing chart image: " + label), { status: 400 });
  if (!ALLOWED_TYPES.has(file.contentType)) throw Object.assign(new Error(label + " must be a JPEG, PNG, WEBP, or GIF image."), { status: 415 });
  if (file.data.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(label + " is too large. Please upload an image under 8 MB."), { status: 413 });
  return "data:" + file.contentType + ";base64," + file.data.toString("base64");
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    instrument: { type: "string" },
    executionTimeframe: { type: "string" },
    trade_style: { type: "string", enum: ["SCALP", "INTRADAY", "SWING"] },
    recommendation: { type: "string", enum: ["BUY", "SELL", "NO TRADE"] },
    overall_bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    range_high: { type: ["number", "null"] },
    range_low: { type: ["number", "null"] },
    summary: { type: "string" },
    market_structure: { type: "string" },
    timeframe_analysis: { type: "string" },
    entry: { type: ["number", "null"] },
    stop_loss: { type: ["number", "null"] },
    take_profit_1: { type: ["number", "null"] },
    take_profit_2: { type: ["number", "null"] },
    risk_reward: { type: ["number", "null"] },
    invalidation: { type: "string" },
    support_levels: { type: "string" },
    resistance_levels: { type: "string" },
    potential_entry: { type: "string" },
    potential_stop_loss: { type: "string" },
    potential_tp1: { type: "string" },
    potential_tp2: { type: "string" },
    potential_risk_reward: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["instrument","executionTimeframe","trade_style","recommendation","overall_bias","confidence","range_high","range_low","summary","market_structure","timeframe_analysis","entry","stop_loss","take_profit_1","take_profit_2","risk_reward","invalidation","support_levels","resistance_levels","potential_entry","potential_stop_loss","potential_tp1","potential_tp2","potential_risk_reward","reasons","warnings"]
};

// Deterministic MMS Fibonacci engine. Coefficients are mapped from the range low (0.0) to range high (1.0).
// This keeps all prices reproducible; the AI identifies/assesses anchors, but does not calculate these levels.
export function calculateMmsFibonacciLevels(rangeLow, rangeHigh) {
  if (!Number.isFinite(rangeLow) || !Number.isFinite(rangeHigh) || rangeLow <= 0 || rangeHigh <= rangeLow) return null;
  const span = rangeHigh - rangeLow;
  const coefficients = [
    [2.8, "Setup Complete"], [2.0, "Close 50%"], [1.2, "2nd chance"],
    [1.0, "BUY"], [0.5, "SL"], [0.0, "SELL"],
    [-0.2, "2nd chance"], [-1.0, "Close 50%"], [-1.8, "Setup Complete"]
  ];
  const levels = {};
  for (const [coefficient, label] of coefficients) {
    levels[String(coefficient)] = {
      label,
      price: Number((rangeLow + span * coefficient).toFixed(8))
    };
  }
  return {
    range_low: Number(rangeLow.toFixed(8)),
    range_high: Number(rangeHigh.toFixed(8)),
    range_size: Number(span.toFixed(8)),
    levels,
    buy_entry: levels["1"].price,
    sell_entry: levels["0"].price,
    stop_loss: levels["0.5"].price,
    buy_close_50: levels["2"].price,
    buy_second_chance: levels["1.2"].price,
    buy_setup_complete: levels["2.8"].price,
    sell_second_chance: levels["-0.2"].price,
    sell_close_50: levels["-1"].price,
    sell_setup_complete: levels["-1.8"].price
  };
}

function normalizeAndValidate(result, fields) {
  const direction = result.recommendation;
  let reasons = Array.isArray(result.reasons) ? result.reasons.slice(0, 8) : [];
  let warnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 8) : [];
  let recommendation = direction;
  const mmsLevels = calculateMmsFibonacciLevels(result.range_low, result.range_high);
  if (!mmsLevels) {
    warnings.push("MMS Fibonacci engine: valid range_low/range_high anchors were not available; calculated levels cannot be trusted.");
    if (direction !== "NO TRADE") recommendation = "NO TRADE";
  }
  // Deterministic MMS levels are the source of truth for entry, stop and target prices.
  if (mmsLevels && (direction === "BUY" || direction === "SELL")) {
    result.entry = direction === "BUY" ? mmsLevels.buy_entry : mmsLevels.sell_entry;
    result.stop_loss = mmsLevels.stop_loss;
    result.take_profit_1 = direction === "BUY" ? mmsLevels.buy_close_50 : mmsLevels.sell_close_50;
    result.take_profit_2 = direction === "BUY" ? mmsLevels.buy_setup_complete : mmsLevels.sell_setup_complete;
  }
  const [entry, sl, tp1, tp2] = [result.entry, result.stop_loss, result.take_profit_1, result.take_profit_2];
  const validPrices = [entry, sl, tp1, tp2].every(v => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0));
  const geometryOk = entry !== null && sl !== null && tp2 !== null &&
    ((direction === "BUY" && sl < entry && tp2 > entry) ||
     (direction === "SELL" && sl > entry && tp2 < entry));
  if (!validPrices || (direction !== "NO TRADE" && !geometryOk)) {
    recommendation = "NO TRADE";
    warnings.push("Signal validation failed: prices were missing, invalid, or inconsistent with the proposed direction.");
  }
  if (recommendation !== "NO TRADE" && (!Number.isFinite(result.confidence) || result.confidence < 55)) {
    recommendation = "NO TRADE";
    warnings.push("Confidence did not meet MKHANDI's minimum 55% candidate threshold.");
  }
  let rr = null;
  if (entry !== null && sl !== null && tp2 !== null && Math.abs(entry - sl) > 0) {
    rr = Number((Math.abs(tp2 - entry) / Math.abs(entry - sl)).toFixed(2));
    if (recommendation !== "NO TRADE" && rr < 1.2) {
      recommendation = "NO TRADE";
      warnings.push("Risk-to-reward did not meet MKHANDI's minimum 1:1.2 candidate threshold.");
    }
  }
  if (recommendation === "NO TRADE") reasons.push("MKHANDI validation did not confirm a tradeable setup. Wait for clearer confirmation.");
  const selectedTF = String(fields.executionTimeframe || result.executionTimeframe || "M15").toUpperCase();
  const tradeStyle = ["M1","M5","M15"].includes(selectedTF) ? "SCALP" : (["H4","D1","W1","MN1"].includes(selectedTF) ? "SWING" : "INTRADAY");
  return {
    ...result,
    trade_style: tradeStyle,
    instrument: String(fields.instrument || result.instrument || "Uploaded chart").slice(0, 100),
    executionTimeframe: String(fields.executionTimeframe || result.executionTimeframe || "Not specified").slice(0, 12),
    recommendation,
    entry, stop_loss: sl, take_profit_1: tp1, take_profit_2: tp2,
    risk_reward: rr,
    mms_fibonacci: mmsLevels,
    score: Number.isFinite(result.confidence) ? result.confidence : 0,
    execution_timeframe: String(fields.executionTimeframe || result.executionTimeframe || "M15").slice(0, 12),
    tp1, tp2,
    setup_type: recommendation === "NO TRADE" ? "WAIT FOR CONFIRMATION" : "MMS FIBONACCI BREAKOUT",
    gate_status: recommendation === "NO TRADE" ? "NO TRADE · VALIDATION GATE" : "VALIDATED CANDIDATE · MANUAL REVIEW",
    reasoning: [...new Set(reasons)].map((text, index) => ({ label: "Reason " + (index + 1), value: text })),
    evidence: [],
    timeframes: [{ timeframe: "MULTI-TIMEFRAME", assessment: result.timeframe_analysis || "Not available" }],
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)]
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }
  if (req.method !== "POST") return send(res, 405, { error: "Use POST to upload chart screenshots." });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { error: "OpenAI is not configured on this deployment. Add OPENAI_API_KEY in Vercel Project Settings → Environment Variables, then redeploy." });
  try {
    const body = await readBody(req);
    const fields = parseMultipart(body, req.headers["content-type"]);
    const chartNames = ["MN1", "W1", "D1", "H4", "H1", "M30", "M15", "M5", "M1"];
    const chartFiles = chartNames.filter(name => fields[name]?.data?.length);
    const missingRequired = ["H1", "M15"].filter(name => !fields[name]?.data?.length);
    if (missingRequired.length) return send(res, 400, { error: "H1 and M15 charts are required. Missing: " + missingRequired.join(", ") + ". A third timeframe is optional." });
    const images = chartFiles.map(name => ({ name, data: imageToDataUrl(fields[name], name) }));
    const timeframe = String(fields.executionTimeframe || "M15").slice(0, 12);
    const instrument = String(fields.instrument || "Uploaded chart").slice(0, 100);
    const context = fields.technicalState ? String(fields.technicalState).slice(0, 12000) : "";
    const content = [
      { type: "input_text", text:
        "You are MKHANDI AI SCAN, a cautious technical chart analyst. Analyse the attached chart screenshots for the same instrument. " +
        "Instrument: " + instrument + ". Execution timeframe: " + timeframe + ". Charts supplied in order: " + images.map(i=>i.name).join(", ") + ". " +
        "Technical scanner context (untrusted supporting context): " + (context || "Not supplied") + ". " +
        "Use H1 and M15 as the only mandatory alignment timeframes: H1 establishes higher-timeframe direction and M15 confirms the entry context. Any third chart is optional supporting context only; disagreement, missing data, or absence of a third chart must not independently veto an otherwise valid H1+M15 setup. Clearly state when the optional timeframe adds caution, but do not require three-way alignment. Identify visible structure, trend, support/resistance and timeframe agreement. Never invent unreadable prices; if price levels cannot be read reliably, return NO TRADE and null levels. " +
        "Also evaluate the user\u2019s MMS Fibonacci range-breakout methodology when chart evidence supports it. Look for consolidation/range boundaries, relevant swing high and swing low, and whether a breakout is confirmed or still pending. The custom MMS levels are: 2.8 Setup Complete; 2.0 Close 50%; 1.2 2nd chance; 1.0 BUY; 0.5 SL; 0.0 SELL; -0.2 2nd chance; -1.0 Close 50%; -1.8 Setup Complete. Treat these as user-defined labels and level coefficients, not proof of a valid trade. Do not fabricate exact Fibonacci prices or assume anchor orientation if the screenshot does not make them clear; explain uncertainty and return NO TRADE when reliable levels cannot be determined. Consider both BUY and SELL directions for every instrument: do not impose Boom-sell-only or Crash-buy-only restrictions. Assess the actual chart structure and strategy evidence instead. Do not execute trades. " +
        "BUY requires a plausible entry, stop below entry and TP2 above entry. SELL requires stop above entry and TP2 below entry. " +
        "Use H1 for context and the selected execution timeframe for entry timing. Do not demand perfect directional agreement when H1 is neutral, corrective, or ranging: a clear continuation, breakout, or retest on the execution timeframe may qualify if H1 does not show strong opposing structure. A third timeframe is optional and must never be a mandatory gate. Recommend a conditional BUY/SELL candidate when chart evidence supports direction, a plausible entry, logical invalidation/stop, readable levels, confidence of at least 55%, and projected TP2 of at least 1.2R. Reserve NO TRADE for genuinely unclear structure, unreadable/missing levels, strong opposing evidence, or invalid risk geometry. If a coherent setup awaits a trigger, return the candidate direction with a clearly stated trigger and label it conditional. Never invent price levels or force a signal when evidence is insufficient. " +
        "Do not claim certainty or guaranteed outcomes. Return concise, actionable reasoning and list uncertainties in warnings."
      },
      ...images.flatMap(i => [{ type: "input_text", text: "Chart timeframe: " + i.name }, { type: "input_image", image_url: i.data, detail: "high" }])
    ];
    const model = process.env.OPENAI_MODEL || "gpt-4.1";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content }],
        text: { format: { type: "json_schema", name: "mkhandi_chart_analysis", strict: true, schema: outputSchema } },
        max_output_tokens: 1600
      }),
      signal: AbortSignal.timeout(50000)
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error("OpenAI returned an unreadable response (HTTP " + response.status + ")."); }
    if (!response.ok) {
      const detail = payload?.error?.message || "OpenAI request failed.";
      const status = response.status === 401 ? 502 : (response.status === 429 ? 429 : 502);
      return send(res, status, { error: "MKHANDI AI could not complete the scan: " + detail });
    }
    const outputText = (payload.output || []).flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("\n");
    if (!outputText) return send(res, 502, { error: "OpenAI returned no chart analysis. Please try again with clearer screenshots." });
    let analysis;
    try { analysis = JSON.parse(outputText); } catch { return send(res, 502, { error: "The AI response could not be validated. Please retry the scan." }); }
    return send(res, 200, normalizeAndValidate(analysis, fields));
  } catch (error) {
    console.error("MKHANDI /api/scan error:", error);
    return send(res, error.status || 500, { error: error.status ? error.message : "MKHANDI backend error: " + (error?.message || "Unknown server error") });
  }
}
