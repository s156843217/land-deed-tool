// 土地謄本管理工具 — 前端主程式
// 架構：純前端 + Supabase（Auth/DB/Storage/Edge Function），沒有建置工具。
// 登入流程沿用 linkou-crm 已踩過並修好的兩個雷：
//   1) 只用 onAuthStateChange，不額外呼叫 getSession()，用序列化佇列＋uid 去重避免重複觸發
//   2) 回呼內用 setTimeout(...,0) 延後處理，避免跟 signInWithPassword 互搶 Web Lock 卡死

const $ = (s) => document.querySelector(s);

const cfg = window.LAND_DEED_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage },
});

let currentUser = null;

// ---------- 登入 ----------

let authChain = Promise.resolve();
let currentUid = undefined;

function handleAuth(session) {
  authChain = authChain.then(() => onSession(session)).catch((e) => console.error("auth error", e));
  return authChain;
}

async function onSession(session) {
  const uid = session?.user?.id ?? null;
  if (uid === currentUid) return; // 狀態沒變（含 TOKEN_REFRESHED 等重複事件）就不重跑
  currentUid = uid;

  if (!uid) {
    currentUser = null;
    showLogin();
    return;
  }

  // 再向後端驗證一次，避免殘留失效 session 導致「看似登入卻沒資料」
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) {
    await sb.auth.signOut();
    currentUser = null;
    showLogin("登入已逾期，請重新登入");
    return;
  }
  currentUser = data.user;
  hideLogin();
  refreshSearchPage();
}

sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => handleAuth(session), 0);
});

function showLogin(message) {
  $("#loginOverlay").classList.remove("hidden");
  if (message) $("#loginError").textContent = message;
}

function hideLogin() {
  $("#loginOverlay").classList.add("hidden");
  $("#loginError").textContent = "";
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginError").textContent = "";
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) $("#loginError").textContent = "登入失敗：帳號或密碼錯誤";
});

$("#navLogout").addEventListener("click", async () => {
  await sb.auth.signOut();
});

// ---------- 頁面切換 ----------

function showPage(name) {
  $("#pageUpload").classList.toggle("hidden", name !== "upload");
  $("#pageImport").classList.toggle("hidden", name !== "import");
  $("#pageSearch").classList.toggle("hidden", name !== "search");
  $("#navUpload").classList.toggle("active", name === "upload");
  $("#navImport").classList.toggle("active", name === "import");
  $("#navSearch").classList.toggle("active", name === "search");
  if (name === "search") refreshSearchPage();
}

$("#navUpload").addEventListener("click", () => showPage("upload"));
$("#navImport").addEventListener("click", () => showPage("import"));
$("#navSearch").addEventListener("click", () => showPage("search"));

// ---------- 上傳與解析（支援一次多個檔案，依序解析，逐份核對存檔） ----------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // 去掉 data:xxx;base64, 前綴
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 拖拉檔案到上傳框：一般 <input type="file"> 也吃拖放，但目標範圍太小很難丟中，
// 這裡讓整個框都能接住拖放的檔案，體驗跟點「選擇檔案」一致。
const dropZone = $("#uploadDropZone");
["dragenter", "dragover"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  })
);
dropZone.addEventListener("drop", (e) => {
  const dropped = e.dataTransfer?.files;
  if (dropped && dropped.length > 0) {
    $("#deedFile").files = dropped;
    $("#parseStatus").textContent = `已選取 ${dropped.length} 個檔案，可按「開始解析」`;
  }
});

$("#btnParse").addEventListener("click", async () => {
  const files = [...$("#deedFile").files];
  if (files.length === 0) {
    $("#parseStatus").textContent = "請先選擇檔案";
    return;
  }
  $("#btnParse").disabled = true;
  for (let i = 0; i < files.length; i++) {
    $("#parseStatus").textContent = `解析中 (${i + 1}/${files.length})：${files[i].name}（謄本共有人多的話可能要一點時間）…`;
    await parseOneFile(files[i]);
  }
  $("#parseStatus").textContent = files.length > 1 ? `${files.length} 份都解析完成，請逐一核對下方結果再存檔` : "解析完成，請核對下方內容";
  $("#btnParse").disabled = false;
  $("#deedFile").value = "";
});

