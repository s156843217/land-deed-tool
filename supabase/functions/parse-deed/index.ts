// parse-deed：把一份土地謄本（PDF 或照片）解析成結構化 JSON
// 前端只送 base64 檔案內容過來，這裡才是唯一碰得到 GEMINI_API_KEY 的地方。
// 解析結果不會直接寫入資料庫——前端要先給使用者複核確認過，才由前端呼叫 Supabase 寫入 parcels/documents/owners。
//
// 用 Google Gemini（免費額度，不用綁信用卡）而不是 Anthropic Claude，是使用者明確要求「這塊先不要花錢」。
// 如果之後想換成 Claude：只要改這個檔案裡「呼叫哪個 API」的部分，前端 app.js 完全不用動，
// 因為前端只認得回傳的 { parcel, owners } 這個固定格式，不管背後是哪個模型算出來的。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// 免費額度是「每個型號」各自獨立的每日配額，實測 gemini-2.5-flash 只有一天 20 次，
// 測試/正式使用量一多很容易當天就用完。依序嘗試這個清單，前面的額度用完(429)就自動換下一個，
// 不用整天卡住等隔天重置。gemini-2.0-flash 免費額度已經是 0，故不放進清單。
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.0-flash-lite"];

// Gemini 的 responseSchema 語法是 OpenAPI 子集，跟一般 JSON Schema 不太一樣：
// type 要大寫（STRING/NUMBER/INTEGER/OBJECT/ARRAY），「可能是 null」要用 nullable:true，不能用 type 陣列。
const DEED_SCHEMA = {
  type: "OBJECT",
  required: ["parcel", "owners"],
  properties: {
    parcel: {
      type: "OBJECT",
      required: ["section", "lot_no", "area_sqm", "area_ping", "land_use"],
      properties: {
        section: { type: "STRING", nullable: true, description: "段小段，例如「福山段」" },
        lot_no: { type: "STRING", nullable: true, description: "地號，例如「1680」" },
        area_sqm: { type: "NUMBER", nullable: true, description: "總面積，單位平方公尺" },
        area_ping: { type: "NUMBER", nullable: true, description: "總面積，單位坪" },
        land_use: { type: "STRING", nullable: true, description: "地目或使用分區，查不到就 null，不要用面積或其他欄位臆測" },
      },
    },
    owners: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: [
          "reg_sequence", "name", "address", "share_numerator", "share_denominator",
          "share_area_sqm", "share_area_ping", "reg_date", "reg_reason", "reason_date",
        ],
        properties: {
          reg_sequence: { type: "INTEGER", nullable: true, description: "登記次序：所有權部裡這筆登記事件的流水號，同一地號內遞增且唯一，查不到就 null" },
          name: { type: "STRING", nullable: true, description: "所有權人姓名，謄本上若已模糊處理就照原樣輸出" },
          address: { type: "STRING", nullable: true },
          share_numerator: { type: "INTEGER", nullable: true, description: "持分分子，保留謄本原始整數，不要自行化簡分數" },
          share_denominator: { type: "INTEGER", nullable: true, description: "持分分母，保留謄本原始整數，不要自行化簡分數" },
          share_area_sqm: { type: "NUMBER", nullable: true },
          share_area_ping: { type: "NUMBER", nullable: true },
          reg_date: { type: "STRING", nullable: true, description: "登記日期，保留謄本原文的民國年格式，例如 068/07/31，不要轉換成西元" },
          reg_reason: { type: "STRING", nullable: true, description: "登記原因，例如「繼承」「買賣」" },
          reason_date: { type: "STRING", nullable: true, description: "原因發生日期，保留原文格式" },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `你是土地謄本（土地登記謄本）資料解析助手。使用者會給你一份謄本的 PDF 或照片，裡面通常包含「標示部」（地號、面積、地目/使用分區）與「所有權部」（每位共有人的姓名、住址、持分分子分母、登記日期、登記原因、原因發生日期）。

規則：
- 只輸出繁體中文，絕不輸出日文或簡體字。
- 只擷取謄本上「明確寫出」的資訊，查不到或無法確定的欄位一律輸出 null，絕對不可以自行臆測或捏造姓名、地址、數字。
- 持分分子分母要保留謄本原始整數，不要自行約分化簡。
- 日期一律保留謄本原文的民國年格式（例如 068/07/31），不要換算成西元年。
- 一份謄本通常對應一筆地號，owners 陣列要列出該地號謄本上出現的「每一位」所有權人，即使有幾百位也要全部列出，不要省略或只列前幾筆。
- 每一位所有權人都要擷取「登記次序」（所有權部裡該筆登記的流水號），這是判斷是否為同一筆登記記錄的重要依據，務必仔細找，真的沒有才輸出 null。
- 謄本上姓名若已經是官方模糊處理過的格式（例如只留姓氏），就照原樣輸出，不要試圖還原。`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { file_base64, mime_type, filename } = await req.json();
    if (!file_base64 || !mime_type) {
      return new Response(JSON.stringify({ error: "缺少 file_base64 或 mime_type" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    const body = {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type, data: file_base64 } },
            { text: `請解析這份謄本（檔名：${filename ?? "未知"}），輸出結構化資料。` },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: DEED_SCHEMA,
        // gemini-2.5-flash 預設會先「思考」再回答，思考過程也會占用 maxOutputTokens 額度，
        // 這裡的任務是單純擷取資料不需要推理，關掉可以把額度留給真正的 JSON 輸出、也比較快。
        thinkingConfig: { thinkingBudget: 0 },
        // 免費版模型的輸出長度還是有上限。如果謄本共有人多達數百人（多代繼承常見），
        // 單次回應仍可能被截斷解析失敗——這是已知限制，之後真的常常遇到再考慮分批處理。
        maxOutputTokens: 65536,
      },
    };

    let text: string | undefined;
    let lastErrorText = "";
    for (const model of GEMINI_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        const json = await resp.json();
        text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        break;
      }

      const errText = await resp.text();
      lastErrorText = `Gemini API 錯誤 (${resp.status})[${model}]: ${errText}`;
      // 429=額度用完才換下一個型號重試；其他錯誤（例如檔案格式問題）換型號也不會好，直接中止。
      if (resp.status !== 429) throw new Error(lastErrorText);
    }

    if (!text) throw new Error(lastErrorText || "Gemini 沒有回傳可用的內容，可能是被安全過濾器擋下或輸出被截斷");

    const parsed = JSON.parse(text);

    return new Response(JSON.stringify(parsed), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("parse-deed error", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
