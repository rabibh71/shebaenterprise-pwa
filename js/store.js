import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

import {
  loadStoreCloudData,
  saveStoreCloudData,

} from "./store-cloud.js";

import {
  upsertHishabSyncEntry,
  deleteHishabSyncEntry
} from "./hishab-bridge.js";

import {
  addSyncTask,
  isAppOnline
} from "./offline-queue.js";

import { flushStoreQueue } from "./store-sync.js";

/* =========================
   CONFIG
========================= */

const LOCAL_KEY_BASE = "sheba_store_v_supabase_v1";
let LOCAL_KEY = `${LOCAL_KEY_BASE}_default`;

function getStoreLocalKeyIdentity(value) {
  return String(value || "default_user")
    .toLowerCase()
    .replace(/[.#$/\[\]@]/g, "_");
}




function buildStoreKey(identity) {
  return `${LOCAL_KEY_BASE}_${getStoreLocalKeyIdentity(identity)}`;
}

function readStoreLocalPayload(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function isValidStorePayload(data) {
  return !!(
    data &&
    typeof data === "object" &&
    Array.isArray(data.products) &&
    Array.isArray(data.salesDocs) &&
    Array.isArray(data.purchaseDocs)
  );
}

function migrateStoreLocalData(targetKey, identities = []) {
  const candidateKeys = [
    targetKey,
    LOCAL_KEY_BASE,
    ...identities.filter(Boolean).map((item) => buildStoreKey(item))
  ];

  const uniqueKeys = [...new Set(candidateKeys)];

  let foundKey = "";
  let foundData = null;

  for (const key of uniqueKeys) {
    const data = readStoreLocalPayload(key);
    if (isValidStorePayload(data)) {
      foundKey = key;
      foundData = data;
      break;
    }
  }

  if (!foundData) return;

  if (foundKey !== targetKey) {
    localStorage.setItem(targetKey, JSON.stringify(foundData));
  }

  if (localStorage.getItem(LOCAL_KEY_BASE)) {
    localStorage.removeItem(LOCAL_KEY_BASE);
  }
}



async function resolveStoreLocalKey() {
  let authUser = null;
  let localUser = null;

  try {
    const { user } = await getCurrentUser();
    authUser = user || null;
  } catch {
    authUser = null;
  }

  try {
    localUser = JSON.parse(localStorage.getItem("loggedInUser") || "null");
  } catch {
    localUser = null;
  }

  const primaryIdentity =
    authUser?.email ||
    localUser?.email ||
    localUser?.username ||
    "default_user";

  LOCAL_KEY = buildStoreKey(primaryIdentity);

  migrateStoreLocalData(LOCAL_KEY, [
    authUser?.email,
    localUser?.email,
    localUser?.username
  ]);
}



const STORE_IMAGE_BUCKET = "notes_module_media";

const state = {
  products: [],
  salesDocs: [],
  purchaseDocs: [],
  stockMoves: [],
  activities: [],
  returns: [],
  activeTab: "parts",
  editingProductId: null,
  productImageData: "",
  paymentContext: null
};

const PAYMENT_METHODS = ["Cash", "bKash", "Nagad", "Rocket", "Upay", "Bank", "Card"];

/* =========================
   DOM HELPERS
========================= */
const el = (id) => document.getElementById(id);

function hasEl(id) {
  return !!document.getElementById(id);
}

function getVal(id, fallback = "") {
  const node = el(id);
  return node ? node.value : fallback;
}

function setVal(id, value) {
  const node = el(id);
  if (node) node.value = value;
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function setHtml(id, value) {
  const node = el(id);
  if (node) node.innerHTML = value;
}

function show(id) {
  const node = el(id);
  if (node) node.classList.remove("hidden");
}

function hide(id) {
  const node = el(id);
  if (node) node.classList.add("hidden");
}

/* =========================
   GENERAL HELPERS
========================= */
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatMoney(value) {
  return "৳" + safeNumber(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function sanitizePaymentSplit(split = {}) {
  const clean = {};
  Object.entries(split || {}).forEach(([method, amount]) => {
    const num = safeNumber(amount);
    if (num > 0) clean[method] = num;
  });
  return clean;
}

function sumPaymentSplit(split = {}) {
  return Object.values(split || {}).reduce((sum, value) => sum + safeNumber(value), 0);
}

/* =========================
   PAYMENT SPLIT HELPERS
========================= */
function getPaymentSplitInputMap() {
  return {
    Cash: el("paymentSplitCash"),
    bKash: el("paymentSplitBkash"),
    Nagad: el("paymentSplitNagad"),
    Rocket: el("paymentSplitRocket"),
    Upay: el("paymentSplitUpay"),
    Bank: el("paymentSplitBank"),
    Card: el("paymentSplitCard")
  };
}

function clearPaymentSplitInputs() {
  const map = getPaymentSplitInputMap();
  PAYMENT_METHODS.forEach((method) => {
    if (map[method]) map[method].value = 0;
  });
}

function readPaymentSplitValues() {
  const map = getPaymentSplitInputMap();
  const data = {};

  PAYMENT_METHODS.forEach((method) => {
    data[method] = safeNumber(map[method]?.value || 0);
  });

  return sanitizePaymentSplit(data);
}

function writePaymentSplitValues(split = {}) {
  const map = getPaymentSplitInputMap();

  PAYMENT_METHODS.forEach((method) => {
    if (map[method]) {
      map[method].value = safeNumber(split[method] || 0);
    }
  });
}

function updatePaymentSplitPreview() {
  const total = sumPaymentSplit(readPaymentSplitValues());
  setText("paymentSplitTotal", formatMoney(total));
}

function togglePaymentMethodFields() {
  const method = getVal("paymentMethod", "Cash");
  const wrap = el("paymentMixedWrap");
  if (!wrap) return;

  wrap.classList.toggle("hidden", method !== "Mixed");
  updatePaymentSplitPreview();
}

/* ===== Scoped split helpers for Sales/Purchase builders ===== */
function getScopedSplitInputMap(scope) {
  return {
    Cash: el(`${scope}SplitCash`),
    bKash: el(`${scope}SplitBkash`),
    Nagad: el(`${scope}SplitNagad`),
    Rocket: el(`${scope}SplitRocket`),
    Upay: el(`${scope}SplitUpay`),
    Bank: el(`${scope}SplitBank`),
    Card: el(`${scope}SplitCard`)
  };
}

function clearScopedSplitInputs(scope) {
  const map = getScopedSplitInputMap(scope);
  PAYMENT_METHODS.forEach((method) => {
    if (map[method]) map[method].value = 0;
  });
}

function readScopedSplitValues(scope) {
  const map = getScopedSplitInputMap(scope);
  const data = {};

  PAYMENT_METHODS.forEach((method) => {
    data[method] = safeNumber(map[method]?.value || 0);
  });

  return sanitizePaymentSplit(data);
}

function writeScopedSplitValues(scope, split = {}) {
  const map = getScopedSplitInputMap(scope);

  PAYMENT_METHODS.forEach((method) => {
    if (map[method]) {
      map[method].value = safeNumber(split[method] || 0);
    }
  });
}

function updateScopedSplitPreview(scope, totalId) {
  const total = sumPaymentSplit(readScopedSplitValues(scope));
  setText(totalId, formatMoney(total));
}

/* ===== Sales Builder Initial Payment ===== */
function toggleSalePaymentFields() {
  const method = getVal("salePaymentMethod", "Cash");
  const wrap = el("saleMixedWrap");
  if (!wrap) return;

  wrap.classList.toggle("hidden", method !== "Mixed");
  updateSaleSplitPreviewFromInputs();
}

function updateSaleSplitPreviewFromInputs() {
  updateScopedSplitPreview("sale", "saleSplitTotal");
}

function syncSaleAmountFromSplit() {
  if (getVal("salePaymentMethod") !== "Mixed") return;
  const total = sumPaymentSplit(readScopedSplitValues("sale"));
  setVal("salePaid", total);
  updateSalesTotals();
}

/* ===== Purchase Builder Initial Payment ===== */
function togglePurchasePaymentFields() {
  const method = getVal("purchasePaymentMethod", "Cash");
  const wrap = el("purchaseMixedWrap");
  if (!wrap) return;

  wrap.classList.toggle("hidden", method !== "Mixed");
  updatePurchaseSplitPreviewFromInputs();
}

function updatePurchaseSplitPreviewFromInputs() {
  updateScopedSplitPreview("purchase", "purchaseSplitTotal");
}

function syncPurchaseAmountFromSplit() {
  if (getVal("purchasePaymentMethod") !== "Mixed") return;
  const total = sumPaymentSplit(readScopedSplitValues("purchase"));
  setVal("purchasePaid", total);
}

/* =========================
   MODAL HELPERS
========================= */
function syncModalOpenState() {
  const modalIds = ["productModal", "productDetailModal", "paymentModal"];
  const anyOpen = modalIds.some((id) => el(id)?.classList.contains("show"));

  document.documentElement.classList.toggle("modal-open", anyOpen);
  document.body.classList.toggle("modal-open", anyOpen);
}

function openModalById(id) {
  el(id)?.classList.add("show");
  syncModalOpenState();
}

function closeModalById(id) {
  el(id)?.classList.remove("show");
  syncModalOpenState();
}

/* =========================
   HISHAB SYNC HELPERS
========================= */
async function getAuthUserId() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }

  return user.id;
}

function inferPaymentMethod(paid, due) {
  const paidNum = safeNumber(paid);
  const dueNum = safeNumber(due);

  if (paidNum > 0 && dueNum > 0) return "Mixed";
  if (paidNum > 0 && dueNum <= 0) return "Cash";
  return "Due";
}

function summarizeSaleItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return "Store sale";

  const names = list.slice(0, 3).map((i) => `${i.productName} x ${safeNumber(i.qty)}`);
  const extra = list.length > 3 ? ` +${list.length - 3} more` : "";
  return names.join(", ") + extra;
}

function makeStoreSaleHisabPayload(docObj) {
  return {
    module_name: "store",
    entry_type: "income",
    source_table: "store_sale",
    source_id: docObj.id,
    entry_date: docObj.date || todayStr(),
    party_name: docObj.customerName || docObj.customerPhone || "Store Customer",
    category: "Store Sale",
    total_amount: safeNumber(docObj.grandTotal),
    paid_amount: safeNumber(docObj.paid),
    due_amount: safeNumber(docObj.due),
    payment_method: inferPaymentMethod(docObj.paid, docObj.due),
    note: `${docObj.docNo || ""} | ${summarizeSaleItems(docObj.items)}${docObj.note ? ` | ${docObj.note}` : ""}`
  };
}

function makeStorePurchaseHisabPayload(docObj) {
  return {
    module_name: "store",
    entry_type: "expense",
    source_table: "store_purchase",
    source_id: docObj.id,
    entry_date: docObj.date || todayStr(),
    party_name: docObj.supplierName || docObj.supplierPhone || "Store Supplier",
    category: "Store Purchase",
    total_amount: safeNumber(docObj.total),
    paid_amount: safeNumber(docObj.paid),
    due_amount: safeNumber(docObj.due),
    payment_method: inferPaymentMethod(docObj.paid, docObj.due),
    note: `${docObj.docNo || ""} | ${docObj.productName || "Product"} x ${safeNumber(docObj.qty)}${docObj.note ? ` | ${docObj.note}` : ""}`
  };
}

async function syncStoreSaleToHishab(docObj) {
  if (!docObj || !isAppOnline()) return;
  if (docObj.type !== "invoice") return;

  try {
    await upsertHishabSyncEntry(makeStoreSaleHisabPayload(docObj));
  } catch (err) {
    console.error("Store sale -> hishab sync failed:", err);
  }
}

async function syncStorePurchaseToHishab(docObj) {
  if (!docObj || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeStorePurchaseHisabPayload(docObj));
  } catch (err) {
    console.error("Store purchase -> hishab sync failed:", err);
  }
}

async function removeStoreSaleFromHishab(docId) {
  if (!docId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("store_sale", docId);
  } catch (err) {
    console.error("Store sale -> hishab delete failed:", err);
  }
}

async function removeStorePurchaseFromHishab(docId) {
  if (!docId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("store_purchase", docId);
  } catch (err) {
    console.error("Store purchase -> hishab delete failed:", err);
  }
}

async function clearStoreHisabMirror() {
  if (!isAppOnline()) return;

  try {
    const userId = await getAuthUserId();

    const { error } = await supabase
      .from("hisab_entries")
      .delete()
      .eq("user_id", userId)
      .in("source_table", ["store_sale", "store_purchase"]);

    if (error) throw error;
  } catch (err) {
    console.error("Clear store hishab mirror failed:", err);
  }
}

async function rebuildStoreHisabMirror() {
  if (!isAppOnline()) return;

  try {
    await clearStoreHisabMirror();

    for (const docObj of state.salesDocs) {
      if (docObj.type === "invoice") {
        await syncStoreSaleToHishab(docObj);
      }
    }

    for (const docObj of state.purchaseDocs) {
      await syncStorePurchaseToHishab(docObj);
    }
  } catch (err) {
    console.error("Store hishab rebuild failed:", err);
  }
}

/* =========================
   MONEY COLOR HELPERS
========================= */
function clearMoneyClasses(node) {
  if (!node) return;
  node.classList.remove(
    "income-color",
    "expense-color",
    "profit-color",
    "loss-color",
    "money-green",
    "money-red",
    "money-yellow",
    "sale-color",
    "paid-color",
    "due-color",
    "purchase-color"
  );
}

function moneyColor(type, value = 0) {
  const t = String(type || "").toLowerCase();

  if (
    t === "income" ||
    t === "sale" ||
    t === "sales" ||
    t === "paid" ||
    t === "sell" ||
    t === "profit"
  ) {
    return "#22c55e";
  }

  if (
    t === "due" ||
    t === "receivable" ||
    t === "payable"
  ) {
    return "#ffd86f";
  }

  if (
    t === "expense" ||
    t === "purchase" ||
    t === "loss" ||
    t === "buy"
  ) {
    return "#ef4444";
  }

  return Number(value) >= 0 ? "#22c55e" : "#ef4444";
}

function moneyStyle(type, value = 0) {
  return `style="color:${moneyColor(type, value)} !important;"`;
}

function setMoneyColor(node, type, value = 0) {
  if (!node) return;

  clearMoneyClasses(node);
  node.style.removeProperty("color");

  const color = moneyColor(type, value);
  node.style.setProperty("color", color, "important");

  if (color === "#22c55e") {
    node.classList.add(
      String(type).toLowerCase() === "profitloss" || String(type).toLowerCase() === "loss"
        ? "profit-color"
        : "income-color"
    );
  } else if (color === "#ffd86f") {
    node.classList.add("due-color");
  } else {
    node.classList.add(
      String(type).toLowerCase() === "profitloss" || String(type).toLowerCase() === "profit"
        ? "loss-color"
        : "expense-color"
    );
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date(todayStr() + "T00:00:00");
  const d = new Date(dateStr + "T00:00:00");
  return Math.round((d - now) / 86400000);
}

function addActivity(message) {
  state.activities.unshift({
    id: uid("log"),
    time: new Date().toLocaleString(),
    message
  });
  state.activities = state.activities.slice(0, 60);
}

function generateDocNo(prefix) {
  return `${prefix}-${String(Date.now()).slice(-6)}`;
}

function getCustomerKey(name, phone) {
  const phoneKey = String(phone || "").replace(/\D/g, "");
  return phoneKey || String(name || "").trim().toLowerCase();
}

function getSupplierKey(name, phone) {
  const phoneKey = String(phone || "").replace(/\D/g, "");
  return phoneKey || String(name || "").trim().toLowerCase();
}

function getLocationText(product) {
  return [product.room, product.rack, product.shelf, product.cell].filter(Boolean).join(" • ");
}

function buildProductVariantText(productLike = {}) {
  const parts = [
    productLike.name,
    productLike.category,
    productLike.brand,
    productLike.condition,
    productLike.country,
    productLike.code
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  return parts.length
    ? parts.join(" • ")
    : "পার্টসের নাম, condition, country, brand, code অনুযায়ী preview এখানে দেখাবে";
}

function updateProductVariantPreview() {
  const preview = el("productVariantPreview");
  if (!preview) return;

  const text = buildProductVariantText({
    name: getVal("productName"),
    category: getVal("productCategory"),
    brand: getVal("productBrand"),
    condition: getVal("productCondition"),
    country: getVal("productCountry"),
    code: getVal("productCode")
  });

  preview.textContent = text;
}

function openPopup(title, html) {
  const win = window.open("", "_blank");
  if (!win) {
    alert("Popup blocked হয়েছে");
    return;
  }

  win.document.open();
  win.document.write(`
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          body{font-family:Arial,sans-serif;padding:18px;color:#111;line-height:1.5}
          h1,h2,h3,p{margin:0 0 8px}
          table{width:100%;border-collapse:collapse;margin-top:12px}
          th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px;vertical-align:top}
          .card{border:1px solid #ddd;padding:12px;border-radius:10px;margin-top:10px}
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  win.document.close();
}

/* =========================
   IMAGE (SUPABASE STORAGE)
========================= */
function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function compressImage(file, maxWidth = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;

        if (w > maxWidth) {
          h = (maxWidth / w) * h;
          w = maxWidth;
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl || "").split(",");
  if (parts.length < 2) throw new Error("Invalid image data");

  const meta = parts[0];
  const base64 = parts[1];
  const mimeMatch = meta.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

function getExtensionFromMime(mime = "") {
  const m = String(mime).toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg")) return "jpg";
  return "jpg";
}

function extractSupabasePathFromUrl(url) {
  try {
    const parsed = new URL(url);
    const markers = [
      `/storage/v1/object/public/${STORE_IMAGE_BUCKET}/`,
      `/storage/v1/object/sign/${STORE_IMAGE_BUCKET}/`,
      `/storage/v1/object/authenticated/${STORE_IMAGE_BUCKET}/`
    ];

    for (const marker of markers) {
      const idx = parsed.pathname.indexOf(marker);
      if (idx !== -1) {
        return decodeURIComponent(parsed.pathname.slice(idx + marker.length));
      }
    }

    return "";
  } catch {
    return "";
  }
}

async function createSignedImageUrl(path, expiresIn = 60 * 60 * 24 * 30) {
  if (!path) return "";

  const { data, error } = await supabase.storage
    .from(STORE_IMAGE_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error) throw error;
  return data?.signedUrl || "";
}

async function uploadImageDataUrl(dataUrl, folder = "products") {
  if (!dataUrl) return "";

  const blob = dataUrlToBlob(dataUrl);
  const ext = getExtensionFromMime(blob.type);
  const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage
    .from(STORE_IMAGE_BUCKET)
    .upload(path, blob, {
      contentType: blob.type,
      upsert: false
    });

  if (error) throw error;

  return path;
}

async function deleteImageByPath(pathOrUrl) {
  if (!pathOrUrl) return;

  const path = isHttpUrl(pathOrUrl)
    ? extractSupabasePathFromUrl(pathOrUrl)
    : pathOrUrl;

  if (!path) return;

  const { error } = await supabase.storage
    .from(STORE_IMAGE_BUCKET)
    .remove([path]);

  if (error) {
    console.warn("Image delete skipped:", error);
  }
}

async function refreshProductSignedUrls() {
  for (const product of state.products) {
    if (!product.image) {
      product.imageSignedUrl = "";
      continue;
    }

    const path = isHttpUrl(product.image)
      ? extractSupabasePathFromUrl(product.image)
      : product.image;

    product.image = path;

    try {
      product.imageSignedUrl = await createSignedImageUrl(path);
    } catch (err) {
      console.warn("Signed URL refresh failed:", err);
      product.imageSignedUrl = "";
    }
  }
}


function getStorePayload() {
  return {
    products: state.products,
    salesDocs: state.salesDocs,
    purchaseDocs: state.purchaseDocs,
    stockMoves: state.stockMoves,
    activities: state.activities,
    returns: state.returns
  };
}

function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(getStorePayload()));
}

async function saveCloud() {
  await saveStoreCloudData(getStorePayload());
}

function queueStoreSave() {
  addSyncTask({
    module: "store",
    action: "save_full_state",
    payload: getStorePayload()
  });
}

function saveAll() {
  saveLocal();

  if (!isAppOnline()) {
    queueStoreSave();
    return;
  }

  saveCloud().catch((err) => {
    console.error("Cloud save failed:", err);
    queueStoreSave();
  });
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return;

    const data = JSON.parse(raw);
    state.products = Array.isArray(data.products) ? data.products : [];
    state.salesDocs = Array.isArray(data.salesDocs) ? data.salesDocs : [];
    state.purchaseDocs = Array.isArray(data.purchaseDocs) ? data.purchaseDocs : [];
    state.stockMoves = Array.isArray(data.stockMoves) ? data.stockMoves : [];
    state.activities = Array.isArray(data.activities) ? data.activities : [];
    state.returns = Array.isArray(data.returns) ? data.returns : [];
  } catch (err) {
    console.error(err);
  }
}



function normalizeLoadedData() {
  state.products.forEach((p) => {
    p.buyPrice = safeNumber(p.buyPrice);
    p.sellPrice = safeNumber(p.sellPrice);
    p.stock = safeNumber(p.stock);
    p.lowStock = safeNumber(p.lowStock || 5);
    if (!p.imageSignedUrl) p.imageSignedUrl = "";
  });

  state.salesDocs.forEach(recalcSaleDoc);
  state.purchaseDocs.forEach(recalcPurchaseDoc);
}
async function loadCloud() {
  try {
    const data = await loadStoreCloudData();
    if (!data) return;

    if (Array.isArray(data.products) && data.products.length) {
      state.products = data.products;
    }

    if (Array.isArray(data.salesDocs) && data.salesDocs.length) {
      state.salesDocs = data.salesDocs;
    }

    if (Array.isArray(data.purchaseDocs) && data.purchaseDocs.length) {
      state.purchaseDocs = data.purchaseDocs;
    }

    if (Array.isArray(data.stockMoves) && data.stockMoves.length) {
      state.stockMoves = data.stockMoves;
    }

    if (Array.isArray(data.activities) && data.activities.length) {
      state.activities = data.activities;
    }

    if (Array.isArray(data.returns) && data.returns.length) {
      state.returns = data.returns;
    }
  } catch (err) {
    console.error("Cloud load failed:", err);
  }
}

/* =========================
   MODELS
========================= */
function recalcSaleDoc(docObj) {
  docObj.items = Array.isArray(docObj.items) ? docObj.items : [];
  docObj.payments = Array.isArray(docObj.payments) ? docObj.payments : [];

  docObj.items = docObj.items.map((item) => {
    const qty = safeNumber(item.qty);
    const unitPrice = safeNumber(item.unitPrice);
    const discount = safeNumber(item.discount);
    return {
      ...item,
      qty,
      unitPrice,
      discount,
      total: Math.max(0, qty * unitPrice - discount),
      buyPrice: safeNumber(item.buyPrice)
    };
  });

  docObj.subtotal = docObj.items.reduce((sum, item) => sum + safeNumber(item.total), 0);
  docObj.discount = safeNumber(docObj.discount);
  docObj.grandTotal = Math.max(0, docObj.subtotal - docObj.discount);
  docObj.paid = docObj.payments.reduce((sum, p) => sum + safeNumber(p.amount), 0);
  docObj.due = Math.max(0, docObj.grandTotal - docObj.paid);

  if (docObj.type === "quotation") {
    docObj.status = "Quotation";
  } else if (docObj.due <= 0) {
    docObj.status = "Paid";
  } else {
    const diff = daysUntil(docObj.dueDate || "");
    if (diff === null) docObj.status = docObj.paid > 0 ? "Partial" : "Due";
    else if (diff < 0) docObj.status = "Overdue";
    else if (diff === 0) docObj.status = "Due Today";
    else if (diff <= 3) docObj.status = "Upcoming";
    else docObj.status = docObj.paid > 0 ? "Partial" : "Due";
  }

  return docObj;
}

function recalcPurchaseDoc(docObj) {
  docObj.payments = Array.isArray(docObj.payments) ? docObj.payments : [];
  docObj.qty = safeNumber(docObj.qty);
  docObj.unitCost = safeNumber(docObj.unitCost);
  docObj.total = safeNumber(docObj.qty) * safeNumber(docObj.unitCost);
  docObj.paid = docObj.payments.reduce((sum, p) => sum + safeNumber(p.amount), 0);
  docObj.due = Math.max(0, docObj.total - docObj.paid);

  if (docObj.due <= 0) {
    docObj.status = "Paid";
  } else {
    const diff = daysUntil(docObj.dueDate || "");
    if (diff === null) docObj.status = "Due";
    else if (diff < 0) docObj.status = "Overdue";
    else if (diff === 0) docObj.status = "Due Today";
    else if (diff <= 3) docObj.status = "Upcoming";
    else docObj.status = "Due";
  }

  return docObj;
}

/* =========================
   LOOKUPS
========================= */
function getProduct(productId) {
  return state.products.find((p) => p.id === productId);
}

function getSaleDoc(docId) {
  return state.salesDocs.find((d) => d.id === docId);
}

function getPurchaseDoc(docId) {
  return state.purchaseDocs.find((d) => d.id === docId);
}

function getSalesForProduct(productId) {
  const out = [];
  state.salesDocs.forEach((docObj) => {
    if (docObj.type !== "invoice") return;
    docObj.items.forEach((item) => {
      if (item.productId === productId) {
        out.push({
          date: docObj.date,
          docNo: docObj.docNo,
          customer: docObj.customerName,
          qty: item.qty,
          total: item.total,
          unitPrice: item.unitPrice
        });
      }
    });
  });

  return out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function getReturnedQty(docId, productId) {
  return state.returns
    .filter((r) => r.docId === docId && r.productId === productId)
    .reduce((sum, r) => sum + safeNumber(r.qty), 0);
}

/* =========================
   TABS
========================= */
function switchTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.remove("active");
  });

  const target = el(`tab-${tab}`);
  if (target) target.classList.add("active");

  if (tab === "dues") renderDueLists();
  if (tab === "reports") renderReports();
}

/* =========================
   SUMMARY / FILTERS
========================= */
function updateSummary() {
  const totalProducts = state.products.length;
  const totalStock = state.products.reduce((sum, p) => sum + safeNumber(p.stock), 0);
  const stockValue = state.products.reduce((sum, p) => sum + safeNumber(p.stock) * safeNumber(p.buyPrice), 0);
  const totalSales = state.salesDocs
    .filter((d) => d.type === "invoice")
    .reduce((sum, d) => sum + safeNumber(d.grandTotal), 0);
  const totalCustomerDue = state.salesDocs
    .filter((d) => d.type === "invoice")
    .reduce((sum, d) => sum + safeNumber(d.due), 0);
  const totalSupplierDue = state.purchaseDocs.reduce((sum, d) => sum + safeNumber(d.due), 0);

  setText("sumProducts", totalProducts);
  setText("sumStock", totalStock.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  setText("sumStockValue", formatMoney(stockValue));
  setText("sumSales", formatMoney(totalSales));
  setText("sumCustomerDue", formatMoney(totalCustomerDue));
  setText("sumSupplierDue", formatMoney(totalSupplierDue));
  setText("productCountText", totalProducts);

  setMoneyColor(el("sumStockValue"), "income");
  setMoneyColor(el("sumSales"), "income");
  setMoneyColor(el("sumCustomerDue"), "due");
  setMoneyColor(el("sumSupplierDue"), "due");
}

function renderCategoryFilter() {
  if (!hasEl("categoryFilter")) return;

  const select = el("categoryFilter");
  const current = select.value;
  const categories = [...new Set(state.products.map((p) => String(p.category || "").trim()).filter(Boolean))].sort();

  select.innerHTML =
    `<option value="">সব ক্যাটাগরি</option>` +
    categories.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join("");

  if (categories.includes(current)) {
    select.value = current;
  }
}

function renderWarnings() {
  const lowStock = state.products.filter((p) => safeNumber(p.stock) <= safeNumber(p.lowStock || 5));
  const overdueSales = state.salesDocs.filter((d) => d.type === "invoice" && d.status === "Overdue");
  const overduePurchases = state.purchaseDocs.filter((d) => d.status === "Overdue");

  const warnings = [];
  if (lowStock.length) {
    warnings.push("Low stock: " + lowStock.slice(0, 5).map((p) => `${p.name} (${p.stock})`).join(", "));
  }
  if (overdueSales.length) {
    warnings.push(`Overdue customer invoice: ${overdueSales.length} টি`);
  }
  if (overduePurchases.length) {
    warnings.push(`Overdue supplier due: ${overduePurchases.length} টি`);
  }

  if (!warnings.length) {
    hide("warningCard");
    return;
  }

  setHtml(
    "warningList",
    warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join("")
  );
  show("warningCard");
}

function renderPurchaseProductOptions() {
  if (!hasEl("purchaseProduct")) return;

  const select = el("purchaseProduct");
  const current = select.value;

  select.innerHTML =
    `<option value="">Product select</option>` +
    state.products.map((p) => `
      <option value="${p.id}">
        ${escapeHtml(p.name)} | Stock: ${safeNumber(p.stock).toLocaleString("en-US", { maximumFractionDigits: 2 })}
      </option>
    `).join("");

  if (state.products.some((p) => p.id === current)) {
    select.value = current;
  }
}

/* =========================
   PRODUCT IMAGE
========================= */
async function handleProductImage(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    state.productImageData = await compressImage(file);
    const preview = el("productImagePreview");
    if (preview) {
      preview.src = state.productImageData;
      preview.classList.remove("hidden");
    }
  } catch {
    alert("ছবি load করা যায়নি");
  }
}

function removeProductImage() {
  state.productImageData = "";
  if (hasEl("productImageInput")) el("productImageInput").value = "";

  const preview = el("productImagePreview");
  if (preview) {
    preview.src = "";
    preview.classList.add("hidden");
  }
}

/* =========================
   PRODUCT FORM
========================= */
function openProductForm(productId = null) {
  state.editingProductId = productId;
  state.productImageData = "";

  openModalById("productModal");

  setText("productModalTitle", productId ? "পার্টস এডিট" : "নতুন পার্টস");

  if (!productId) {
    [
      "productName","productCategory","productBrand","productCondition","productCountry",
      "productUnit","productBuyPrice","productSellPrice","productStock","productLowStock",
      "productSupplier","productCode","productBarcode","productRoom","productRack",
      "productShelf","productCell","productDetails"
    ].forEach((id) => setVal(id, ""));

    setVal("productLowStock", 5);
    removeProductImage();
    updateProductVariantPreview();
    return;
  }

  const product = getProduct(productId);
  if (!product) return;

  setVal("productName", product.name || "");
  setVal("productCategory", product.category || "");
  setVal("productBrand", product.brand || "");
  setVal("productCondition", product.condition || "");
  setVal("productCountry", product.country || "");
  setVal("productUnit", product.unit || "");
  setVal("productBuyPrice", safeNumber(product.buyPrice));
  setVal("productSellPrice", safeNumber(product.sellPrice));
  setVal("productStock", safeNumber(product.stock));
  setVal("productLowStock", safeNumber(product.lowStock || 5));
  setVal("productSupplier", product.supplier || "");
  setVal("productCode", product.code || "");
  setVal("productBarcode", product.barcode || "");
  setVal("productRoom", product.room || "");
  setVal("productRack", product.rack || "");
  setVal("productShelf", product.shelf || "");
  setVal("productCell", product.cell || "");
  setVal("productDetails", product.details || "");

  state.productImageData = product.image || "";

  const preview = el("productImagePreview");
  if (preview) {
    if (product.imageSignedUrl) {
      preview.src = product.imageSignedUrl;
      preview.classList.remove("hidden");
    } else {
      preview.src = "";
      preview.classList.add("hidden");
    }
  }

  updateProductVariantPreview();
}

function closeProductForm() {
  closeModalById("productModal");
  state.editingProductId = null;
  state.productImageData = "";
}

async function saveProduct() {
  const name = getVal("productName").trim();
  if (!name) return alert("পার্টসের নাম দিন");

  const payload = {
    name,
    category: getVal("productCategory").trim(),
    brand: getVal("productBrand").trim(),
    condition: getVal("productCondition"),
    country: getVal("productCountry"),
    unit: getVal("productUnit").trim(),
    buyPrice: safeNumber(getVal("productBuyPrice")),
    sellPrice: safeNumber(getVal("productSellPrice")),
    stock: safeNumber(getVal("productStock")),
    lowStock: safeNumber(getVal("productLowStock") || 5),
    supplier: getVal("productSupplier").trim(),
    code: getVal("productCode").trim(),
    barcode: getVal("productBarcode").trim(),
    room: getVal("productRoom").trim(),
    rack: getVal("productRack").trim(),
    shelf: getVal("productShelf").trim(),
    cell: getVal("productCell").trim(),
    details: getVal("productDetails").trim(),
    updatedAt: new Date().toISOString()
  };

  try {
    let finalImage = "";
    let finalSignedUrl = "";

    if (state.editingProductId) {
      const product = getProduct(state.editingProductId);
      if (!product) return;

      finalImage = product.image || "";
      finalSignedUrl = product.imageSignedUrl || "";

      if (state.productImageData) {
        if (state.productImageData.startsWith("data:image/")) {
          if (product.image) await deleteImageByPath(product.image);
          finalImage = await uploadImageDataUrl(state.productImageData, "products");
          finalSignedUrl = await createSignedImageUrl(finalImage);
        } else {
          finalImage = state.productImageData;
          finalSignedUrl = finalImage ? await createSignedImageUrl(finalImage) : "";
        }
      } else {
        if (product.image) await deleteImageByPath(product.image);
        finalImage = "";
        finalSignedUrl = "";
      }

      Object.assign(product, payload, {
        image: finalImage,
        imageSignedUrl: finalSignedUrl
      });

      addActivity(`Product updated: ${product.name}`);
    } else {
      if (state.productImageData && state.productImageData.startsWith("data:image/")) {
        finalImage = await uploadImageDataUrl(state.productImageData, "products");
        finalSignedUrl = await createSignedImageUrl(finalImage);
      }

      state.products.unshift({
        id: uid("prod"),
        createdAt: new Date().toISOString(),
        image: finalImage,
        imageSignedUrl: finalSignedUrl,
        ...payload
      });

      addActivity(`New product added: ${name}`);
    }

    saveAll();
    renderAll();
    closeProductForm();
  } catch (err) {
    console.error(err);
    alert("Product save করতে সমস্যা হয়েছে");
  }
}

async function deleteProduct(productId) {
  const product = getProduct(productId);
  if (!product) return;

  const usedInSales = state.salesDocs.some((docObj) =>
    docObj.items.some((item) => item.productId === productId)
  );
  const usedInPurchases = state.purchaseDocs.some((docObj) => docObj.productId === productId);

  if (usedInSales || usedInPurchases) {
    return alert("এই পার্টস sales/purchase-এ ব্যবহার হয়েছে, তাই delete করা যাবে না");
  }

  if (!confirm("এই পার্টস delete করবেন?")) return;

  try {
    if (product.image) await deleteImageByPath(product.image);
    state.products = state.products.filter((p) => p.id !== productId);
    addActivity(`Product deleted: ${product.name}`);
    saveAll();
    renderAll();
  } catch (err) {
    console.error(err);
    alert("Delete করতে সমস্যা হয়েছে");
  }
}

/* =========================
   PRODUCT DETAIL
========================= */
function openProductDetail(productId) {
  const product = getProduct(productId);
  if (!product) return;

  const recentSales = getSalesForProduct(productId);
  const totalSold = recentSales.reduce((sum, s) => sum + safeNumber(s.qty), 0);
  const approxProfit = recentSales.reduce(
    (sum, s) => sum + ((safeNumber(s.unitPrice) - safeNumber(product.buyPrice)) * safeNumber(s.qty)),
    0
  );

  setHtml("productDetailContent", `
    ${product.imageSignedUrl
      ? `<img class="detail-image" src="${product.imageSignedUrl}" alt="${escapeHtml(product.name)}">`
      : `<div class="detail-image" style="display:flex;align-items:center;justify-content:center;font-size:64px;">🚗</div>`
    }

    <div class="panel-title" style="margin-bottom:6px;">${escapeHtml(product.name)}</div>

    <div class="badge-row" style="margin-bottom:10px;">
      ${product.condition ? `<span class="badge gray">${escapeHtml(product.condition)}</span>` : ""}
      ${product.country ? `<span class="badge blue">${escapeHtml(product.country)}</span>` : ""}
      <span class="badge ${safeNumber(product.stock) <= safeNumber(product.lowStock || 5) ? "low" : "ok"}">
        ${safeNumber(product.stock) <= safeNumber(product.lowStock || 5) ? "Low Stock" : "Stock OK"}
      </span>
    </div>

    <div class="grid-2">
      <div class="metric-box"><span>স্টক</span><strong>${safeNumber(product.stock).toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong></div>
      <div class="metric-box"><span>ক্রয় মূল্য</span><strong ${moneyStyle("buy")}>${formatMoney(product.buyPrice)}</strong></div>
      <div class="metric-box"><span>বিক্রয় মূল্য</span><strong ${moneyStyle("sell")}>${formatMoney(product.sellPrice)}</strong></div>
      <div class="metric-box"><span>মোট বিক্রি Qty</span><strong>${totalSold.toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong></div>
      <div class="metric-box"><span>আনুমানিক লাভ</span><strong ${moneyStyle("profitloss", approxProfit)}>${formatMoney(approxProfit)}</strong></div>
      <div class="metric-box"><span>Location</span><strong>${escapeHtml(getLocationText(product) || "-")}</strong></div>
    </div>

    <div class="log-item mt-10">
      <div>Category: ${escapeHtml(product.category || "-")}</div>
      <div>Brand: ${escapeHtml(product.brand || "-")}</div>
      <div>Supplier: ${escapeHtml(product.supplier || "-")}</div>
      <div>Code: ${escapeHtml(product.code || "-")}</div>
      <div>Barcode: ${escapeHtml(product.barcode || "-")}</div>
      <div style="margin-top:6px;">${escapeHtml(product.details || "No details")}</div>
    </div>

    <div class="divider"></div>

    <div class="panel-title panel-title-sm">Recent Sales</div>
    <div class="card-list mt-10">
      ${
        recentSales.length
          ? recentSales.slice(0, 8).map((s) => `
            <div class="log-item">
              <div><strong>${escapeHtml(s.date || "-")} • ${escapeHtml(s.customer || "-")}</strong></div>
              <div>Invoice: ${escapeHtml(s.docNo || "-")}</div>
              <div>Qty: ${safeNumber(s.qty)}</div>
              <div>Unit Price: <span ${moneyStyle("sell")}>${formatMoney(s.unitPrice)}</span></div>
              <div>Total: <span ${moneyStyle("income")}>${formatMoney(s.total)}</span></div>
            </div>
          `).join("")
          : `<div class="log-item">No sales yet</div>`
      }
    </div>
  `);

  openModalById("productDetailModal");
}

function closeProductDetail() {
  closeModalById("productDetailModal");
}

/* =========================
   RENDER PRODUCTS
========================= */
function renderProducts() {
  const query = getVal("searchInput").trim().toLowerCase();
  const category = getVal("categoryFilter").trim().toLowerCase();

  let rows = [...state.products];

  if (query) {
    rows = rows.filter((p) => {
      const hay = [
        p.name, p.category, p.brand, p.code, p.barcode, p.country,
        p.condition, p.supplier, p.details, p.room, p.rack, p.shelf, p.cell
      ].join(" ").toLowerCase();
      return hay.includes(query);
    });
  }

  if (category) {
    rows = rows.filter((p) => String(p.category || "").trim().toLowerCase() === category);
  }

  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  if (!rows.length) {
    setHtml("productList", `<div class="log-item">কোনো পার্টস পাওয়া যায়নি</div>`);
    return;
  }

  setHtml("productList", rows.map((product, index) => {
    const low = safeNumber(product.stock) <= safeNumber(product.lowStock || 5);
    const topLine = [product.category || "Auto Parts", product.brand || "", getLocationText(product) || ""]
      .filter(Boolean)
      .join(" • ");

    return `
      <div class="card" onclick="openProductDetail('${product.id}')">
        <div class="card-top">
          ${product.imageSignedUrl
            ? `<img class="product-thumb" src="${product.imageSignedUrl}" alt="${escapeHtml(product.name)}">`
            : `<div class="product-fallback">🚗</div>`
          }

          <div class="card-main">
            <div class="card-mini">${escapeHtml(topLine)}</div>
            <div class="card-title">${index + 1}. ${escapeHtml(product.name)}</div>
            <div class="card-meta">
              Code: ${escapeHtml(product.code || "-")} • Barcode: ${escapeHtml(product.barcode || "-")}
            </div>

            <div class="badge-row">
              ${product.condition ? `<span class="badge gray">${escapeHtml(product.condition)}</span>` : ""}
              ${product.country ? `<span class="badge blue">${escapeHtml(product.country)}</span>` : ""}
              <span class="badge ${low ? "low" : "ok"}">${low ? "Low Stock" : "In Stock"}</span>
            </div>
          </div>

          <div class="icon-row" onclick="event.stopPropagation()">
            <button class="mini-icon" type="button" onclick="openProductForm('${product.id}')">✎</button>
            <button class="mini-icon" type="button" onclick="deleteProduct('${product.id}')">🗑</button>
          </div>
        </div>

        <div class="metric-row">
          <div class="small-metric">
            <span>ক্রয়</span>
            <strong ${moneyStyle("buy")}>${formatMoney(product.buyPrice)}</strong>
          </div>
          <div class="small-metric">
            <span>বিক্রয়</span>
            <strong ${moneyStyle("sell")}>${formatMoney(product.sellPrice)}</strong>
          </div>
          <div class="small-metric">
            <span>স্টক</span>
            <strong>${safeNumber(product.stock).toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong>
          </div>
        </div>
      </div>
    `;
  }).join(""));
}

function renderReorderList() {
  const rows = state.products
    .filter((p) => safeNumber(p.stock) <= safeNumber(p.lowStock || 5))
    .sort((a, b) => safeNumber(a.stock) - safeNumber(b.stock));

  if (!rows.length) {
    setHtml("reorderList", `<div class="log-item">সব low stock item clear আছে</div>`);
    return;
  }

  setHtml("reorderList", rows.map((p) => `
    <div class="card">
      <div class="card-title">${escapeHtml(p.name)}</div>
      <div class="card-meta">
        Stock: ${safeNumber(p.stock)} • Low limit: ${safeNumber(p.lowStock || 5)}<br>
        Supplier: ${escapeHtml(p.supplier || "-")} • Last cost: <span ${moneyStyle("buy")}>${formatMoney(p.buyPrice)}</span>
      </div>
    </div>
  `).join(""));
}

/* =========================
   SALES BUILDER
========================= */
function createSaleRowHtml(prefill = {}) {
  return `
    <div class="sale-row">
      <div class="sale-row-grid">
        <div>
          <label>Product</label>
          <select class="select row-product" onchange="handleSaleProductChange(this)">
            <option value="">পার্টস নির্বাচন</option>
            ${state.products.map((p) => `
              <option value="${p.id}" ${prefill.productId === p.id ? "selected" : ""}>
                ${escapeHtml(p.name)} | Stock: ${safeNumber(p.stock)}
              </option>
            `).join("")}
          </select>
          <div class="stock-info"></div>
        </div>

        <div>
          <label>Qty</label>
          <input class="input row-qty" type="number" min="0.01" step="0.01" value="${prefill.qty || ""}" oninput="updateSaleRow(this)" />
        </div>

        <div>
          <label>Unit Price</label>
          <input class="input row-price" type="number" min="0" step="0.01" value="${prefill.unitPrice || ""}" oninput="updateSaleRow(this)" />
        </div>

        <div>
          <label>Discount</label>
          <input class="input row-discount" type="number" min="0" step="0.01" value="${prefill.discount || 0}" oninput="updateSaleRow(this)" />
        </div>

        <div>
          <label>X</label>
          <button class="mini-icon" type="button" onclick="removeSaleRow(this)">✕</button>
        </div>
      </div>
      <div class="line-total">মোট: <span class="row-total">৳0</span></div>
    </div>
  `;
}

function addSaleRow(prefill = {}) {
  const wrap = el("saleRows");
  if (!wrap) return;

  const temp = document.createElement("div");
  temp.innerHTML = createSaleRowHtml(prefill);
  const row = temp.firstElementChild;
  wrap.appendChild(row);

  if (prefill.productId) {
    const select = row.querySelector(".row-product");
    handleSaleProductChange(select, true);
  }

  updateSalesTotals();
}

function removeSaleRow(button) {
  button.closest(".sale-row")?.remove();
  updateSalesTotals();
}

function handleSaleProductChange(selectEl, silent = false) {
  const row = selectEl.closest(".sale-row");
  if (!row) return;

  const product = getProduct(selectEl.value);
  const info = row.querySelector(".stock-info");
  const priceInput = row.querySelector(".row-price");

  if (!product) {
    info.textContent = "";
    priceInput.value = "";
    updateSaleRow(selectEl);
    return;
  }

  info.textContent = `Stock: ${safeNumber(product.stock)} ${product.unit || ""}`;
  priceInput.value = safeNumber(product.sellPrice);

  if (!silent) updateSaleRow(selectEl);
  else updateSalesTotals();
}

function updateSaleRow(inputEl) {
  const row = inputEl.closest(".sale-row");
  if (!row) return;

  const qty = safeNumber(row.querySelector(".row-qty").value);
  const price = safeNumber(row.querySelector(".row-price").value);
  const discount = safeNumber(row.querySelector(".row-discount").value);
  const total = Math.max(0, qty * price - discount);

  row.querySelector(".row-total").textContent = formatMoney(total);
  row.querySelector(".row-total").style.color = moneyColor("income");
  updateSalesTotals();
}

function updateSalesTotals() {
  const rows = [...document.querySelectorAll("#saleRows .sale-row")];
  let subtotal = 0;

  rows.forEach((row) => {
    const qty = safeNumber(row.querySelector(".row-qty").value);
    const price = safeNumber(row.querySelector(".row-price").value);
    const discount = safeNumber(row.querySelector(".row-discount").value);
    subtotal += Math.max(0, qty * price - discount);
  });

  const discount = safeNumber(getVal("saleDiscount"));
  const grandTotal = Math.max(0, subtotal - discount);
  const paid = Math.min(grandTotal, safeNumber(getVal("salePaid")));
  const due = Math.max(0, grandTotal - paid);

  setText("saleSubtotal", formatMoney(subtotal));
  setText("saleGrandTotal", formatMoney(grandTotal));
  setText("salePaidShow", formatMoney(paid));
  setText("saleDueShow", formatMoney(due));

  setMoneyColor(el("saleSubtotal"), "income");
  setMoneyColor(el("saleGrandTotal"), "income");
  setMoneyColor(el("salePaidShow"), "paid");
  setMoneyColor(el("saleDueShow"), "due");
}

function collectSaleItems() {
  return [...document.querySelectorAll("#saleRows .sale-row")]
    .map((row) => {
      const productId = row.querySelector(".row-product").value;
      const product = getProduct(productId);
      const qty = safeNumber(row.querySelector(".row-qty").value);
      const unitPrice = safeNumber(row.querySelector(".row-price").value);
      const discount = safeNumber(row.querySelector(".row-discount").value);

      if (!productId || !product || qty <= 0) return null;

      return {
        productId,
        productName: product.name,
        qty,
        unitPrice,
        discount,
        total: Math.max(0, qty * unitPrice - discount),
        buyPrice: safeNumber(product.buyPrice)
      };
    })
    .filter(Boolean);
}

function resetSalesBuilder() {
  setVal("saleDocType", "invoice");
  setVal("saleDate", todayStr());
  setVal("saleDocNo", generateDocNo("INV"));
  setVal("saleDueDate", todayStr());
  setVal("saleCustomerName", "");
  setVal("saleCustomerPhone", "");
  setVal("saleCustomerAddress", "");
  setVal("saleDiscount", 0);
  setVal("salePaid", 0);
  setVal("salePaymentMethod", "Cash");
  setVal("saleNote", "");

  if (hasEl("saleRows")) el("saleRows").innerHTML = "";

  clearScopedSplitInputs("sale");
  writeScopedSplitValues("sale", {});
  toggleSalePaymentFields();
  updateSaleSplitPreviewFromInputs();

  addSaleRow();
  updateSalesTotals();
}

async function saveSaleDocument() {
  const type = getVal("saleDocType") || "invoice";
  const items = collectSaleItems();
  const customerName = getVal("saleCustomerName").trim();
  const customerPhone = getVal("saleCustomerPhone").trim();

  if (!customerName && !customerPhone) {
    return alert("Customer name বা mobile দিন");
  }

  if (!items.length) {
    return alert("কমপক্ষে ১টি আইটেম দিন");
  }

  if (type === "invoice") {
    const needMap = {};
    items.forEach((item) => {
      needMap[item.productId] = (needMap[item.productId] || 0) + safeNumber(item.qty);
    });

    for (const productId of Object.keys(needMap)) {
      const product = getProduct(productId);
      if (!product || safeNumber(product.stock) < needMap[productId]) {
        return alert(`${product ? product.name : "Product"} এর stock যথেষ্ট নেই`);
      }
    }
  }

  const docObj = {
    id: uid("sale"),
    type,
    docNo: getVal("saleDocNo").trim() || generateDocNo(type === "invoice" ? "INV" : "QT"),
    date: getVal("saleDate") || todayStr(),
    dueDate: getVal("saleDueDate") || "",
    customerName,
    customerPhone,
    customerAddress: getVal("saleCustomerAddress").trim(),
    note: getVal("saleNote").trim(),
    items,
    discount: safeNumber(getVal("saleDiscount")),
    payments: []
  };

  const paidNow = safeNumber(getVal("salePaid"));
  const saleInitialMethod = getVal("salePaymentMethod") || "Cash";
  const saleInitialSplit = readScopedSplitValues("sale");

  if (paidNow > 0) {
    if (saleInitialMethod === "Mixed") {
      const splitTotal = sumPaymentSplit(saleInitialSplit);
      if (Math.abs(splitTotal - paidNow) > 0.001) {
        return alert("Sales Paid Now আর split total সমান হতে হবে");
      }
    }

    docObj.payments.push({
      id: uid("pay"),
      date: docObj.date,
      amount: paidNow,
      method: saleInitialMethod,
      paymentSplit: saleInitialMethod === "Mixed" ? saleInitialSplit : {},
      note: "Initial payment"
    });
  }

  recalcSaleDoc(docObj);

  if (docObj.paid > docObj.grandTotal) {
    return alert("Paid amount বেশি হয়ে গেছে");
  }

  if (type === "invoice") {
    docObj.items.forEach((item) => {
      const product = getProduct(item.productId);
      if (product) {
        product.stock = Math.max(0, safeNumber(product.stock) - safeNumber(item.qty));
        product.updatedAt = new Date().toISOString();
      }

      state.stockMoves.unshift({
        id: uid("move"),
        date: docObj.date,
        type: "Sale Out",
        productId: item.productId,
        productName: item.productName,
        qty: item.qty,
        signedQty: -safeNumber(item.qty),
        refNo: docObj.docNo,
        note: docObj.note || "Invoice sale"
      });
    });
  }

  state.salesDocs.unshift(docObj);
  addActivity(`${type === "invoice" ? "Invoice" : "Quotation"} saved: ${docObj.docNo}`);
  saveAll();

  if (type === "invoice") {
    await syncStoreSaleToHishab(docObj);
  }

  renderAll();
  resetSalesBuilder();
}

/* =========================
   SALES LIST
========================= */
function getSaleStatusClass(docObj) {
  if (docObj.type === "quotation") return "quote-chip";
  if (docObj.status === "Paid") return "paid-chip";
  if (docObj.status === "Overdue") return "overdue-chip";
  if (docObj.status === "Due" || docObj.status === "Due Today") return "due-chip";
  return "partial-chip";
}

function renderSalesList() {
  const query = getVal("searchInput").trim().toLowerCase();
  let rows = [...state.salesDocs];

  if (query) {
    rows = rows.filter((docObj) => {
      const hay = [
        docObj.docNo,
        docObj.customerName,
        docObj.customerPhone,
        docObj.customerAddress,
        ...docObj.items.map((item) => item.productName)
      ].join(" ").toLowerCase();

      return hay.includes(query);
    });
  }

  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (!rows.length) {
    setHtml("salesList", `<div class="log-item">কোনো sales/quotation নেই</div>`);
    return;
  }

  setHtml("salesList", rows.map((docObj) => `
    <div class="card">
      <div class="card-top">
        <div class="card-main">
          <div class="card-title">${escapeHtml(docObj.docNo)}</div>
          <div class="card-meta">
            ${escapeHtml(docObj.date || "-")} • ${escapeHtml(docObj.customerName || "-")} • ${escapeHtml(docObj.customerPhone || "-")}
          </div>
          <div class="card-meta">
            ${docObj.items.map((item) => `${escapeHtml(item.productName)} × ${safeNumber(item.qty)}`).join(", ")}
          </div>
        </div>
        <div class="status-chip ${getSaleStatusClass(docObj)}">
          ${escapeHtml(docObj.type === "quotation" ? "Quotation" : docObj.status)}
        </div>
      </div>

      <div class="metric-row">
        <div class="small-metric"><span>Total</span><strong ${moneyStyle("income")}>${formatMoney(docObj.grandTotal)}</strong></div>
        <div class="small-metric"><span>Paid</span><strong ${moneyStyle("paid")}>${formatMoney(docObj.paid)}</strong></div>
        <div class="small-metric"><span>Due</span><strong ${moneyStyle("due")}>${formatMoney(docObj.due)}</strong></div>
      </div>

      <div class="action-grid-2 mt-10">
        ${
          docObj.type === "quotation"
            ? `<button class="action-btn primary" type="button" onclick="convertQuotationToInvoice('${docObj.id}')">Convert Invoice</button>`
            : `<button class="action-btn green" type="button" onclick="openPaymentModal('sale','${docObj.id}')">Add Payment</button>`
        }

        ${
          docObj.type === "invoice"
            ? `<button class="action-btn yellow" type="button" onclick="markFullPaidSale('${docObj.id}')">Full Pay</button>`
            : `<button class="action-btn red" type="button" onclick="deleteSaleDoc('${docObj.id}')">Delete</button>`
        }

        ${
          docObj.type === "invoice"
            ? `<button class="action-btn yellow" type="button" onclick="returnFromInvoice('${docObj.id}')">Return</button>`
            : `<button class="action-btn primary" type="button" onclick="openCustomerHistoryByDoc('${docObj.id}')">History</button>`
        }

        ${
          docObj.type === "invoice"
            ? `<button class="action-btn primary" type="button" onclick="openCustomerHistoryByDoc('${docObj.id}')">History</button>`
            : ``
        }
      </div>
    </div>
  `).join(""));
}

async function deleteSaleDoc(docId) {
  const docObj = getSaleDoc(docId);
  if (!docObj) return;

  if (docObj.type === "invoice") {
    if (!confirm("Invoice delete করলে stock ফেরত যাবে। চালাবো?")) return;

    docObj.items.forEach((item) => {
      const product = getProduct(item.productId);
      if (product) {
        product.stock = safeNumber(product.stock) + safeNumber(item.qty);
        product.updatedAt = new Date().toISOString();
      }
    });
  } else {
    if (!confirm("Quotation delete করবেন?")) return;
  }

  state.salesDocs = state.salesDocs.filter((d) => d.id !== docId);
  addActivity(`Document deleted: ${docObj.docNo}`);
  saveAll();

  if (docObj.type === "invoice") {
    await removeStoreSaleFromHishab(docObj.id);
  }

  renderAll();
}

async function convertQuotationToInvoice(docId) {
  const docObj = getSaleDoc(docId);
  if (!docObj || docObj.type !== "quotation") return;

  for (const item of docObj.items) {
    const product = getProduct(item.productId);
    if (!product || safeNumber(product.stock) < safeNumber(item.qty)) {
      return alert(`${item.productName} এর stock যথেষ্ট নেই`);
    }
  }

  docObj.type = "invoice";
  docObj.docNo = generateDocNo("INV");

  docObj.items.forEach((item) => {
    const product = getProduct(item.productId);
    if (product) {
      product.stock = safeNumber(product.stock) - safeNumber(item.qty);
      product.updatedAt = new Date().toISOString();
    }

    state.stockMoves.unshift({
      id: uid("move"),
      date: docObj.date,
      type: "Sale Out",
      productId: item.productId,
      productName: item.productName,
      qty: item.qty,
      signedQty: -safeNumber(item.qty),
      refNo: docObj.docNo,
      note: "Quotation converted"
    });
  });

  recalcSaleDoc(docObj);
  addActivity(`Quotation converted: ${docObj.docNo}`);
  saveAll();
  await syncStoreSaleToHishab(docObj);

  renderAll();
}

/* =========================
   PURCHASE BUILDER
========================= */
function resetPurchaseBuilder() {
  setVal("purchaseProduct", "");
  setVal("purchaseDate", todayStr());
  setVal("purchaseDocNo", generateDocNo("PINV"));
  setVal("purchaseDueDate", todayStr());
  setVal("purchaseSupplierName", "");
  setVal("purchaseSupplierPhone", "");
  setVal("purchaseQty", "");
  setVal("purchaseUnitCost", "");
  setVal("purchasePaid", 0);
  setVal("purchasePaymentMethod", "Cash");
  setVal("purchaseNote", "");

  clearScopedSplitInputs("purchase");
  writeScopedSplitValues("purchase", {});
  togglePurchasePaymentFields();
  updatePurchaseSplitPreviewFromInputs();
}

function fillPurchaseCost() {
  const product = getProduct(getVal("purchaseProduct"));
  if (!product) return alert("Product select করুন");
  setVal("purchaseUnitCost", safeNumber(product.buyPrice));
}

async function savePurchaseDocument() {
  const productId = getVal("purchaseProduct");
  const product = getProduct(productId);
  if (!product) return alert("Product select করুন");

  const qty = safeNumber(getVal("purchaseQty"));
  const unitCost = safeNumber(getVal("purchaseUnitCost"));
  const paidNow = safeNumber(getVal("purchasePaid"));

  if (qty <= 0) return alert("সঠিক quantity দিন");
  if (unitCost < 0) return alert("সঠিক cost দিন");

  const docObj = {
    id: uid("purchase"),
    docNo: getVal("purchaseDocNo").trim() || generateDocNo("PINV"),
    date: getVal("purchaseDate") || todayStr(),
    dueDate: getVal("purchaseDueDate") || "",
    supplierName: getVal("purchaseSupplierName").trim(),
    supplierPhone: getVal("purchaseSupplierPhone").trim(),
    productId: product.id,
    productName: product.name,
    qty,
    unitCost,
    note: getVal("purchaseNote").trim(),
    payments: []
  };

  const purchaseInitialMethod = getVal("purchasePaymentMethod") || "Cash";
  const purchaseInitialSplit = readScopedSplitValues("purchase");

  if (paidNow > 0) {
    if (purchaseInitialMethod === "Mixed") {
      const splitTotal = sumPaymentSplit(purchaseInitialSplit);
      if (Math.abs(splitTotal - paidNow) > 0.001) {
        return alert("Purchase Paid Now আর split total সমান হতে হবে");
      }
    }

    docObj.payments.push({
      id: uid("ppay"),
      date: docObj.date,
      amount: paidNow,
      method: purchaseInitialMethod,
      paymentSplit: purchaseInitialMethod === "Mixed" ? purchaseInitialSplit : {},
      note: "Initial payment"
    });
  }

  recalcPurchaseDoc(docObj);

  if (docObj.paid > docObj.total) {
    return alert("Paid বেশি হয়ে গেছে");
  }

  product.stock = safeNumber(product.stock) + qty;
  product.buyPrice = unitCost;
  product.updatedAt = new Date().toISOString();

  state.purchaseDocs.unshift(docObj);
  state.stockMoves.unshift({
    id: uid("move"),
    date: docObj.date,
    type: "Stock In",
    productId: product.id,
    productName: product.name,
    qty,
    signedQty: qty,
    refNo: docObj.docNo,
    note: docObj.note || "Purchase"
  });

  addActivity(`Purchase saved: ${docObj.docNo}`);
  saveAll();
  await syncStorePurchaseToHishab(docObj);

  renderAll();
  resetPurchaseBuilder();
}

function renderPurchaseList() {
  const rows = [...state.purchaseDocs].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (!rows.length) {
    setHtml("purchaseList", `<div class="log-item">কোনো purchase doc নেই</div>`);
    return;
  }

  setHtml("purchaseList", rows.map((docObj) => `
    <div class="card">
      <div class="card-top">
        <div class="card-main">
          <div class="card-title">${escapeHtml(docObj.docNo)}</div>
          <div class="card-meta">
            ${escapeHtml(docObj.date || "-")} • ${escapeHtml(docObj.supplierName || "-")} • ${escapeHtml(docObj.supplierPhone || "-")}
          </div>
          <div class="card-meta">
            ${escapeHtml(docObj.productName)} × ${safeNumber(docObj.qty)} • Unit Cost: <span ${moneyStyle("buy")}>${formatMoney(docObj.unitCost)}</span>
          </div>
        </div>
        <div class="status-chip ${docObj.status === "Paid" ? "paid-chip" : (docObj.status === "Overdue" ? "overdue-chip" : "due-chip")}">
          ${escapeHtml(docObj.status)}
        </div>
      </div>

      <div class="metric-row">
        <div class="small-metric"><span>Total</span><strong ${moneyStyle("expense")}>${formatMoney(docObj.total)}</strong></div>
        <div class="small-metric"><span>Paid</span><strong ${moneyStyle("expense")}>${formatMoney(docObj.paid)}</strong></div>
        <div class="small-metric"><span>Due</span><strong ${moneyStyle("due")}>${formatMoney(docObj.due)}</strong></div>
      </div>

      <div class="action-grid-2 mt-10">
        <button class="action-btn green" type="button" onclick="openPaymentModal('purchase','${docObj.id}')">Add Payment</button>
        <button class="action-btn yellow" type="button" onclick="markFullPaidPurchase('${docObj.id}')">Full Pay</button>
        <button class="action-btn primary" type="button" onclick="openSupplierHistoryByDoc('${docObj.id}')">Ledger</button>
        <button class="action-btn red" type="button" onclick="deletePurchaseDoc('${docObj.id}')">Delete</button>
      </div>
    </div>
  `).join(""));
}

async function deletePurchaseDoc(docId) {
  const docObj = getPurchaseDoc(docId);
  if (!docObj) return;
  if (!confirm("Purchase doc delete করলে stock কমে যাবে। চালাবেন?")) return;

  const product = getProduct(docObj.productId);
  if (product) {
    product.stock = Math.max(0, safeNumber(product.stock) - safeNumber(docObj.qty));
    product.updatedAt = new Date().toISOString();
  }

  state.purchaseDocs = state.purchaseDocs.filter((d) => d.id !== docId);
  addActivity(`Purchase deleted: ${docObj.docNo}`);
  saveAll();
  await removeStorePurchaseFromHishab(docObj.id);

  renderAll();
}

/* =========================
   PAYMENT MODAL
========================= */
function openPaymentModal(mode, docId) {
  state.paymentContext = { mode, docId };

  setText("paymentModalTitle", mode === "sale" ? "Customer Payment" : "Supplier Payment");
  setVal("paymentDate", todayStr());
  setVal("paymentAmount", "");
  setVal("paymentMethod", "Cash");
  setVal("paymentNote", "");

  clearPaymentSplitInputs();
  writePaymentSplitValues({});
  togglePaymentMethodFields();
  updatePaymentSplitPreview();

  openModalById("paymentModal");
}

function closePaymentModal() {
  closeModalById("paymentModal");
  state.paymentContext = null;

  setVal("paymentAmount", "");
  setVal("paymentMethod", "Cash");
  setVal("paymentNote", "");
  clearPaymentSplitInputs();
  togglePaymentMethodFields();
  updatePaymentSplitPreview();
}

async function savePayment() {
  if (!state.paymentContext) return;

  const amount = safeNumber(getVal("paymentAmount"));
  if (amount <= 0) return alert("সঠিক amount দিন");

  const method = getVal("paymentMethod") || "Cash";
  const paymentSplit = readPaymentSplitValues();

  if (method === "Mixed") {
    const splitTotal = sumPaymentSplit(paymentSplit);
    if (Math.abs(splitTotal - amount) > 0.001) {
      return alert("Mixed split total এবং payment amount সমান হতে হবে");
    }
  }

  const payment = {
    id: uid("pay"),
    date: getVal("paymentDate") || todayStr(),
    amount,
    method,
    paymentSplit: method === "Mixed" ? paymentSplit : {},
    note: getVal("paymentNote").trim()
  };

  if (state.paymentContext.mode === "sale") {
    const docObj = getSaleDoc(state.paymentContext.docId);
    if (!docObj) return;

    docObj.payments.push(payment);
    recalcSaleDoc(docObj);

    if (docObj.paid - docObj.grandTotal > 0.001) {
      docObj.payments.pop();
      recalcSaleDoc(docObj);
      return alert("Paid total-এর বেশি হয়ে যাচ্ছে");
    }

    addActivity(`Customer payment added: ${docObj.docNo}`);
    saveAll();
    await syncStoreSaleToHishab(docObj);
  } else {
    const docObj = getPurchaseDoc(state.paymentContext.docId);
    if (!docObj) return;

    docObj.payments.push(payment);
    recalcPurchaseDoc(docObj);

    if (docObj.paid - docObj.total > 0.001) {
      docObj.payments.pop();
      recalcPurchaseDoc(docObj);
      return alert("Paid total-এর বেশি হয়ে যাচ্ছে");
    }

    addActivity(`Supplier payment added: ${docObj.docNo}`);
    saveAll();
    await syncStorePurchaseToHishab(docObj);
  }

  renderAll();
  closePaymentModal();
}

async function markFullPaidSale(docId) {
  const docObj = getSaleDoc(docId);
  if (!docObj || docObj.type !== "invoice") return;
  if (safeNumber(docObj.due) <= 0) return alert("Already fully paid");

  docObj.payments.push({
    id: uid("pay"),
    date: todayStr(),
    amount: safeNumber(docObj.due),
    method: "Cash",
    paymentSplit: {},
    note: "Full payment"
  });

  recalcSaleDoc(docObj);
  addActivity(`Invoice fully paid: ${docObj.docNo}`);
  saveAll();
  await syncStoreSaleToHishab(docObj);

  renderAll();
}

async function markFullPaidPurchase(docId) {
  const docObj = getPurchaseDoc(docId);
  if (!docObj) return;
  if (safeNumber(docObj.due) <= 0) return alert("Already fully paid");

  docObj.payments.push({
    id: uid("ppay"),
    date: todayStr(),
    amount: safeNumber(docObj.due),
    method: "Cash",
    paymentSplit: {},
    note: "Full payment"
  });

  recalcPurchaseDoc(docObj);
  addActivity(`Supplier invoice fully paid: ${docObj.docNo}`);
  saveAll();
  await syncStorePurchaseToHishab(docObj);

  renderAll();
}

/* =========================
   RETURN
========================= */
async function returnFromInvoice(docId) {
  const docObj = getSaleDoc(docId);
  if (!docObj || docObj.type !== "invoice") return;

  const itemLines = docObj.items.map((item, index) => {
    const returned = getReturnedQty(docId, item.productId);
    const balance = safeNumber(item.qty) - returned;
    return `${index + 1}. ${item.productName} | Sold: ${item.qty} | Returned: ${returned} | Balance: ${balance}`;
  }).join("\n");

  const idx = safeNumber(prompt(`কোন item return?\n\n${itemLines}`, "1")) - 1;
  if (idx < 0 || idx >= docObj.items.length) return;

  const item = docObj.items[idx];
  const alreadyReturned = getReturnedQty(docId, item.productId);
  const maxQty = safeNumber(item.qty) - alreadyReturned;

  if (maxQty <= 0) return alert("এই item পুরো return হয়ে গেছে");

  const qty = safeNumber(prompt(`কত qty return? Max: ${maxQty}`, "1"));
  if (qty <= 0 || qty > maxQty) return alert("সঠিক qty দিন");

  const refundAmount = safeNumber(prompt("Refund amount", String(safeNumber(item.unitPrice) * qty)));
  const product = getProduct(item.productId);
  if (!product) return;

  product.stock = safeNumber(product.stock) + qty;
  product.updatedAt = new Date().toISOString();

  state.returns.unshift({
    id: uid("ret"),
    date: todayStr(),
    docId: docObj.id,
    docNo: docObj.docNo,
    productId: item.productId,
    productName: item.productName,
    qty,
    refundAmount,
    customerName: docObj.customerName
  });

  if (refundAmount > 0) {
    docObj.discount = safeNumber(docObj.discount) + refundAmount;
    recalcSaleDoc(docObj);
  }

  state.stockMoves.unshift({
    id: uid("move"),
    date: todayStr(),
    type: "Return In",
    productId: item.productId,
    productName: item.productName,
    qty,
    signedQty: qty,
    refNo: docObj.docNo,
    note: "Return"
  });

  addActivity(`Return processed: ${docObj.docNo} • ${item.productName} × ${qty}`);
  saveAll();
  await syncStoreSaleToHishab(docObj);

  renderAll();
}

/* =========================
   DUES
========================= */
function getCustomerDueGroups() {
  const groups = {};

  state.salesDocs
    .filter((d) => d.type === "invoice" && safeNumber(d.due) > 0)
    .forEach((docObj) => {
      const key = getCustomerKey(docObj.customerName, docObj.customerPhone);

      if (!groups[key]) {
        groups[key] = {
          key,
          name: docObj.customerName || "Unknown",
          phone: docObj.customerPhone || "",
          address: docObj.customerAddress || "",
          totalDue: 0,
          overdueCount: 0,
          docs: []
        };
      }

      groups[key].totalDue += safeNumber(docObj.due);
      groups[key].docs.push(docObj);
      if (docObj.status === "Overdue") groups[key].overdueCount += 1;
    });

  return Object.values(groups).sort((a, b) => b.totalDue - a.totalDue);
}

function getSupplierDueGroups() {
  const groups = {};

  state.purchaseDocs
    .filter((d) => safeNumber(d.due) > 0)
    .forEach((docObj) => {
      const key = getSupplierKey(docObj.supplierName, docObj.supplierPhone);

      if (!groups[key]) {
        groups[key] = {
          key,
          name: docObj.supplierName || "Unknown Supplier",
          phone: docObj.supplierPhone || "",
          totalDue: 0,
          overdueCount: 0,
          docs: []
        };
      }

      groups[key].totalDue += safeNumber(docObj.due);
      groups[key].docs.push(docObj);
      if (docObj.status === "Overdue") groups[key].overdueCount += 1;
    });

  return Object.values(groups).sort((a, b) => b.totalDue - a.totalDue);
}

function renderDueLists() {
  const mode = getVal("dueMode") || "customer";
  const query = getVal("searchInput").trim().toLowerCase();

  if (mode === "supplier") {
    let groups = getSupplierDueGroups();

    if (query) {
      groups = groups.filter((g) => [g.name, g.phone].join(" ").toLowerCase().includes(query));
    }

    if (!groups.length) {
      setHtml("dueList", `<div class="log-item">কোনো supplier due নেই</div>`);
      return;
    }

    setHtml("dueList", groups.map((group) => `
      <div class="card">
        <div class="card-top">
          <div class="card-main">
            <div class="card-title">${escapeHtml(group.name)}</div>
            <div class="card-meta">${escapeHtml(group.phone || "-")} • Invoice: ${group.docs.length} টি</div>
          </div>
          <div class="status-chip ${group.overdueCount ? "overdue-chip" : "due-chip"}">
            ${group.overdueCount ? "Overdue" : "Due"}
          </div>
        </div>

        <div class="metric-row">
          <div class="small-metric"><span>Total Due</span><strong ${moneyStyle("due")}>${formatMoney(group.totalDue)}</strong></div>
          <div class="small-metric"><span>Overdue</span><strong>${group.overdueCount}</strong></div>
          <div class="small-metric"><span>Docs</span><strong>${group.docs.length}</strong></div>
        </div>

        <div class="action-grid-2 mt-10">
          <button class="action-btn green" type="button" onclick="quickAddSupplierPayment('${group.key}')">Add Payment</button>
          <button class="action-btn yellow" type="button" onclick="markSupplierGroupFullPaid('${group.key}')">Full Clear</button>
          <button class="action-btn primary" type="button" onclick="openSupplierHistoryByKey('${group.key}')">Ledger</button>
        </div>
      </div>
    `).join(""));
    return;
  }

  let groups = getCustomerDueGroups();

  if (query) {
    groups = groups.filter((g) => [g.name, g.phone, g.address].join(" ").toLowerCase().includes(query));
  }

  if (!groups.length) {
    setHtml("dueList", `<div class="log-item">কোনো customer due নেই</div>`);
    return;
  }

  setHtml("dueList", groups.map((group) => `
    <div class="card">
      <div class="card-top">
        <div class="card-main">
          <div class="card-title">${escapeHtml(group.name)}</div>
          <div class="card-meta">${escapeHtml(group.phone || "-")} • Invoice: ${group.docs.length} টি</div>
        </div>
        <div class="status-chip ${group.overdueCount ? "overdue-chip" : "due-chip"}">
          ${group.overdueCount ? "Overdue" : "Due"}
        </div>
      </div>

      <div class="metric-row">
        <div class="small-metric"><span>Total Due</span><strong ${moneyStyle("due")}>${formatMoney(group.totalDue)}</strong></div>
        <div class="small-metric"><span>Overdue</span><strong>${group.overdueCount}</strong></div>
        <div class="small-metric"><span>Docs</span><strong>${group.docs.length}</strong></div>
      </div>

      <div class="action-grid-2 mt-10">
        <button class="action-btn green" type="button" onclick="quickAddCustomerPayment('${group.key}')">Add Payment</button>
        <button class="action-btn yellow" type="button" onclick="markCustomerGroupFullPaid('${group.key}')">Full Clear</button>
        <button class="action-btn primary" type="button" onclick="openCustomerHistoryByKey('${group.key}')">History</button>
      </div>
    </div>
  `).join(""));
}

function quickAddCustomerPayment(groupKey) {
  const group = getCustomerDueGroups().find((g) => g.key === groupKey);
  if (!group) return;
  const target = [...group.docs].sort((a, b) => (daysUntil(a.dueDate || "") ?? 999) - (daysUntil(b.dueDate || "") ?? 999))[0];
  if (!target) return;
  openPaymentModal("sale", target.id);
}

function quickAddSupplierPayment(groupKey) {
  const group = getSupplierDueGroups().find((g) => g.key === groupKey);
  if (!group) return;
  const target = [...group.docs].sort((a, b) => (daysUntil(a.dueDate || "") ?? 999) - (daysUntil(b.dueDate || "") ?? 999))[0];
  if (!target) return;
  openPaymentModal("purchase", target.id);
}

async function markCustomerGroupFullPaid(groupKey) {
  const group = getCustomerDueGroups().find((g) => g.key === groupKey);
  if (!group) return;
  if (!confirm("এই কাস্টমারের সব due clear করবেন?")) return;

  for (const docObj of group.docs) {
    if (safeNumber(docObj.due) > 0) {
      docObj.payments.push({
        id: uid("pay"),
        date: todayStr(),
        amount: safeNumber(docObj.due),
        method: "Cash",
        paymentSplit: {},
        note: "Customer full settlement"
      });
      recalcSaleDoc(docObj);
      await syncStoreSaleToHishab(docObj);
    }
  }

  addActivity(`Customer full settlement: ${group.name}`);
  saveAll();
  renderAll();
}

async function markSupplierGroupFullPaid(groupKey) {
  const group = getSupplierDueGroups().find((g) => g.key === groupKey);
  if (!group) return;
  if (!confirm("এই supplier-এর সব due clear করবেন?")) return;

  for (const docObj of group.docs) {
    if (safeNumber(docObj.due) > 0) {
      docObj.payments.push({
        id: uid("ppay"),
        date: todayStr(),
        amount: safeNumber(docObj.due),
        method: "Cash",
        paymentSplit: {},
        note: "Supplier full settlement"
      });
      recalcPurchaseDoc(docObj);
      await syncStorePurchaseToHishab(docObj);
    }
  }

  addActivity(`Supplier full settlement: ${group.name}`);
  saveAll();
  renderAll();
}

/* =========================
   HISTORY POPUPS
========================= */
function openCustomerHistoryByKey(key) {
  const docs = state.salesDocs
    .filter((d) => d.type === "invoice" && getCustomerKey(d.customerName, d.customerPhone) === key)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (!docs.length) return;

  const totalPurchase = docs.reduce((sum, d) => sum + safeNumber(d.grandTotal), 0);
  const totalPaid = docs.reduce((sum, d) => sum + safeNumber(d.paid), 0);
  const totalDue = docs.reduce((sum, d) => sum + safeNumber(d.due), 0);

  openPopup("Customer History", `
    <h2>${escapeHtml(docs[0].customerName || "Customer")}</h2>
    <p><strong>Phone:</strong> ${escapeHtml(docs[0].customerPhone || "-")}</p>
    <p><strong>Total Purchase:</strong> <span ${moneyStyle("income")}>${formatMoney(totalPurchase)}</span></p>
    <p><strong>Total Paid:</strong> <span ${moneyStyle("paid")}>${formatMoney(totalPaid)}</span></p>
    <p><strong>Total Due:</strong> <span ${moneyStyle("due")}>${formatMoney(totalDue)}</span></p>

    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Invoice</th>
          <th>Items</th>
          <th>Total</th>
          <th>Paid</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        ${docs.map((d) => `
          <tr>
            <td>${escapeHtml(d.date || "-")}</td>
            <td>${escapeHtml(d.docNo || "-")}</td>
            <td>${d.items.map((i) => `${escapeHtml(i.productName)} × ${i.qty}`).join("<br>")}</td>
            <td><span ${moneyStyle("income")}>${formatMoney(d.grandTotal)}</span></td>
            <td><span ${moneyStyle("paid")}>${formatMoney(d.paid)}</span></td>
            <td><span ${moneyStyle("due")}>${formatMoney(d.due)}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `);
}

function openCustomerHistoryByDoc(docId) {
  const docObj = getSaleDoc(docId);
  if (!docObj) return;
  openCustomerHistoryByKey(getCustomerKey(docObj.customerName, docObj.customerPhone));
}

function openSupplierHistoryByKey(key) {
  const docs = state.purchaseDocs
    .filter((d) => getSupplierKey(d.supplierName, d.supplierPhone) === key)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (!docs.length) return;

  const totalPurchase = docs.reduce((sum, d) => sum + safeNumber(d.total), 0);
  const totalPaid = docs.reduce((sum, d) => sum + safeNumber(d.paid), 0);
  const totalDue = docs.reduce((sum, d) => sum + safeNumber(d.due), 0);

  openPopup("Supplier Ledger", `
    <h2>${escapeHtml(docs[0].supplierName || "Supplier")}</h2>
    <p><strong>Phone:</strong> ${escapeHtml(docs[0].supplierPhone || "-")}</p>
    <p><strong>Total Purchase:</strong> <span ${moneyStyle("expense")}>${formatMoney(totalPurchase)}</span></p>
    <p><strong>Total Paid:</strong> <span ${moneyStyle("expense")}>${formatMoney(totalPaid)}</span></p>
    <p><strong>Total Due:</strong> <span ${moneyStyle("due")}>${formatMoney(totalDue)}</span></p>

    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Invoice</th>
          <th>Product</th>
          <th>Total</th>
          <th>Paid</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        ${docs.map((d) => `
          <tr>
            <td>${escapeHtml(d.date || "-")}</td>
            <td>${escapeHtml(d.docNo || "-")}</td>
            <td>${escapeHtml(d.productName)} × ${safeNumber(d.qty)}</td>
            <td><span ${moneyStyle("expense")}>${formatMoney(d.total)}</span></td>
            <td><span ${moneyStyle("expense")}>${formatMoney(d.paid)}</span></td>
            <td><span ${moneyStyle("due")}>${formatMoney(d.due)}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `);
}

function openSupplierHistoryByDoc(docId) {
  const docObj = getPurchaseDoc(docId);
  if (!docObj) return;
  openSupplierHistoryByKey(getSupplierKey(docObj.supplierName, docObj.supplierPhone));
}

/* =========================
   REPORTS
========================= */
function renderReportModeFields() {
  const wrap = el("reportDynamicFields");
  if (!wrap) return;

  const mode = getVal("reportMode") || "dateRange";
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = [];

  for (let y = currentYear + 1; y >= currentYear - 8; y--) {
    years.push(y);
  }

  if (mode === "singleDate") {
    wrap.innerHTML = `
      <div class="form-group full">
        <label>নির্দিষ্ট দিন</label>
        <input id="reportSingleDate" class="input" type="date" onchange="renderReports()" />
      </div>
    `;
    setVal("reportSingleDate", todayStr());
    return;
  }

  if (mode === "monthYear") {
    wrap.innerHTML = `
      <div class="form-group">
        <label>মাস</label>
        <select id="reportMonth" class="select" onchange="renderReports()">
          <option value="1">জানুয়ারি</option>
          <option value="2">ফেব্রুয়ারি</option>
          <option value="3">মার্চ</option>
          <option value="4">এপ্রিল</option>
          <option value="5">মে</option>
          <option value="6">জুন</option>
          <option value="7">জুলাই</option>
          <option value="8">আগস্ট</option>
          <option value="9">সেপ্টেম্বর</option>
          <option value="10">অক্টোবর</option>
          <option value="11">নভেম্বর</option>
          <option value="12">ডিসেম্বর</option>
        </select>
      </div>

      <div class="form-group">
        <label>বছর</label>
        <select id="reportYearMonth" class="select" onchange="renderReports()">
          ${years.map((y) => `<option value="${y}">${y}</option>`).join("")}
        </select>
      </div>
    `;

    setVal("reportMonth", String(now.getMonth() + 1));
    setVal("reportYearMonth", String(currentYear));
    return;
  }

  if (mode === "yearOnly") {
    wrap.innerHTML = `
      <div class="form-group full">
        <label>বছর</label>
        <select id="reportYearOnly" class="select" onchange="renderReports()">
          ${years.map((y) => `<option value="${y}">${y}</option>`).join("")}
        </select>
      </div>
    `;
    setVal("reportYearOnly", String(currentYear));
    return;
  }

  wrap.innerHTML = `
    <div class="form-group">
      <label>From Date</label>
      <input id="reportFrom" class="input" type="date" onchange="renderReports()" />
    </div>
    <div class="form-group">
      <label>To Date</label>
      <input id="reportTo" class="input" type="date" onchange="renderReports()" />
    </div>
  `;
}

function getReportRange() {
  const mode = getVal("reportMode") || "dateRange";

  if (mode === "singleDate") {
    const d = getVal("reportSingleDate");
    return { from: d, to: d };
  }

  if (mode === "monthYear") {
    const month = safeNumber(getVal("reportMonth"));
    const year = safeNumber(getVal("reportYearMonth"));
    if (!month || !year) return { from: "", to: "" };
    const from = new Date(year, month - 1, 1).toISOString().slice(0, 10);
    const to = new Date(year, month, 0).toISOString().slice(0, 10);
    return { from, to };
  }

  if (mode === "yearOnly") {
    const year = safeNumber(getVal("reportYearOnly"));
    if (!year) return { from: "", to: "" };
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  return {
    from: getVal("reportFrom"),
    to: getVal("reportTo")
  };
}

function renderReports() {
  const { from, to } = getReportRange();

  const sales = state.salesDocs.filter((d) => {
    if (d.type !== "invoice") return false;
    if (from && d.date < from) return false;
    if (to && d.date > to) return false;
    return true;
  });

  const purchases = state.purchaseDocs.filter((d) => {
    if (from && d.date < from) return false;
    if (to && d.date > to) return false;
    return true;
  });

  const moves = state.stockMoves.filter((m) => {
    if (from && m.date < from) return false;
    if (to && m.date > to) return false;
    return true;
  });

  const totalSales = sales.reduce((sum, d) => sum + safeNumber(d.grandTotal), 0);
  const totalPurchase = purchases.reduce((sum, d) => sum + safeNumber(d.total), 0);
  const totalCustomerDue = sales.reduce((sum, d) => sum + safeNumber(d.due), 0);
  const totalSupplierDue = purchases.reduce((sum, d) => sum + safeNumber(d.due), 0);
  const grossProfit = sales.reduce((sum, docObj) => {
    return sum + docObj.items.reduce((s, item) => {
      return s + (safeNumber(item.total) - safeNumber(item.buyPrice) * safeNumber(item.qty));
    }, 0);
  }, 0);

  const lowStockCount = state.products.filter((p) => safeNumber(p.stock) <= safeNumber(p.lowStock || 5)).length;

  setHtml("reportGrid", `
    <div class="metric-box"><span>মোট বিক্রি</span><strong ${moneyStyle("income")}>${formatMoney(totalSales)}</strong></div>
    <div class="metric-box"><span>মোট ক্রয়</span><strong ${moneyStyle("expense")}>${formatMoney(totalPurchase)}</strong></div>
    <div class="metric-box"><span>Gross Profit</span><strong ${moneyStyle("profitloss", grossProfit)}>${formatMoney(grossProfit)}</strong></div>
    <div class="metric-box"><span>Customer Due</span><strong ${moneyStyle("due")}>${formatMoney(totalCustomerDue)}</strong></div>
    <div class="metric-box"><span>Supplier Due</span><strong ${moneyStyle("due")}>${formatMoney(totalSupplierDue)}</strong></div>
    <div class="metric-box"><span>Low Stock Items</span><strong>${lowStockCount}</strong></div>
  `);

  const productStats = {};
  sales.forEach((docObj) => {
    docObj.items.forEach((item) => {
      if (!productStats[item.productId]) {
        productStats[item.productId] = {
          name: item.productName,
          qty: 0,
          sales: 0,
          profit: 0
        };
      }

      productStats[item.productId].qty += safeNumber(item.qty);
      productStats[item.productId].sales += safeNumber(item.total);
      productStats[item.productId].profit += safeNumber(item.total) - safeNumber(item.buyPrice) * safeNumber(item.qty);
    });
  });

  const statsArray = Object.values(productStats);
  const topSelling = [...statsArray].sort((a, b) => b.qty - a.qty).slice(0, 5);
  const topProfit = [...statsArray].sort((a, b) => b.profit - a.profit).slice(0, 5);
  const lowStock = state.products.filter((p) => safeNumber(p.stock) <= safeNumber(p.lowStock || 5)).slice(0, 8);

  setHtml("analyticsList", `
    <div class="log-item">
      <strong>Top Selling</strong><br>
      ${topSelling.length ? topSelling.map((x) => `${escapeHtml(x.name)} • ${x.qty} qty`).join("<br>") : "No data"}
    </div>
    <div class="log-item">
      <strong>Top Profit</strong><br>
      ${topProfit.length ? topProfit.map((x) => `${escapeHtml(x.name)} • <span ${moneyStyle("profitloss", x.profit)}>${formatMoney(x.profit)}</span>`).join("<br>") : "No data"}
    </div>
    <div class="log-item">
      <strong>Low Stock</strong><br>
      ${lowStock.length ? lowStock.map((x) => `${escapeHtml(x.name)} (${x.stock})`).join("<br>") : "No low stock"}
    </div>
  `);

  setHtml("movementList", moves.length
    ? moves
        .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
        .slice(0, 30)
        .map((m) => `
          <div class="log-item">
            <div><strong>${escapeHtml(m.date || "-")} • ${escapeHtml(m.type || "-")}</strong></div>
            <div>${escapeHtml(m.productName || "-")} × ${safeNumber(m.qty)}</div>
            <div>Ref: ${escapeHtml(m.refNo || "-")}</div>
            <div>${escapeHtml(m.note || "-")}</div>
          </div>
        `)
        .join("")
    : `<div class="log-item">কোনো stock movement নেই</div>`
  );

  renderActivityList();
}

/* =========================
   ACTIVITY LIST
========================= */
function renderActivityList() {
  const rows = state.activities.slice(0, 30);

  if (!rows.length) {
    setHtml("activityList", `<div class="log-item">কোনো activity নেই</div>`);
    return;
  }

  setHtml("activityList", rows.map((row) => `
    <div class="log-item">
      <div><strong>${escapeHtml(row.time)}</strong></div>
      <div>${escapeHtml(row.message)}</div>
    </div>
  `).join(""));
}

/* =========================
   NOTIFICATIONS
========================= */
function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("এই browser-এ Notification support নেই");
    return;
  }

  Notification.requestPermission().then((permission) => {
    if (permission === "granted") {
      alert("Notification চালু হয়েছে");
      notifyAlerts();
    } else {
      alert("Notification permission দেওয়া হয়নি");
    }
  });
}

function notifyAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const lowStock = state.products.filter((p) => safeNumber(p.stock) <= safeNumber(p.lowStock || 5)).length;
  const overdueSales = state.salesDocs.filter((d) => d.type === "invoice" && d.status === "Overdue").length;
  const overduePurchases = state.purchaseDocs.filter((d) => d.status === "Overdue").length;

  if (!lowStock && !overdueSales && !overduePurchases) return;

  const stamp = `${todayStr()}_${lowStock}_${overdueSales}_${overduePurchases}`;
  if (sessionStorage.getItem("store_notify_stamp") === stamp) return;
  sessionStorage.setItem("store_notify_stamp", stamp);

  new Notification("Store Alert", {
    body: `Low stock: ${lowStock}, Customer overdue: ${overdueSales}, Supplier overdue: ${overduePurchases}`
  });
}

/* =========================
   BACKUP / RESTORE / RESET
========================= */
function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    products: state.products,
    salesDocs: state.salesDocs,
    purchaseDocs: state.purchaseDocs,
    stockMoves: state.stockMoves,
    activities: state.activities,
    returns: state.returns
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sheba-store-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function restoreBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const data = JSON.parse(fr.result);

      if (!Array.isArray(data.products) || !Array.isArray(data.salesDocs) || !Array.isArray(data.purchaseDocs)) {
        return alert("Invalid backup file");
      }

      if (!confirm("Backup restore করলে বর্তমান ডাটা replace হবে। চালাবেন?")) return;

      state.products = data.products;
      state.salesDocs = data.salesDocs;
      state.purchaseDocs = data.purchaseDocs;
      state.stockMoves = Array.isArray(data.stockMoves) ? data.stockMoves : [];
      state.activities = Array.isArray(data.activities) ? data.activities : [];
      state.returns = Array.isArray(data.returns) ? data.returns : [];

      normalizeLoadedData();
      await refreshProductSignedUrls();
      addActivity("Backup restored");
      saveAll();

      if (isAppOnline()) {
        await rebuildStoreHisabMirror();
      }

      renderAll();
      resetSalesBuilder();
      resetPurchaseBuilder();

      alert("Backup restore হয়েছে");
    } catch {
      alert("Backup file পড়া যায়নি");
    } finally {
      event.target.value = "";
    }
  };

  fr.readAsText(file);
}

async function resetAllData() {
  if (!confirm("সব ডাটা delete করবেন?")) return;
  if (!confirm("এটা undo করা যাবে না। নিশ্চিত?")) return;

  state.products = [];
  state.salesDocs = [];
  state.purchaseDocs = [];
  state.stockMoves = [];
  state.activities = [];
  state.returns = [];

  saveAll();

  if (isAppOnline()) {
    await clearStoreHisabMirror();
  }

  renderAll();
  resetSalesBuilder();
  resetPurchaseBuilder();
}

/* =========================
   MODAL BACKDROP
========================= */
function handleModalBackdrop(e) {
  ["productModal", "productDetailModal", "paymentModal"].forEach((id) => {
    const modal = el(id);
    if (modal && e.target === modal) {
      if (id === "paymentModal") {
        closePaymentModal();
      } else if (id === "productModal") {
        closeProductForm();
      } else if (id === "productDetailModal") {
        closeProductDetail();
      }
    }
  });
}

/* =========================
   GLOBAL RENDER
========================= */
function renderAll() {
  renderCategoryFilter();
  renderPurchaseProductOptions();
  updateSummary();
  renderWarnings();
  renderProducts();
  renderReorderList();
  renderSalesList();
  renderPurchaseList();
  renderDueLists();
  renderReports();
  notifyAlerts();
}


async function init() {
  await resolveStoreLocalKey();

  loadLocal();

  try {
    await flushStoreQueue();
  } catch (err) {
    console.error("Initial queue flush failed:", err);
  }

  await loadCloud();
  normalizeLoadedData();
  await refreshProductSignedUrls();

  if (isAppOnline()) {
    await rebuildStoreHisabMirror();
  }

  renderReportModeFields();

  setVal("saleDate", todayStr());
  setVal("saleDueDate", todayStr());
  setVal("purchaseDate", todayStr());
  setVal("purchaseDueDate", todayStr());

  resetSalesBuilder();
  resetPurchaseBuilder();
  renderAll();

  togglePaymentMethodFields();
  updatePaymentSplitPreview();

  toggleSalePaymentFields();
  updateSaleSplitPreviewFromInputs();

  togglePurchasePaymentFields();
  updatePurchaseSplitPreviewFromInputs();

  updateProductVariantPreview();
  syncModalOpenState();

  el("paymentMethod")?.addEventListener("change", togglePaymentMethodFields);
  el("salePaymentMethod")?.addEventListener("change", toggleSalePaymentFields);
  el("purchasePaymentMethod")?.addEventListener("change", togglePurchasePaymentFields);

  [
    "paymentSplitCash",
    "paymentSplitBkash",
    "paymentSplitNagad",
    "paymentSplitRocket",
    "paymentSplitUpay",
    "paymentSplitBank",
    "paymentSplitCard"
  ].forEach((id) => {
    el(id)?.addEventListener("input", updatePaymentSplitPreview);
  });

  [
    "saleSplitCash",
    "saleSplitBkash",
    "saleSplitNagad",
    "saleSplitRocket",
    "saleSplitUpay",
    "saleSplitBank",
    "saleSplitCard"
  ].forEach((id) => {
    el(id)?.addEventListener("input", () => {
      updateSaleSplitPreviewFromInputs();
      syncSaleAmountFromSplit();
    });
  });

  [
    "purchaseSplitCash",
    "purchaseSplitBkash",
    "purchaseSplitNagad",
    "purchaseSplitRocket",
    "purchaseSplitUpay",
    "purchaseSplitBank",
    "purchaseSplitCard"
  ].forEach((id) => {
    el(id)?.addEventListener("input", () => {
      updatePurchaseSplitPreviewFromInputs();
      syncPurchaseAmountFromSplit();
    });
  });
}



document.addEventListener("click", handleModalBackdrop);
window.addEventListener("DOMContentLoaded", init);

window.addEventListener("online", async () => {
  try {
    await flushStoreQueue();
    await loadCloud();
    normalizeLoadedData();
    await refreshProductSignedUrls();
    await rebuildStoreHisabMirror();
    renderAll();
  } catch (err) {
    console.error("Online sync failed:", err);
  }
});

/* =========================
   EXPOSE
========================= */
Object.assign(window, {
  switchTab,
  renderAll,

  openProductForm,
  closeProductForm,
  handleProductImage,
  removeProductImage,
  saveProduct,
  deleteProduct,
  openProductDetail,
  closeProductDetail,
  updateProductVariantPreview,

  addSaleRow,
  removeSaleRow,
  handleSaleProductChange,
  updateSaleRow,
  updateSalesTotals,
  resetSalesBuilder,
  saveSaleDocument,
  deleteSaleDoc,
  convertQuotationToInvoice,
  returnFromInvoice,

  resetPurchaseBuilder,
  fillPurchaseCost,
  savePurchaseDocument,
  deletePurchaseDoc,

  openPaymentModal,
  closePaymentModal,
  savePayment,
  markFullPaidSale,
  markFullPaidPurchase,
  togglePaymentMethodFields,
  updatePaymentSplitPreview,

  toggleSalePaymentFields,
  updateSaleSplitPreviewFromInputs,
  syncSaleAmountFromSplit,

  togglePurchasePaymentFields,
  updatePurchaseSplitPreviewFromInputs,
  syncPurchaseAmountFromSplit,

  renderDueLists,
  quickAddCustomerPayment,
  quickAddSupplierPayment,
  markCustomerGroupFullPaid,
  markSupplierGroupFullPaid,
  openCustomerHistoryByKey,
  openCustomerHistoryByDoc,
  openSupplierHistoryByKey,
  openSupplierHistoryByDoc,

  renderReportModeFields,
  renderReports,

  exportBackup,
  restoreBackup,
  resetAllData,
  requestNotificationPermission
});