async function parseOneFile(file) {
  try {
    const base64 = await fileToBase64(file);
    const { data, error } = await sb.functions.invoke("parse-deed", {
      body: { file_base64: base64, mime_type: file.type, filename: file.name },
    });
    if (error) throw error;
    const owners = fillMissingShareAreas(data.parcel, data.owners);
    await addPreviewCard(data.parcel, owners, file);
  } catch (err) {
    console.error(err);
    const message = await describeFunctionError(err);
    addFailedCard(file, message);
  }
}

// sb.functions.invoke() 在 Edge Function 回傳非 2xx 時，err.message 只會是很籠統的
// "Edge Function returned a non-2xx status code"，真正的原因在 err.context 這個 Response 裡，
// 要另外讀出來才看得到（例如 Gemini 額度用完、輸出被截斷等實際訊息）。
async function describeFunctionError(err) {
  try {
    if (err?.context && typeof err.context.json === "function") {
      const body = await err.context.json();
      if (body?.error) return body.error;
    }
  } catch (_) {
    // 讀不到詳細內容就退回下面的籠統訊息
  }
  return err?.message || String(err);
}

// 謄本上不一定會直接印出「持分面積」，但這是可以算出來的：總面積 × (持分分子/持分分母)。
// AI 解析沒抓到（留 null）時，用這個公式先幫忙算好，使用者核對時仍可手動修改。
function fillMissingShareAreas(parcel, owners) {
  const round2 = (n) => Math.round(n * 100) / 100;
  return owners.map((o) => {
    if (o.share_numerator == null || o.share_denominator == null || o.share_denominator === 0) return o;
    const ratio = o.share_numerator / o.share_denominator;
    return {
      ...o,
      share_area_sqm: o.share_area_sqm ?? (parcel.area_sqm != null ? round2(parcel.area_sqm * ratio) : null),
      share_area_ping: o.share_area_ping ?? (parcel.area_ping != null ? round2(parcel.area_ping * ratio) : null),
    };
  });
}

function blankOwner() {
  return {
    reg_sequence: null, name: "", address: "", share_numerator: null, share_denominator: null,
    share_area_sqm: null, share_area_ping: null, reg_date: "", reg_reason: "", reason_date: "",
  };
}

