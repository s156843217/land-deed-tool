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
let previewState = null; // 目前正在複核中的解析結果 { parcel, owners, file }

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
  $("#pageSearch").classList.toggle("hidden", name !== "search");
  $("#navUpload").classList.toggle("active", name === "upload");
  $("#navSearch").classList.toggle("active", name === "search");
  if (name === "search") refreshSearchPage();
}

$("#navUpload").addEventListener("click", () => showPage("upload"));
$("#navSearch").addEventListener("click", () => showPage("search"));

// ---------- 上傳與解析 ----------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]); // 去掉 data:xxx;base64, 前綴
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$("#btnParse").addEventListener("click", async () => {
  const fileInput = $("#deedFile");
  const file = fileInput.files[0];
  if (!file) {
    $("#parseStatus").textContent = "請先選擇一個檔案";
    return;
  }
  $("#parseStatus").textContent = "解析中，請稍候（謄本共有人多的話可能要一點時間）…";
  $("#btnParse").disabled = true;

  try {
    const base64 = await fileToBase64(file);
    const { data, error } = await sb.functions.invoke("parse-deed", {
      body: { file_base64: base64, mime_type: file.type, filename: file.name },
    });
    if (error) throw error;

    previewState = { parcel: data.parcel, owners: data.owners, file };
    renderPreview();
    $("#parseStatus").textContent = "解析完成，請核對下方內容";
  } catch (err) {
    console.error(err);
    $("#parseStatus").textContent = "解析失敗，請確認檔案格式或稍後再試";
  } finally {
    $("#btnParse").disabled = false;
  }
});

function renderPreview() {
  const { parcel, owners } = previewState;
  $("#previewPanel").classList.remove("hidden");
  $("#pv_section").value = parcel.section ?? "";
  $("#pv_lot_no").value = parcel.lot_no ?? "";
  $("#pv_area_sqm").value = parcel.area_sqm ?? "";
  $("#pv_area_ping").value = parcel.area_ping ?? "";
  $("#pv_land_use").value = parcel.land_use ?? "";
  renderOwnersTable(owners);
}

function renderOwnersTable(owners) {
  const body = $("#pv_owners_body");
  body.innerHTML = "";
  owners.forEach((o, idx) => body.appendChild(ownerRow(o, idx)));
  $("#pv_owner_count").textContent = owners.length;
}

function ownerRow(o, idx) {
  const tr = document.createElement("tr");
  tr.dataset.idx = idx;
  const fields = [
    ["name", o.name], ["address", o.address],
    ["share_numerator", o.share_numerator], ["share_denominator", o.share_denominator],
    ["share_area_sqm", o.share_area_sqm], ["share_area_ping", o.share_area_ping],
    ["reg_date", o.reg_date], ["reg_reason", o.reg_reason], ["reason_date", o.reason_date],
  ];
  tr.innerHTML = fields.map(([key, val]) =>
    `<td><input type="text" data-key="${key}" value="${val ?? ""}" style="width:100%;border:none;"></td>`
  ).join("") + `<td><button class="btn danger btnRemoveOwner" style="padding:4px 8px;">刪除</button></td>`;
  tr.querySelector(".btnRemoveOwner").addEventListener("click", () => {
    previewState.owners.splice(idx, 1);
    renderOwnersTable(previewState.owners);
  });
  return tr;
}

$("#btnAddOwnerRow").addEventListener("click", () => {
  previewState.owners.push({
    name: "", address: "", share_numerator: null, share_denominator: null,
    share_area_sqm: null, share_area_ping: null, reg_date: "", reg_reason: "", reason_date: "",
  });
  renderOwnersTable(previewState.owners);
});

$("#btnCancelPreview").addEventListener("click", () => {
  previewState = null;
  $("#previewPanel").classList.add("hidden");
  $("#parseStatus").textContent = "";
  $("#deedFile").value = "";
});

function collectOwnersFromTable() {
  return [...$("#pv_owners_body").children].map((tr) => {
    const get = (key) => tr.querySelector(`[data-key="${key}"]`).value;
    const num = (v) => (v === "" ? null : Number(v));
    const int = (v) => (v === "" ? null : parseInt(v, 10));
    return {
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

$("#btnConfirmSave").addEventListener("click", async () => {
  $("#saveStatus").textContent = "存檔中…";
  $("#btnConfirmSave").disabled = true;
  try {
    const parcelPayload = {
      section: $("#pv_section").value.trim(),
      lot_no: $("#pv_lot_no").value.trim(),
      area_sqm: $("#pv_area_sqm").value ? Number($("#pv_area_sqm").value) : null,
      area_ping: $("#pv_area_ping").value ? Number($("#pv_area_ping").value) : null,
      land_use: $("#pv_land_use").value.trim() || null,
    };
    if (!parcelPayload.section || !parcelPayload.lot_no) {
      throw new Error("段小段與地號為必填，請確認解析結果");
    }

    // 1) upsert 地號主檔
    const { data: parcelRow, error: parcelErr } = await sb
      .from("parcels")
      .upsert(parcelPayload, { onConflict: "section,lot_no" })
      .select()
      .single();
    if (parcelErr) throw parcelErr;

    // 2) 原始檔上傳到 Storage
    const file = previewState.file;
    const storagePath = `${parcelPayload.section}-${parcelPayload.lot_no}/${Date.now()}-${file.name}`;
    const { error: uploadErr } = await sb.storage.from("deeds").upload(storagePath, file);
    if (uploadErr) throw uploadErr;

    // 3) 建立謄本紀錄
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

    // 4) 寫入共有人明細（複核過的版本，取自表格目前的內容）
    const owners = collectOwnersFromTable().map((o) => ({
      ...o,
      parcel_id: parcelRow.id,
      document_id: docRow.id,
    }));
    if (owners.length > 0) {
      const { error: ownersErr } = await sb.from("owners").insert(owners);
      if (ownersErr) throw ownersErr;
    }

    $("#saveStatus").textContent = "已存入總表";
    previewState = null;
    $("#previewPanel").classList.add("hidden");
    $("#deedFile").value = "";
    $("#parseStatus").textContent = "";
  } catch (err) {
    console.error(err);
    $("#saveStatus").textContent = "存檔失敗：" + (err.message || err);
  } finally {
    $("#btnConfirmSave").disabled = false;
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

async function showParcelDetail(parcel) {
  $("#parcelDetailPanel").classList.remove("hidden");
  $("#parcelDetailTitle").textContent = `${parcel.section} ${parcel.lot_no} 地號 — 共有人明細`;

  const { data: owners } = await sb
    .from("owners")
    .select("*")
    .eq("parcel_id", parcel.id)
    .order("created_at", { ascending: true });

  const body = $("#ownerDetailBody");
  body.innerHTML = "";
  (owners || []).forEach((o) => {
    const share = o.share_numerator && o.share_denominator ? `${o.share_numerator}/${o.share_denominator}` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${o.name ?? ""}</td><td>${o.address ?? ""}</td><td>${share}</td><td>${o.share_area_ping ?? ""}</td><td>${o.reg_date ?? ""}</td><td>${o.reg_reason ?? ""}</td>`;
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
    if (signed?.signedUrl) {
      li.innerHTML = `<a href="${signed.signedUrl}" target="_blank" rel="noopener">${doc.original_filename}</a>（上傳於 ${new Date(doc.uploaded_at).toLocaleString("zh-TW")}）`;
    } else {
      li.textContent = `${doc.original_filename}（連結產生失敗）`;
    }
    list.appendChild(li);
  }
}
