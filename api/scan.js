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
  const match = /boundary=(?:"([^"]+)"|([^;\\s]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("Expected a multipart chart upload. Please retry the upload."), { status: 400 });
  const boundary = Buffer.from("--" + (match[1] || match[2]).trim());
  const fields = Object.create(null);
  let cursor = 0;

  // Parse each MIME part by its headers, keeping image bytes as Buffer data.
  while (cursor < buffer.length) {
    const marker = buffer.indexOf(boundary, cursor);
    if (marker < 0) break;
    let partStart = marker + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === "--") break;
    if (buffer.subarray(partStart, partStart + 2).toString() === "\\r\\n") partStart += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\\r\\n\\r\\n"), partStart);
    if (headerEnd < 0) break;
    const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
    if (nextBoundary < 0) break;

    const headers = buffer.subarray(partStart, headerEnd).toString("latin1");
    let dataEnd = nextBoundary;
    if (buffer.subarray(dataEnd - 2, dataEnd).toString() === "\\r\\n") dataEnd -= 2;
    const data = buffer.subarray(headerEnd + 4, dataEnd);

    const disposition = headers.split(/\\r?\\n/).find(line => /^content-disposition:/i.test(line)) || "";
    const nameMatch = /(?:^|;)\\s*name="([^"]+)"/i.exec(disposition);
    const filenameMatch = /(?:^|;)\\s*filename="([^"]*)"/i.exec(disposition);
    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        const typeLine = headers.split(/\\r?\\n/).find(line => /^content-type:/i.test(line)) || "";
        const typeMatch = /^content-type:\\s*([^\\r\\n]+)/i.exec(typeLine);
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
    recommendation: { type: "string", enum: ["BUY", "SELL", "NO TRADE"] },
    overall_bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    market_structure: { type: "string" },
    timeframe_analysis: { type: "string" },
    entry: { type: ["number", "null"] },
    stop_loss: { type: ["number", "null"] },
    take_profit_1: { type: ["number", "null"] },
    take_profit_2: { type: ["number", "null"] },
    risk_reward: { type: ["number", "null"] },
    invalidation: { type: "string" },
    reasons: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["instrument","executionTimeframe","recommendation","overall_bias","confidence","summary","market_structure","timeframe_analysis","entry","stop_loss","take_profit_1","take_profit_2","risk_reward","invalidation","reasons","warnings"]
};

function normalizeAndValidate(result, fields) {
  const direction = result.recommendation;
  const prices = [result.entry, result.stop_loss, result.take_profit_1, result.take_profit_2];
  const validPrices = prices.every(v => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0));
  let reasons = Array.isArray(result.reasons) ? result.reasons.slice(0, 8) : [];
  let warnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 8) : [];
  let recommendation = direction;
  const [entry, sl, tp1, tp2] = prices;
  const geometryOk = entry !== null && sl !== null && tp2 !== null &&
    ((direction === "BUY" && sl < entry && tp2 > entry) ||
     (direction === "SELL" && sl > entry && tp2 < entry));
  if (!validPrices || (direction !== "NO TRADE" && !geometryOk)) {
    recommendation = "NO TRADE";
    warnings.push("Signal validation failed: prices were missing, invalid, or inconsistent with the proposed direction.");
  }
  if (recommendation !== "NO TRADE" && (!Number.isFinite(result.confidence) || result.confidence < 65)) {
    recommendation = "NO TRADE";
    warnings.push("Confidence did not meet MKHANDI's minimum 65% threshold.");
  }
  let rr = null;
  if (entry !== null && sl !== null && tp2 !== null && Math.abs(entry - sl) > 0) {
    rr = Number((Math.abs(tp2 - entry) / Math.abs(entry - sl)).toFixed(2));
    if (recommendation !== "NO TRADE" && rr < 1.5) {
      recommendation = "NO TRADE";
      warnings.push("Risk-to-reward did not meet MKHANDI's minimum 1:1.5 threshold.");
    }
  }
  if (recommendation === "NO TRADE") reasons.push("MKHANDI validation did not confirm a tradeable setup. Wait for clearer confirmation.");
  return {
    ...result,
    instrument: String(fields.instrument || result.instrument || "Uploaded chart").slice(0, 100),
    executionTimeframe: String(fields.executionTimeframe || result.executionTimeframe || "Not specified").slice(0, 12),
    recommendation,
    entry: recommendation === "NO TRADE" ? entry : entry,
    stop_loss: sl,
    take_profit_1: tp1,
    take_profit_2: tp2,
    risk_reward: rr,
    // Compatibility aliases consumed by the existing MKHANDI dashboard renderer.
    score: Number.isFinite(result.confidence) ? result.confidence : 0,
    execution_timeframe: String(fields.executionTimeframe || result.executionTimeframe || "M15").slice(0, 12),
    tp1,
    tp2,
    setup_type: recommendation === "NO TRADE" ? "WAIT FOR CONFIRMATION" : "MULTI-TIMEFRAME SETUP",
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
    const chartNames = ["H4", "H1", "M30", "M15", "M5", "M1", "D1"];
    const chartFiles = chartNames.filter(name => fields[name]?.data?.length);
    if (!chartFiles.length) return send(res, 400, { error: "No chart images were received. Upload the required timeframe charts and try again." });
    const images = chartFiles.map(name => ({ name, data: imageToDataUrl(fields[name], name) }));
    const timeframe = String(fields.executionTimeframe || "M15").slice(0, 12);
    const instrument = String(fields.instrument || "Uploaded chart").slice(0, 100);
    const context = fields.technicalState ? String(fields.technicalState).slice(0, 12000) : "";
    const content = [
      { type: "input_text", text:
        "You are MKHANDI AI SCAN, a cautious technical chart analyst. Analyse the attached chart screenshots for the same instrument. " +
        "Instrument: " + instrument + ". Execution timeframe: " + timeframe + ". Charts supplied in order: " + images.map(i=>i.name).join(", ") + ". " +
        "Technical scanner context (untrusted supporting context): " + (context || "Not supplied") + ". " +
        "Identify visible structure, trend, support/resistance and timeframe agreement. Never invent unreadable prices; if price levels cannot be read reliably, return NO TRADE and null levels. " +
        "BUY requires a plausible entry, stop below entry and TP2 above entry. SELL requires stop above entry and TP2 below entry. " +
        "Only recommend BUY/SELL if the chart evidence is clear, confidence is at least 65%, and TP2 offers at least 1.5R. Otherwise return NO TRADE. " +
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
    return send(res, error.status || 500, { error: error.status ? error.message : "MKHANDI could not process the chart upload. Please retry. " + (process.env.NODE_ENV === "development" ? error.message : "") });
  }
}