// 一份檔案一張卡片，用 class 選取（不能用 id，因為同一頁可能同時有好幾張卡片）
async function addPreviewCard(parcel, owners, file) {
  const tpl = $("#previewCardTemplate");
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector(".preview-card");

  card.querySelector(".pv-filename").textContent = file.name;
  card.querySelector(".pv-section").value = parcel.section ?? "";
  card.querySelector(".pv-lot_no").value = parcel.lot_no ?? "";
  card.querySelector(".pv-area_sqm").value = parcel.area_sqm ?? "";
  card.querySelector(".pv-area_ping").value = parcel.area_ping ?? "";
  card.querySelector(".pv-land_use").value = parcel.land_use ?? "";

  let ownersState = owners.slice();
  const ownersBody = card.querySelector(".pv-owners-body");
  const ownerCountEl = card.querySelector(".pv-owner-count");

  function renderRows() {
    ownersBody.innerHTML = "";
    ownersState.forEach((o, idx) => ownersBody.appendChild(buildOwnerRow(o, idx, ownersState, renderRows)));
    ownerCountEl.textContent = ownersState.length;
  }
  renderRows();

  card.querySelector(".pv-add-row").addEventListener("click", () => {
    ownersState.push(blankOwner());
    renderRows();
  });

  card.querySelector(".pv-cancel").addEventListener("click", () => card.remove());

  card.querySelector(".pv-confirm").addEventListener("click", async () => {
    const statusEl = card.querySelector(".pv-savestatus");
    const btn = card.querySelector(".pv-confirm");
    statusEl.textContent = "存檔中…";
    btn.disabled = true;
    try {
      const parcelPayload = {
        section: card.querySelector(".pv-section").value.trim(),
        lot_no: card.querySelector(".pv-lot_no").value.trim(),
        area_sqm: card.querySelector(".pv-area_sqm").value ? Number(card.querySelector(".pv-area_sqm").value) : null,
        area_ping: card.querySelector(".pv-area_ping").value ? Number(card.querySelector(".pv-area_ping").value) : null,
        land_use: card.querySelector(".pv-land_use").value.trim() || null,
      };
      if (!parcelPayload.section || !parcelPayload.lot_no) {
        throw new Error("段小段與地號為必填，請確認解析結果");
      }
      await saveDeed(parcelPayload, collectOwnersFromBody(ownersBody), file);
      statusEl.textContent = "✅ 已成功存入總表";
      statusEl.classList.add("save-success");
      card.classList.add("saved");
      btn.disabled = true;
      card.querySelector(".pv-cancel").textContent = "關閉";
    } catch (err) {
      console.error(err);
      statusEl.textContent = "存檔失敗：" + (err.message || err);
      btn.disabled = false;
    }
  });

  // 這個地號如果之前已經存過共有人資料，先提醒一下：
  // 登記次序相同的會自動更新覆蓋、不會產生重複，但還是讓使用者心裡有數。
  if (parcel.section && parcel.lot_no) {
    const { data: existing } = await sb
      .from("parcel_overview")
      .select("owner_count")
      .eq("section", parcel.section)
      .eq("lot_no", parcel.lot_no)
      .maybeSingle();
    if (existing && existing.owner_count > 0) {
      const note = card.querySelector(".pv-existing-note");
      note.textContent = `⚠️ 提醒：這個地號目前已存有 ${existing.owner_count} 筆共有人紀錄。登記次序相同的會自動更新覆蓋，不會產生重複；如果是全新的登記次序才會新增一筆。`;
      note.classList.remove("hidden");
    }
  }

  $("#previewList").prepend(card);
}

function addFailedCard(file, message) {
  const div = document.createElement("div");
  div.className = "panel";
  div.innerHTML = `<h3>${file.name}</h3><p class="hint" style="color:var(--danger);">解析失敗：${message}</p>`;
  $("#previewList").prepend(div);
}

function buildOwnerRow(o, idx, ownersState, rerender) {
  const tr = document.createElement("tr");
  const fields = [
    ["reg_sequence", o.reg_sequence], ["name", o.name], ["address", o.address],
    ["share_numerator", o.share_numerator], ["share_denominator", o.share_denominator],
    ["share_area_sqm", o.share_area_sqm], ["share_area_ping", o.share_area_ping],
    ["reg_date", o.reg_date], ["reg_reason", o.reg_reason], ["reason_date", o.reason_date],
  ];
  tr.innerHTML = fields.map(([key, val]) =>
    `<td><input type="text" data-key="${key}" value="${val ?? ""}"></td>`
  ).join("") + `<td><button type="button" class="btn danger btn-remove-owner" style="padding:4px 8px;">刪除</button></td>`;
  tr.querySelector(".btn-remove-owner").addEventListener("click", () => {
    ownersState.splice(idx, 1);
    rerender();
  });
  return tr;
}

function collectOwnersFromBody(body) {
  const num = (v) => (v === "" ? null : Number(v));
  const int = (v) => (v === "" ? null : parseInt(v, 10));
  return [...body.children].map((tr) => {
    const get = (key) => tr.querySelector(`[data-key="${key}"]`).value;
    return {
      reg_sequence: int(get("reg_sequence")),
      name: get("name") || null,
      address: get("address") || null,
      share_numerator: int(get("share_numerator")),
      share_denominator: int(get("share_denominator")),
      share_area_sqm: num(get("share_area_sqm")),
      share_area_ping: num(get("share_area_ping")),
      reg_date: get("reg_date") || null,
      reg_reason: get("reg_reason") || null,
      reason_date: get("reason_date") || null,
    };
  });
}

