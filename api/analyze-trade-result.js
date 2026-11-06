// MKHANDI AI SCAN — evidence review for submitted trade outcomes.
// Reviews chart/statement screenshots against an existing authenticated signal.
// This does not prove broker execution or fills.
export const config = { api: { bodyParser: { sizeLimit: "12mb" } }, maxDuration: 45 };

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    evidence_sufficient: { type: "boolean" },
    outcome_supported: { type: "boolean" },
    observed_outcome: { type: "string", enum: ["WIN","LOSS","BREAKEVEN","PARTIAL","UNCLEAR"] },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    explanation: { type: "string" },
    visible_prices: { type: "array", items: { type: "number" } },
    limitations: { type: "array", items: { type: "string" } }
  },
  required: ["evidence_sufficient","outcome_supported","observed_outcome","confidence","explanation","visible_prices","limitations"]
};
function send(res,status,body){res.setHeader("Cache-Control","no-store");return res.status(status).json(body);}
export default async function handler(req,res){
  if(req.method!=="POST")return send(res,405,{error:"POST required"});
  try{
    const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
    if(!token)return send(res,401,{error:"Sign in is required to review trade evidence."});
    const base=process.env.SUPABASE_URL||"https://xrthszxomclwrleezkem.supabase.co";
    const anon=process.env.SUPABASE_ANON_KEY;
    if(!anon)return send(res,503,{error:"Supabase authentication is not configured on this deployment."});
    const auth=await fetch(base+"/auth/v1/user",{headers:{apikey:anon,Authorization:"Bearer "+token}});
    if(!auth.ok)return send(res,401,{error:"Your session could not be verified. Please sign in again."});
    if(!process.env.OPENAI_API_KEY)return send(res,503,{error:"OpenAI is not configured for evidence review."});
    const {image,signal,submittedOutcome}=req.body||{};
    if(typeof image!=="string"||!/^data:image\/(jpeg|png|webp);base64,/.test(image)||image.length>12*1024*1024)
      return send(res,400,{error:"Upload one JPEG, PNG or WEBP evidence screenshot (maximum 8 MB)."});
    if(!signal||!["BUY","SELL"].includes(signal.direction)||!["WIN","LOSS","BREAKEVEN","PARTIAL"].includes(submittedOutcome))
      return send(res,400,{error:"A linked BUY/SELL signal and a valid submitted outcome are required."});
    const prompt="Review this user-submitted trading screenshot as evidence for a signal. Do not assume that the user executed the trade. Compare visible instrument, direction and price levels against the signal details below. Decide whether the screenshot visibly supports the claimed outcome through price movement/level touches. A chart price touching TP or stop is price-level evidence only, NOT proof of broker execution or fills. If the screenshot is cropped, unreadable, mismatched or cannot establish the claimed result, set evidence_sufficient=false and observed_outcome=UNCLEAR. Never infer missing fills, PnL or account details. Signal: "+JSON.stringify({asset:signal.market_name||signal.symbol,direction:signal.direction,entry:signal.entry,stop:signal.invalidation,tp1:signal.tp1,tp2:signal.tp2})+". User-submitted outcome: "+submittedOutcome+". Return concise factual reasoning and limitations.";
    const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:process.env.OPENAI_MODEL||"gpt-4.1",input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:image,detail:"high"}]}],text:{format:{type:"json_schema",name:"mkhandi_trade_evidence_review",strict:true,schema}},max_output_tokens:700}),signal:AbortSignal.timeout(40000)});
    const raw=await response.json();
    if(!response.ok)return send(res,502,{error:raw?.error?.message||"AI evidence review failed."});
    const text=(raw.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==="output_text").map(x=>x.text).join("\n");
    const review=JSON.parse(text);
    const supported=review.evidence_sufficient===true&&review.outcome_supported===true&&review.observed_outcome===submittedOutcome&&review.confidence>=80;
    return send(res,200,{...review,review_status:supported?"AI_SUPPORTED":(review.evidence_sufficient?"AI_CONFLICT":"INSUFFICIENT_EVIDENCE"),execution_verified:false});
  }catch(error){console.error("MKHANDI trade evidence review failed",error);return send(res,500,{error:"Unable to review this evidence. Please retry with a clearer screenshot."});}
}