// 實際存檔邏輯：地號主檔 upsert、原始檔存 Storage、建立謄本紀錄、共有人明細用「地號+登記次序」upsert
// （登記次序相同 = 同一筆登記事件，重複上傳同一份謄本會自動覆蓋更新，不會產生重複的假共有人）
async function saveDeed(parcelPayload, owners, file) {
  const { data: parcelRow, error: parcelErr } = await sb
    .from("parcels")
    .upsert(parcelPayload, { onConflict: "section,lot_no" })
    .select()
    .single();
  if (parcelErr) throw parcelErr;

  // Supabase Storage 的路徑只能用英數字等安全字元，不能有中文，
  // 所以資料夾用地號的 id（英數字），檔名只保留副檔名；中文原始檔名另外存在 documents.original_filename 顯示用。
  const ext = (file.name.split(".").pop() || "bin").replace(/[^a-zA-Z0-9]/g, "") || "bin";
  const storagePath = `${parcelRow.id}/${Date.now()}.${ext}`;
  const { error: uploadErr } = await sb.storage.from("deeds").upload(storagePath, file);
  if (uploadErr) throw uploadErr;

  const { data: docRow, error: docErr } = await sb
    .from("documents")
    .insert({
      parcel_id: parcelRow.id,
      storage_path: storagePath,
      original_filename: file.name,
      uploaded_by: currentUser.id,
      parse_status: "parsed",
    })
    .select()
    .single();
  if (docErr) throw docErr;

  if (owners.length > 0) {
    const payload = owners.map((o) => ({ ...o, parcel_id: parcelRow.id, document_id: docRow.id }));
    const { error: ownersErr } = await sb.from("owners").upsert(payload, { onConflict: "parcel_id,reg_sequence" });
    if (ownersErr) throw ownersErr;
  }
}

// ---------- Excel 匯入（把已經整理好的舊總表直接搬進來，不呼叫 AI） ----------

const EXCEL_HEADER_MAP = {
  "段小段": "section", "地號": "lot_no",
  "面積(㎡)": "area_sqm", "面積（㎡）": "area_sqm", "面積(坪)": "area_ping", "面積（坪）": "area_ping",
  "所有權人": "name", "持分分子": "share_numerator", "持分分母": "share_denominator",
  "持分面積(㎡)": "share_area_sqm", "持分面積（㎡）": "share_area_sqm",
  "持分面積(坪)": "share_area_ping", "持分面積（坪）": "share_area_ping",
  "住址": "address", "登記日期": "reg_date", "登記原因": "reg_reason", "原因發生日期": "reason_date",
  "登記次序": "reg_sequence",
};

let excelImportState = null; // { parcelMap: Map(key -> parcel payload), owners: [{..., _key}] }

function toNum(v) {
  const n = Number(v);
  return v === "" || v == null || Number.isNaN(n) ? null : n;
}
function toInt(v) {
  const n = parseInt(v, 10);
  return v === "" || v == null || Number.isNaN(n) ? null : n;
}

$("#btnParseExcel").addEventListener("click", async () => {
  const file = $("#excelFile").files[0];
  if (!file) {
    $("#excelStatus").textContent = "請先選擇檔案";
    return;
  }
  $("#excelStatus").textContent = "讀取中…";
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

    // Excel 的欄位標題不一定在第一列（例如上面留了說明列），往下找幾列去比對欄名
    let headerRowIdx = -1;
    let colMap = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const cells = rows[i].map((c) => String(c ?? "").trim());
      const map = {};
      cells.forEach((label, colIdx) => {
        if (EXCEL_HEADER_MAP[label]) map[EXCEL_HEADER_MAP[label]] = colIdx;
      });
      if (map.name != null && map.lot_no != null) {
        headerRowIdx = i;
        colMap = map;
        break;
      }
    }
    if (headerRowIdx === -1) {
      throw new Error("找不到欄位標題列，請確認欄名跟說明一致（例如「所有權人」「地號」）");
    }

    const parcelMap = new Map();
    const owners = [];
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const get = (field) => (colMap[field] != null ? row[colMap[field]] : undefined);
      const section = String(get("section") ?? "").trim();
      const lotNo = String(get("lot_no") ?? "").trim();
      const name = String(get("name") ?? "").trim();
      if (!section && !lotNo && !name) continue; // 空白列跳過
      if (!section || !lotNo) continue; // 沒有地號資訊的列跳過

      const key = `${section}|${lotNo}`;
      if (!parcelMap.has(key)) {
        parcelMap.set(key, {
          section, lot_no: lotNo,
          area_sqm: toNum(get("area_sqm")), area_ping: toNum(get("area_ping")),
          land_use: null,
        });
      }
      owners.push({
        _key: key,
        reg_sequence: toInt(get("reg_sequence")),
        name: name || null,
        address: String(get("address") ?? "").trim() || null,
        share_numerator: toInt(get("share_numerator")),
        share_denominator: toInt(get("share_denominator")),
        share_area_sqm: toNum(get("share_area_sqm")),
        share_area_ping: toNum(get("share_area_ping")),
        reg_date: String(get("reg_date") ?? "").trim() || null,
        reg_reason: String(get("reg_reason") ?? "").trim() || null,
        reason_date: String(get("reason_date") ?? "").trim() || null,
      });
    }

    if (owners.length === 0) throw new Error("沒有讀到任何共有人資料列，請確認檔案內容");

    excelImportState = { parcelMap, owners };
    renderExcelPreview();
    $("#excelStatus").textContent = "讀取完成，請確認下方預覽";
  } catch (err) {
    console.error(err);
    $("#excelStatus").textContent = "讀取失敗：" + (err.message || err);
  }
});

function renderExcelPreview() {
  const { parcelMap, owners } = excelImportState;
  $("#excelPreviewPanel").classList.remove("hidden");
  $("#excelSummary").textContent = `偵測到 ${parcelMap.size} 筆地號，共 ${owners.length} 位共有人紀錄。確認無誤後按「確認匯入」寫入資料庫（不會呼叫 AI，也不會產生費用）。`;
  const body = $("#excelParcelBody");
  body.innerHTML = "";
  for (const [key, p] of parcelMap) {
    const count = owners.filter((o) => o._key === key).length;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.section}</td><td>${p.lot_no}</td><td>${count}</td>`;
    body.appendChild(tr);
  }
}

$("#btnCancelImport").addEventListener("click", () => {
  excelImportState = null;
  $("#excelPreviewPanel").classList.add("hidden");
  $("#excelFile").value = "";
  $("#excelStatus").textContent = "";
});

$("#btnConfirmImport").addEventListener("click", async () => {
  if (!excelImportState) return;
  $("#importStatus").textContent = "匯入中…";
  $("#btnConfirmImport").disabled = true;
  try {
    const { parcelMap, owners } = excelImportState;
    const parcelIdByKey = new Map();
    for (const [key, payload] of parcelMap) {
      const { data, error } = await sb.from("parcels").upsert(payload, { onConflict: "section,lot_no" }).select().single();
      if (error) throw error;
      parcelIdByKey.set(key, data.id);
    }

    const ownerPayload = owners.map(({ _key, ...rest }) => ({
      ...rest, parcel_id: parcelIdByKey.get(_key), document_id: null,
    }));

    const chunkSize = 500; // 分批寫入，避免一次送出太多筆
    for (let i = 0; i < ownerPayload.length; i += chunkSize) {
      const chunk = ownerPayload.slice(i, i + chunkSize);
      const { error } = await sb.from("owners").upsert(chunk, { onConflict: "parcel_id,reg_sequence" });
      if (error) throw error;
    }

    $("#importStatus").textContent = `匯入完成：${parcelMap.size} 筆地號、${owners.length} 位共有人。`;
  } catch (err) {
    console.error(err);
    $("#importStatus").textContent = "匯入失敗：" + (err.message || err);
    $("#btnConfirmImport").disabled = false;
  }
});

// ---------- 查詢頁 ----------

async function refreshSearchPage() {
  if (!currentUser) return;
  await runSearch("");
}

$("#btnSearch").addEventListener("click", () => runSearch($("#searchInput").value.trim()));
$("#searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch($("#searchInput").value.trim());
});

async function runSearch(keyword) {
  let parcelIds = null; // null = 不限制（沒有關鍵字或直接命中地號本身）

  if (keyword) {
    const { data: matchedOwners } = await sb
      .from("owners")
      .select("parcel_id")
      .or(`name.ilike.%${keyword}%,address.ilike.%${keyword}%`);
    const ownerParcelIds = [...new Set((matchedOwners || []).map((o) => o.parcel_id))];
    parcelIds = ownerParcelIds;
  }

  let query = sb.from("parcel_overview").select("*").order("created_at", { ascending: false });
  if (keyword) {
    if (parcelIds.length > 0) {
      query = sb
        .from("parcel_overview")
        .select("*")
        .or(`section.ilike.%${keyword}%,lot_no.ilike.%${keyword}%,id.in.(${parcelIds.join(",")})`)
        .order("created_at", { ascending: false });
    } else {
      query = query.or(`section.ilike.%${keyword}%,lot_no.ilike.%${keyword}%`);
    }
  }

  const { data: parcels, error } = await query;
  if (error) {
    console.error(error);
    return;
  }
  renderParcelList(parcels || []);
}

function renderParcelList(parcels) {
  const body = $("#parcelListBody");
  body.innerHTML = "";
  parcels.forEach((p) => {
    const tr = document.createElement("tr");
    tr.className = "parcel-row";
    tr.innerHTML = `<td>${p.section}</td><td>${p.lot_no}</td><td>${p.area_ping ?? ""}</td><td>${p.owner_count}</td><td>${p.land_use ?? ""}</td>`;
    tr.addEventListener("click", () => showParcelDetail(p));
    body.appendChild(tr);
  });
  $("#parcelDetailPanel").classList.add("hidden");
}

let currentDetailParcel = null;

async function showParcelDetail(parcel) {
  currentDetailParcel = parcel;
  $("#parcelDetailPanel").classList.remove("hidden");
  $("#parcelDetailTitle").textContent = `${parcel.section} ${parcel.lot_no} 地號 — 共有人明細`;
  $("#ownerSelectAll").checked = false;
  $("#deleteOwnersStatus").textContent = "";

  const { data: owners } = await sb
    .from("owners")
    .select("*")
    .eq("parcel_id", parcel.id)
    .order("reg_sequence", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  const body = $("#ownerDetailBody");
  body.innerHTML = "";
  (owners || []).forEach((o) => {
    const share = o.share_numerator && o.share_denominator ? `${o.share_numerator}/${o.share_denominator}` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input type="checkbox" class="owner-select" data-id="${o.id}"></td><td>${o.reg_sequence ?? ""}</td><td>${o.name ?? ""}</td><td>${o.address ?? ""}</td><td>${share}</td><td>${o.share_area_ping ?? ""}</td><td>${o.reg_date ?? ""}</td><td>${o.reg_reason ?? ""}</td>`;
    body.appendChild(tr);
  });

  const { data: docs } = await sb
    .from("documents")
    .select("*")
    .eq("parcel_id", parcel.id)
    .order("uploaded_at", { ascending: false });

  const list = $("#documentList");
  list.innerHTML = "";
  for (const doc of docs || []) {
    const { data: signed } = await sb.storage.from("deeds").createSignedUrl(doc.storage_path, 300);
    const li = document.createElement("li");
    const linkHtml = signed?.signedUrl
      ? `<a href="${signed.signedUrl}" target="_blank" rel="noopener">${doc.original_filename}</a>`
      : `${doc.original_filename}（連結產生失敗）`;
    li.innerHTML = `${linkHtml}（上傳於 ${new Date(doc.uploaded_at).toLocaleString("zh-TW")}） <button type="button" class="btn danger btn-delete-doc" style="padding:2px 8px;font-size:0.8rem;">刪除</button>`;
    li.querySelector(".btn-delete-doc").addEventListener("click", async () => {
      const ok = window.confirm(`確定要刪除這份謄本檔案「${doc.original_filename}」嗎？此動作無法復原（不會影響已存的共有人資料）。`);
      if (!ok) return;
      await sb.storage.from("deeds").remove([doc.storage_path]);
      await sb.from("documents").delete().eq("id", doc.id);
      if (currentDetailParcel) await showParcelDetail(currentDetailParcel);
    });
    list.appendChild(li);
  }
}

$("#ownerSelectAll").addEventListener("change", (e) => {
  document.querySelectorAll("#ownerDetailBody .owner-select").forEach((cb) => {
    cb.checked = e.target.checked;
  });
});

// 刪除共有人紀錄：要先勾選、跳確認對話框，避免手滑誤刪，且支援一次勾多筆一起刪
$("#btnDeleteOwners").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll("#ownerDetailBody .owner-select:checked")].map((cb) => cb.dataset.id);
  if (ids.length === 0) {
    $("#deleteOwnersStatus").textContent = "請先勾選要刪除的列";
    return;
  }
  const ok = window.confirm(`確定要刪除這 ${ids.length} 筆共有人紀錄嗎？此動作無法復原。`);
  if (!ok) return;

  $("#deleteOwnersStatus").textContent = "刪除中…";
  const { error } = await sb.from("owners").delete().in("id", ids);
  if (error) {
    $("#deleteOwnersStatus").textContent = "刪除失敗：" + error.message;
    return;
  }
  if (currentDetailParcel) await showParcelDetail(currentDetailParcel);
  await runSearch($("#searchInput").value.trim()); // 讓地號總覽的共有人數同步更新
  $("#deleteOwnersStatus").textContent = `已刪除 ${ids.length} 筆`;
});

// 刪除整個地號：連同底下所有共有人明細、謄本原始檔(含 Storage 檔案)一起清掉，跳確認對話框避免手滑
$("#btnDeleteParcel").addEventListener("click", async () => {
  if (!currentDetailParcel) return;
  const p = currentDetailParcel;
  const ok = window.confirm(
    `確定要刪除「${p.section} ${p.lot_no}」整個地號嗎？\n底下所有共有人紀錄跟謄本原始檔都會一併刪除，此動作無法復原。`
  );
  if (!ok) return;

  $("#deleteParcelStatus").textContent = "刪除中…";
  try {
    const { data: docs } = await sb.from("documents").select("storage_path").eq("parcel_id", p.id);
    const paths = (docs || []).map((d) => d.storage_path);
    if (paths.length > 0) await sb.storage.from("deeds").remove(paths);

    const { error: docsErr } = await sb.from("documents").delete().eq("parcel_id", p.id);
    if (docsErr) throw docsErr;

    // owners 是 on delete cascade，刪 parcels 這一列會自動一起刪掉底下的共有人明細
    const { error: parcelErr } = await sb.from("parcels").delete().eq("id", p.id);
    if (parcelErr) throw parcelErr;

    currentDetailParcel = null;
    $("#parcelDetailPanel").classList.add("hidden");
    await runSearch($("#searchInput").value.trim());
  } catch (err) {
    console.error(err);
    $("#deleteParcelStatus").textContent = "刪除失敗：" + (err.message || err);
  }
});
