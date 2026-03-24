import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

import {
  loadTruckCloudData,
  saveTruckCloudData,
  getEmptyTruckData
} from "./truck-cloud.js";

import {
  upsertHishabSyncEntry,
  deleteHishabSyncEntry
} from "./hishab-bridge.js";

import {
  addSyncTask,
  isAppOnline
} from "./offline-queue.js";

import { flushTruckQueue } from "./truck-sync.js";

let TRUCK_NS = "default_user";
let TRUCK_KEY = "shebaTruck_default_user";

function makeSafeTruckUserKey(value) {
  return String(value || "default_user")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]@]/g, "_");
}

function makeLegacyTruckNs(userData) {
  return String(
    userData?.username || userData?.email || "default_user"
  ).replace(/[.#$/\[\]]/g, "_");
}

function copyOldTruckDataIfNeeded(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;

  const oldValue = localStorage.getItem(oldKey);
  const newValue = localStorage.getItem(newKey);

  if (!newValue && oldValue) {
    localStorage.setItem(newKey, oldValue);
  }
}

async function resolveTruckStorageKey() {
  let authUser = null;
  let localUser = null;

  try {
    const authRes = await getCurrentUser();
    authUser = authRes?.user || null;
  } catch (err) {
    authUser = null;
  }

  try {
    localUser = JSON.parse(localStorage.getItem("loggedInUser") || "null");
  } catch (err) {
    localUser = null;
  }

  const identity =
    authUser?.email ||
    localUser?.email ||
    localUser?.username ||
    "default_user";

  TRUCK_NS = makeSafeTruckUserKey(identity);
  TRUCK_KEY = `shebaTruck_${TRUCK_NS}`;

  const legacyNs = makeLegacyTruckNs(localUser || authUser || {});
  const OLD_TRUCK_KEY = `shebaTruck_${legacyNs}`;

  copyOldTruckDataIfNeeded(OLD_TRUCK_KEY, TRUCK_KEY);

  return {
    authUser,
    localUser
  };
}

let currentTruckId = null;
let editingTruckId = null;
let editingTruckIncomeId = null;
let editingTruckExpenseId = null;
let currentTruckTab = "income";
let truckChart = null;
let detailTruckChart = null;

let lastTruckReportData = {
  income: 0,
  expense: 0,
  balance: 0,
  trips: 0,
  label: "রিপোর্ট"
};

let lastTruckDetailReportData = {
  income: 0,
  expense: 0,
  balance: 0,
  trips: 0,
  label: "এই ট্রাকের রিপোর্ট"
};

const PAYMENT_METHODS = ["Cash", "bKash", "Nagad", "Rocket", "Upay", "Bank", "Card"];

/* =========================
   LOCAL + CLOUD STORAGE
========================= */
function readTruckArray(keyName) {
  try {
    const raw = localStorage.getItem(keyName);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getTrucks() {
  return readTruckArray(TRUCK_KEY);
}

function getTruckPayload() {
  return { trucks: getTrucks() };
}

function queueTruckSave() {
  addSyncTask({
    module: "truck",
    action: "save_full_state",
    payload: getTruckPayload()
  });
}

async function saveTruckCloud() {
  await saveTruckCloudData(getTruckPayload());
}

function saveTrucks(trucks) {
  localStorage.setItem(TRUCK_KEY, JSON.stringify(trucks));
  localStorage.setItem("truckCountCache", String(trucks.length));

  if (!isAppOnline()) {
    queueTruckSave();
    return;
  }

  saveTruckCloud().catch((err) => {
    console.error("Truck cloud save failed:", err);
    queueTruckSave();
  });
}

async function loadTruckCloudToLocal() {
  try {
    const localTrucks = getTrucks();
    const data = await loadTruckCloudData();
    const finalData = data || getEmptyTruckData();
    const cloudTrucks = Array.isArray(finalData.trucks) ? finalData.trucks : [];

    const trucksToUse = cloudTrucks.length ? cloudTrucks : localTrucks;

    localStorage.setItem(TRUCK_KEY, JSON.stringify(trucksToUse));
    localStorage.setItem("truckCountCache", String(trucksToUse.length));
  } catch (err) {
    console.error("Truck cloud load failed:", err);
  }
}

/* =========================
   AUTH + HISHAB SYNC
========================= */
async function getAuthUserId() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }

  return user.id;
}

function makeTruckIncomeHisabPayload(truck, item) {
  const paymentMethod = item.paymentMethod || "Cash";
  const splitText = paymentMethod === "Mixed"
    ? ` | Split: ${formatPaymentSplitInline(item.paymentSplit)}`
    : ` | Payment: ${paymentMethod}`;

  return {
    module_name: "truck",
    entry_type: "income",
    source_table: "truck_income",
    source_id: item.id,
    entry_date: item.date || new Date().toISOString().slice(0, 10),
    party_name: truck?.number || truck?.route || "Truck Income",
    category: "Truck Trip Income",
    total_amount: Number(item.amount || 0),
    paid_amount: Number(item.amount || 0),
    due_amount: 0,
    payment_method: paymentMethod,
    note: `${Number(item.trips || 0)} ট্রিপ${truck?.route ? ` | Route: ${truck.route}` : ""}${splitText}`
  };
}

function makeTruckExpenseHisabPayload(truck, item) {
  const total = getExpenseTotal(item);
  const paymentMethod = item.paymentMethod || "Cash";
  const splitText = paymentMethod === "Mixed"
    ? ` | Split: ${formatPaymentSplitInline(item.paymentSplit)}`
    : ` | Payment: ${paymentMethod}`;

  return {
    module_name: "truck",
    entry_type: "expense",
    source_table: "truck_expense",
    source_id: item.id,
    entry_date: item.date || new Date().toISOString().slice(0, 10),
    party_name: truck?.number || truck?.route || "Truck Expense",
    category: "Truck Expense",
    total_amount: Number(total || 0),
    paid_amount: Number(total || 0),
    due_amount: 0,
    payment_method: paymentMethod,
    note:
      `${item.note || ""}${item.note ? " | " : ""}ডিজেল: ${Number(item.diesel || 0)}, মেরামত: ${Number(item.repair || 0)}, ড্রাইভার: ${Number(item.driverSalary || 0)}, অন্যান্য: ${Number(item.other || 0)}${splitText}`
  };
}

async function syncTruckIncomeToHishab(truck, item) {
  if (!truck || !item || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeTruckIncomeHisabPayload(truck, item));
  } catch (err) {
    console.error("Truck income -> hishab sync failed:", err);
  }
}

async function syncTruckExpenseToHishab(truck, item) {
  if (!truck || !item || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeTruckExpenseHisabPayload(truck, item));
  } catch (err) {
    console.error("Truck expense -> hishab sync failed:", err);
  }
}

async function removeTruckIncomeFromHishab(incomeId) {
  if (!incomeId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("truck_income", incomeId);
  } catch (err) {
    console.error("Truck income -> hishab delete failed:", err);
  }
}

async function removeTruckExpenseFromHishab(expenseId) {
  if (!expenseId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("truck_expense", expenseId);
  } catch (err) {
    console.error("Truck expense -> hishab delete failed:", err);
  }
}

async function clearTruckHisabMirror() {
  if (!isAppOnline()) return;

  try {
    const userId = await getAuthUserId();

    const { error } = await supabase
      .from("hisab_entries")
      .delete()
      .eq("user_id", userId)
      .in("source_table", ["truck_income", "truck_expense"]);

    if (error) throw error;
  } catch (err) {
    console.error("Clear truck hishab mirror failed:", err);
  }
}

async function rebuildTruckHisabMirror() {
  if (!isAppOnline()) return;

  try {
    await clearTruckHisabMirror();

    const trucks = getTrucks();

    for (const truck of trucks) {
      for (const income of truck.incomes || []) {
        await syncTruckIncomeToHishab(truck, income);
      }

      for (const expense of truck.expenses || []) {
        await syncTruckExpenseToHishab(truck, expense);
      }
    }
  } catch (err) {
    console.error("Truck hishab rebuild failed:", err);
  }
}

/* =========================
   HELPERS
========================= */
function formatMoney(value) {
  return "৳" + Number(value || 0).toLocaleString("en-US");
}

function clearAmountClasses(el) {
  if (!el) return;
  el.classList.remove(
    "income-color",
    "expense-color",
    "profit-color",
    "loss-color",
    "income",
    "expense",
    "profit",
    "loss"
  );
}

function setAmountColor(el, type, value = 0) {
  if (!el) return;

  clearAmountClasses(el);
  el.style.removeProperty("color");

  let className = "";
  let color = "";

  if (type === "income") {
    className = "income-color";
    color = "#22c55e";
  } else if (type === "expense") {
    className = "expense-color";
    color = "#ef4444";
  } else {
    const isProfit = Number(value) >= 0;
    className = isProfit ? "profit-color" : "loss-color";
    color = isProfit ? "#22c55e" : "#ef4444";
  }

  el.classList.add(className);
  el.style.setProperty("color", color, "important");
}

function generateTruckId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function goTruckDashboard() {
  window.location.href = "dashboard.html";
}

function setTodayValue(inputId) {
  const today = new Date().toISOString().split("T")[0];
  const el = document.getElementById(inputId);
  if (el) el.value = today;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getDaysLeft(dateString) {
  if (!dateString) return null;

  const today = new Date();
  const target = new Date(dateString);

  if (isNaN(target.getTime())) return null;

  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);

  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

function getExpenseTotal(item) {
  return (
    Number(item.diesel || 0) +
    Number(item.repair || 0) +
    Number(item.driverSalary || 0) +
    Number(item.other || 0)
  );
}

function getTruckTotals(truck) {
  const totalIncome = (truck.incomes || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalExpense = (truck.expenses || []).reduce((sum, item) => sum + getExpenseTotal(item), 0);

  return {
    income: totalIncome,
    expense: totalExpense,
    balance: totalIncome - totalExpense
  };
}

function getAllTruckTotals(trucks) {
  let income = 0;
  let expense = 0;

  trucks.forEach((truck) => {
    const totals = getTruckTotals(truck);
    income += totals.income;
    expense += totals.expense;
  });

  return {
    income,
    expense,
    balance: income - expense
  };
}

function formatPaymentSplitInline(split = {}) {
  const entries = Object.entries(split || {}).filter(([, amount]) => Number(amount || 0) > 0);
  if (!entries.length) return "";
  return entries.map(([method, amount]) => `${method}: ${formatMoney(amount)}`).join(", ");
}

function sanitizePaymentSplit(split = {}) {
  const clean = {};
  Object.entries(split || {}).forEach(([method, amount]) => {
    const num = Number(amount || 0);
    if (num > 0) clean[method] = num;
  });
  return clean;
}

function getSplitInputMap(prefix) {
  return {
    Cash: document.getElementById(`${prefix}SplitCash`),
    bKash: document.getElementById(`${prefix}SplitBkash`),
    Nagad: document.getElementById(`${prefix}SplitNagad`),
    Rocket: document.getElementById(`${prefix}SplitRocket`),
    Upay: document.getElementById(`${prefix}SplitUpay`),
    Bank: document.getElementById(`${prefix}SplitBank`),
    Card: document.getElementById(`${prefix}SplitCard`)
  };
}

function readSplitValues(prefix) {
  const map = getSplitInputMap(prefix);
  const data = {};
  PAYMENT_METHODS.forEach((method) => {
    data[method] = Number(map[method]?.value || 0);
  });
  return sanitizePaymentSplit(data);
}

function writeSplitValues(prefix, split = {}) {
  const map = getSplitInputMap(prefix);
  PAYMENT_METHODS.forEach((method) => {
    if (map[method]) map[method].value = split[method] || "";
  });
}

function clearSplitValues(prefix) {
  const map = getSplitInputMap(prefix);
  PAYMENT_METHODS.forEach((method) => {
    if (map[method]) map[method].value = "";
  });
}

function sumSplitValues(split = {}) {
  return Object.values(split || {}).reduce((sum, val) => sum + Number(val || 0), 0);
}

function syncSheetOpenState() {
  const sheetIds = ["truckFormSheet", "truckIncomeSheet", "truckExpenseSheet"];
  const anyOpen = sheetIds.some((id) =>
    document.getElementById(id)?.classList.contains("show")
  );

  document.documentElement.classList.toggle("sheet-open", anyOpen);
  document.body.classList.toggle("sheet-open", anyOpen);
}

function openSheet(sheetId) {
  document.getElementById(sheetId)?.classList.add("show");
  syncSheetOpenState();
}

function closeSheet(sheetId) {
  document.getElementById(sheetId)?.classList.remove("show");
  syncSheetOpenState();
}

function setButtonLoading(button, loadingText, isLoading) {
  if (!button) return;

  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.innerText;
  }

  button.disabled = isLoading;
  button.innerText = isLoading ? loadingText : button.dataset.defaultText;
}

/* =========================
   PAYMENT METHOD UI
========================= */
function toggleTruckIncomePaymentMethod() {
  const method = document.getElementById("incomePaymentMethod")?.value || "Cash";
  const wrap = document.getElementById("incomeMixedSplitWrap");
  if (!wrap) return;

  wrap.classList.toggle("hidden", method !== "Mixed");
  updateTruckIncomeSplitPreview();
}

function toggleTruckExpensePaymentMethod() {
  const method = document.getElementById("expensePaymentMethod")?.value || "Cash";
  const wrap = document.getElementById("expenseMixedSplitWrap");
  if (!wrap) return;

  wrap.classList.toggle("hidden", method !== "Mixed");
  updateTruckExpenseSplitPreview();
}

function updateTruckIncomeSplitPreview() {
  const total = sumSplitValues(readSplitValues("income"));
  const totalEl = document.getElementById("incomeSplitTotal");
  if (totalEl) totalEl.innerText = formatMoney(total);
}

function updateTruckExpenseSplitPreview() {
  const total = sumSplitValues(readSplitValues("expense"));
  const totalEl = document.getElementById("expenseSplitTotal");
  if (totalEl) totalEl.innerText = formatMoney(total);
}

/* =========================
   SEARCH + SORT
========================= */
function getFilteredTrucks() {
  const trucks = getTrucks();
  const search = document.getElementById("truckSearch")?.value?.trim().toLowerCase() || "";
  const sort = document.getElementById("truckSort")?.value || "latest";

  const filtered = trucks.filter((truck) =>
    (truck.number || "").toLowerCase().includes(search) ||
    (truck.route || "").toLowerCase().includes(search) ||
    (truck.model || "").toLowerCase().includes(search)
  );

  filtered.sort((a, b) => {
    const aTotals = getTruckTotals(a);
    const bTotals = getTruckTotals(b);

    if (sort === "income") return bTotals.income - aTotals.income;
    if (sort === "expense") return bTotals.expense - aTotals.expense;
    if (sort === "profit") return bTotals.balance - aTotals.balance;
    if (sort === "number") return (a.number || "").localeCompare(b.number || "");

    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  return filtered;
}

/* =========================
   TOP SUMMARY
========================= */
function renderTruckTopSummary() {
  const trucks = getTrucks();
  const totals = getAllTruckTotals(trucks);

  const truckCountEl = document.getElementById("summaryTruckCount");
  const incomeEl = document.getElementById("summaryIncome");
  const expenseEl = document.getElementById("summaryExpense");
  const profitEl = document.getElementById("summaryProfit");
  const countText = document.getElementById("truckCountText");

  if (truckCountEl) truckCountEl.innerText = trucks.length;
  if (countText) countText.innerText = trucks.length;

  if (incomeEl) {
    incomeEl.innerText = formatMoney(totals.income);
    setAmountColor(incomeEl, "income");
  }

  if (expenseEl) {
    expenseEl.innerText = formatMoney(totals.expense);
    setAmountColor(expenseEl, "expense");
  }

  if (profitEl) {
    profitEl.innerText = formatMoney(Math.abs(totals.balance));
    setAmountColor(profitEl, "profitloss", totals.balance);
  }
}

/* =========================
   WARNING CARD
========================= */
function renderTruckWarningCard() {
  const trucks = getTrucks();
  const warningCard = document.getElementById("warningCard");
  const warningList = document.getElementById("warningList");

  if (!warningCard || !warningList) return;

  const warnings = [];

  trucks.forEach((truck) => {
    const fitness = getDaysLeft(truck.fitness);
    const tax = getDaysLeft(truck.tax);

    if (fitness !== null && fitness <= 30) {
      warnings.push(
        `${truck.number || "Unknown"} - Fitness ${fitness < 0 ? "মেয়াদ শেষ" : `${fitness} দিনের মধ্যে শেষ`}`
      );
    }

    if (tax !== null && tax <= 30) {
      warnings.push(
        `${truck.number || "Unknown"} - Tax ${tax < 0 ? "মেয়াদ শেষ" : `${tax} দিনের মধ্যে শেষ`}`
      );
    }
  });

  if (!warnings.length) {
    warningCard.classList.add("hidden");
    warningList.innerHTML = "";
    return;
  }

  warningCard.classList.remove("hidden");
  warningList.innerHTML = warnings.map((item) => `<div>${escapeHtml(item)}</div>`).join("");
}

/* =========================
   MONTH / YEAR OPTIONS
========================= */
function getMonthOptions(selected = "") {
  const months = [
    { v: "0", t: "জানুয়ারি" },
    { v: "1", t: "ফেব্রুয়ারি" },
    { v: "2", t: "মার্চ" },
    { v: "3", t: "এপ্রিল" },
    { v: "4", t: "মে" },
    { v: "5", t: "জুন" },
    { v: "6", t: "জুলাই" },
    { v: "7", t: "আগস্ট" },
    { v: "8", t: "সেপ্টেম্বর" },
    { v: "9", t: "অক্টোবর" },
    { v: "10", t: "নভেম্বর" },
    { v: "11", t: "ডিসেম্বর" }
  ];

  return months
    .map((m) => `<option value="${m.v}" ${String(selected) === m.v ? "selected" : ""}>${m.t}</option>`)
    .join("");
}

function getYearOptions(selected = "") {
  const currentYear = new Date().getFullYear();
  let html = "";

  for (let y = currentYear - 5; y <= currentYear + 5; y++) {
    html += `<option value="${y}" ${String(selected) === String(y) ? "selected" : ""}>${y}</option>`;
  }

  return html;
}

/* =========================
   MAIN REPORT MODE
========================= */
function handleTruckReportModeChange() {
  const mode = document.getElementById("reportMode")?.value;
  const wrap = document.getElementById("reportDynamicFields");
  if (!wrap) return;

  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();
  const month = new Date().getMonth();

  if (mode === "monthYear") {
    wrap.innerHTML = `
      <select id="reportMonth" class="report-filter">${getMonthOptions(String(month))}</select>
      <select id="reportYear" class="report-filter">${getYearOptions(String(year))}</select>
    `;
  } else if (mode === "yearOnly") {
    wrap.innerHTML = `
      <select id="reportYearOnly" class="report-filter">${getYearOptions(String(year))}</select>
      <div></div>
    `;
  } else if (mode === "singleDate") {
    wrap.innerHTML = `
      <input id="reportSingleDate" class="report-input" type="date" value="${today}">
      <div></div>
    `;
  } else if (mode === "dateRange") {
    wrap.innerHTML = `
      <input id="reportFromDate" class="report-input" type="date" value="${today}">
      <input id="reportToDate" class="report-input" type="date" value="${today}">
    `;
  }
}

function handleTruckDetailReportMode() {
  const mode = document.getElementById("detailReportMode")?.value;
  const wrap = document.getElementById("detailReportFields");
  if (!wrap) return;

  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();
  const month = new Date().getMonth();

  if (mode === "monthYear") {
    wrap.innerHTML = `
      <select id="detailMonth" class="report-filter">${getMonthOptions(String(month))}</select>
      <select id="detailYear" class="report-filter">${getYearOptions(String(year))}</select>
    `;
  } else if (mode === "yearOnly") {
    wrap.innerHTML = `
      <select id="detailYearOnly" class="report-filter">${getYearOptions(String(year))}</select>
      <div></div>
    `;
  } else if (mode === "singleDate") {
    wrap.innerHTML = `
      <input id="detailSingleDate" class="report-input" type="date" value="${today}">
      <div></div>
    `;
  } else if (mode === "dateRange") {
    wrap.innerHTML = `
      <input id="detailFromDate" class="report-input" type="date" value="${today}">
      <input id="detailToDate" class="report-input" type="date" value="${today}">
    `;
  }
}

/* =========================
   SMART ANALYTICS
========================= */
function getCurrentTruckMonthData() {
  const trucks = getTrucks();
  const now = new Date();

  let income = 0;
  let expense = 0;

  trucks.forEach((truck) => {
    (truck.incomes || []).forEach((item) => {
      const d = new Date(item.date);
      if (!isNaN(d.getTime()) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        income += Number(item.amount || 0);
      }
    });

    (truck.expenses || []).forEach((item) => {
      const d = new Date(item.date);
      if (!isNaN(d.getTime()) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        expense += getExpenseTotal(item);
      }
    });
  });

  return { income, expense };
}

function calculateTruckPrediction() {
  const trucks = getTrucks();
  const monthlyMap = {};

  trucks.forEach((truck) => {
    (truck.incomes || []).forEach((item) => {
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return;
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!monthlyMap[key]) monthlyMap[key] = 0;
      monthlyMap[key] += Number(item.amount || 0);
    });
  });

  const values = Object.values(monthlyMap);
  if (!values.length) return 0;

  const lastThree = values.slice(-3);
  const total = lastThree.reduce((sum, v) => sum + v, 0);

  return Math.round(total / lastThree.length);
}

function getBestTruck() {
  const trucks = getTrucks();
  if (!trucks.length) return "-";

  let bestTruck = null;
  let bestIncome = -1;

  trucks.forEach((truck) => {
    const totals = getTruckTotals(truck);
    if (totals.income > bestIncome) {
      bestIncome = totals.income;
      bestTruck = truck;
    }
  });

  return bestTruck ? bestTruck.number : "-";
}

function getTruckSmartAlertMessage() {
  const trucks = getTrucks();
  const alerts = [];

  trucks.forEach((truck) => {
    const totals = getTruckTotals(truck);
    const fitness = getDaysLeft(truck.fitness);
    const tax = getDaysLeft(truck.tax);

    if (fitness !== null && fitness <= 7) alerts.push(`${truck.number} fitness urgent`);
    if (tax !== null && tax <= 7) alerts.push(`${truck.number} tax urgent`);
    if (totals.balance < 0) alerts.push(`${truck.number} loss চলছে`);
  });

  if (!alerts.length) return "সব সিস্টেম ঠিক আছে";
  return alerts.slice(0, 3).join(" | ");
}

function renderTruckSmartAnalytics() {
  const prediction = calculateTruckPrediction();
  const bestTruck = getBestTruck();
  const monthData = getCurrentTruckMonthData();
  const alertText = getTruckSmartAlertMessage();

  const aiPredictionIncome = document.getElementById("aiPredictionIncome");
  const bestTruckNumber = document.getElementById("bestTruckNumber");
  const monthlySummaryIncome = document.getElementById("monthlySummaryIncome");
  const monthlySummaryExpense = document.getElementById("monthlySummaryExpense");
  const smartAlertText = document.getElementById("smartAlertText");

  if (aiPredictionIncome) {
    aiPredictionIncome.innerText = formatMoney(prediction);
    setAmountColor(aiPredictionIncome, "income");
  }

  if (bestTruckNumber) {
    bestTruckNumber.innerText = bestTruck;
    bestTruckNumber.style.setProperty("color", "#22c55e", "important");
  }

  if (monthlySummaryIncome) {
    monthlySummaryIncome.innerText = formatMoney(monthData.income);
    setAmountColor(monthlySummaryIncome, "income");
  }

  if (monthlySummaryExpense) {
    monthlySummaryExpense.innerText = formatMoney(monthData.expense);
    setAmountColor(monthlySummaryExpense, "expense");
  }

  if (smartAlertText) {
    smartAlertText.innerText = alertText;
    smartAlertText.style.setProperty(
      "color",
      alertText.toLowerCase().includes("loss") || alertText.toLowerCase().includes("urgent") ? "#ef4444" : "#ffffff",
      "important"
    );
  }
}

/* =========================
   CHARTS
========================= */
function renderTruckChart(reportData) {
  const canvas = document.getElementById("truckChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (truckChart) truckChart.destroy();

  truckChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["আয়", "ব্যয়", "লাভ/ক্ষতি"],
      datasets: [
        {
          label: "Truck Report",
          data: [reportData.income, reportData.expense, Math.abs(reportData.balance)],
          backgroundColor: [
            "#22c55e",
            "#ef4444",
            reportData.balance >= 0 ? "#22c55e" : "#ef4444"
          ],
          borderColor: [
            "#22c55e",
            "#ef4444",
            reportData.balance >= 0 ? "#22c55e" : "#ef4444"
          ],
          borderRadius: 12,
          barThickness: 34
        }
      ]
    },
    options: {
      responsive: true,
      animation: { duration: 1200, easing: "easeOutQuart" },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#cfe2ff" },
          grid: { color: "rgba(255,255,255,.06)" }
        },
        y: {
          ticks: { color: "#cfe2ff" },
          grid: { color: "rgba(255,255,255,.06)" }
        }
      }
    }
  });
}

function renderTruckDetailChart(reportData) {
  const canvas = document.getElementById("detailTruckChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (detailTruckChart) detailTruckChart.destroy();

  detailTruckChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["আয়", "ব্যয়"],
      datasets: [
        {
          data: [reportData.income, reportData.expense],
          backgroundColor: ["#22c55e", "#ef4444"],
          hoverOffset: 12
        }
      ]
    },
    options: {
      responsive: true,
      animation: { duration: 1200, easing: "easeOutExpo" },
      plugins: {
        legend: { labels: { color: "#ffffff" } }
      }
    }
  });
}

/* =========================
   MAIN REPORT
========================= */
function applyAdvancedTruckReport() {
  const mode = document.getElementById("reportMode")?.value;
  const trucks = getTrucks();
  if (!mode) return;

  let income = 0;
  let expense = 0;
  let trips = 0;
  let label = "";

  trucks.forEach((truck) => {
    (truck.incomes || []).forEach((item) => {
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return;

      if (mode === "monthYear") {
        const m = Number(document.getElementById("reportMonth")?.value);
        const y = Number(document.getElementById("reportYear")?.value);
        if (d.getMonth() === m && d.getFullYear() === y) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }

      if (mode === "yearOnly") {
        const y = Number(document.getElementById("reportYearOnly")?.value);
        if (d.getFullYear() === y) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }

      if (mode === "singleDate") {
        const target = document.getElementById("reportSingleDate")?.value;
        if (item.date === target) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }

      if (mode === "dateRange") {
        const from = new Date(document.getElementById("reportFromDate")?.value);
        const to = new Date(document.getElementById("reportToDate")?.value);
        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);
        if (d >= from && d <= to) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }
    });

    (truck.expenses || []).forEach((item) => {
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return;

      if (mode === "monthYear") {
        const m = Number(document.getElementById("reportMonth")?.value);
        const y = Number(document.getElementById("reportYear")?.value);
        if (d.getMonth() === m && d.getFullYear() === y) expense += getExpenseTotal(item);
      }

      if (mode === "yearOnly") {
        const y = Number(document.getElementById("reportYearOnly")?.value);
        if (d.getFullYear() === y) expense += getExpenseTotal(item);
      }

      if (mode === "singleDate") {
        const target = document.getElementById("reportSingleDate")?.value;
        if (item.date === target) expense += getExpenseTotal(item);
      }

      if (mode === "dateRange") {
        const from = new Date(document.getElementById("reportFromDate")?.value);
        const to = new Date(document.getElementById("reportToDate")?.value);
        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);
        if (d >= from && d <= to) expense += getExpenseTotal(item);
      }
    });
  });

  if (mode === "monthYear") {
    const monthEl = document.getElementById("reportMonth");
    const yearEl = document.getElementById("reportYear");
    if (monthEl && yearEl) label = `${monthEl.selectedOptions[0].textContent} ${yearEl.value}`;
  } else if (mode === "yearOnly") {
    const yearOnlyEl = document.getElementById("reportYearOnly");
    if (yearOnlyEl) label = `${yearOnlyEl.value} সালের রিপোর্ট`;
  } else if (mode === "singleDate") {
    const singleDateEl = document.getElementById("reportSingleDate");
    if (singleDateEl) label = `${singleDateEl.value} তারিখের রিপোর্ট`;
  } else if (mode === "dateRange") {
    const fromEl = document.getElementById("reportFromDate");
    const toEl = document.getElementById("reportToDate");
    if (fromEl && toEl) label = `${fromEl.value} থেকে ${toEl.value}`;
  }

  const balance = income - expense;

  const reportLabelEl = document.getElementById("reportLabel");
  const reportIncomeEl = document.getElementById("reportIncome");
  const reportExpenseEl = document.getElementById("reportExpense");
  const reportTripsEl = document.getElementById("reportTrips");
  const balanceEl = document.getElementById("reportBalance");

  if (reportLabelEl) reportLabelEl.innerText = label;

  if (reportIncomeEl) {
    reportIncomeEl.innerText = formatMoney(income);
    setAmountColor(reportIncomeEl, "income");
  }

  if (reportExpenseEl) {
    reportExpenseEl.innerText = formatMoney(expense);
    setAmountColor(reportExpenseEl, "expense");
  }

  if (reportTripsEl) reportTripsEl.innerText = trips;

  if (balanceEl) {
    balanceEl.innerText = formatMoney(Math.abs(balance));
    setAmountColor(balanceEl, "profitloss", balance);
  }

  lastTruckReportData = { income, expense, balance, trips, label };
  renderTruckChart(lastTruckReportData);
}

/* =========================
   DETAIL REPORT
========================= */
function applyTruckDetailReport() {
  const truck = getTrucks().find((t) => t.id === currentTruckId);
  if (!truck) return;

  const mode = document.getElementById("detailReportMode")?.value;
  if (!mode) return;

  let income = 0;
  let expense = 0;
  let trips = 0;
  let label = "";

  (truck.incomes || []).forEach((item) => {
    const d = new Date(item.date);
    if (isNaN(d.getTime())) return;

    if (mode === "monthYear") {
      const m = Number(document.getElementById("detailMonth")?.value);
      const y = Number(document.getElementById("detailYear")?.value);
      if (d.getMonth() === m && d.getFullYear() === y) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }

    if (mode === "yearOnly") {
      const y = Number(document.getElementById("detailYearOnly")?.value);
      if (d.getFullYear() === y) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }

    if (mode === "singleDate") {
      const target = document.getElementById("detailSingleDate")?.value;
      if (item.date === target) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }

    if (mode === "dateRange") {
      const from = new Date(document.getElementById("detailFromDate")?.value);
      const to = new Date(document.getElementById("detailToDate")?.value);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      if (d >= from && d <= to) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }
  });

  (truck.expenses || []).forEach((item) => {
    const d = new Date(item.date);
    if (isNaN(d.getTime())) return;

    if (mode === "monthYear") {
      const m = Number(document.getElementById("detailMonth")?.value);
      const y = Number(document.getElementById("detailYear")?.value);
      if (d.getMonth() === m && d.getFullYear() === y) expense += getExpenseTotal(item);
    }

    if (mode === "yearOnly") {
      const y = Number(document.getElementById("detailYearOnly")?.value);
      if (d.getFullYear() === y) expense += getExpenseTotal(item);
    }

    if (mode === "singleDate") {
      const target = document.getElementById("detailSingleDate")?.value;
      if (item.date === target) expense += getExpenseTotal(item);
    }

    if (mode === "dateRange") {
      const from = new Date(document.getElementById("detailFromDate")?.value);
      const to = new Date(document.getElementById("detailToDate")?.value);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      if (d >= from && d <= to) expense += getExpenseTotal(item);
    }
  });

  if (mode === "monthYear") {
    const monthEl = document.getElementById("detailMonth");
    const yearEl = document.getElementById("detailYear");
    if (monthEl && yearEl) label = `${monthEl.selectedOptions[0].textContent} ${yearEl.value}`;
  } else if (mode === "yearOnly") {
    const yearOnlyEl = document.getElementById("detailYearOnly");
    if (yearOnlyEl) label = `${yearOnlyEl.value} সালের রিপোর্ট`;
  } else if (mode === "singleDate") {
    const singleDateEl = document.getElementById("detailSingleDate");
    if (singleDateEl) label = `${singleDateEl.value} তারিখের রিপোর্ট`;
  } else if (mode === "dateRange") {
    const fromEl = document.getElementById("detailFromDate");
    const toEl = document.getElementById("detailToDate");
    if (fromEl && toEl) label = `${fromEl.value} থেকে ${toEl.value}`;
  }

  const balance = income - expense;

  const labelEl = document.getElementById("detailReportLabel");
  const incomeEl = document.getElementById("detailReportIncome");
  const expenseEl = document.getElementById("detailReportExpense");
  const tripsEl = document.getElementById("detailReportTrips");
  const balanceEl = document.getElementById("detailReportBalance");

  if (labelEl) labelEl.innerText = label;

  if (incomeEl) {
    incomeEl.innerText = formatMoney(income);
    setAmountColor(incomeEl, "income");
  }

  if (expenseEl) {
    expenseEl.innerText = formatMoney(expense);
    setAmountColor(expenseEl, "expense");
  }

  if (tripsEl) tripsEl.innerText = trips;

  if (balanceEl) {
    balanceEl.innerText = formatMoney(Math.abs(balance));
    setAmountColor(balanceEl, "profitloss", balance);
  }

  lastTruckDetailReportData = { income, expense, balance, trips, label };
  renderTruckDetailChart(lastTruckDetailReportData);
}

/* =========================
   LIST RENDER
========================= */
function renderTruckList() {
  const trucks = getFilteredTrucks();
  const allTrucks = getTrucks();
  const truckList = document.getElementById("truckList");
  const emptyState = document.getElementById("emptyTruckState");

  renderTruckTopSummary();
  renderTruckWarningCard();

  if (!truckList || !emptyState) return;

  if (!allTrucks.length) {
    emptyState.classList.remove("hidden");
    truckList.innerHTML = "";
    return;
  }

  emptyState.classList.add("hidden");

  if (!trucks.length) {
    truckList.innerHTML = `
      <div class="empty-state-truck" style="min-height:220px;">
        <div class="empty-truck-icon" style="font-size:54px;">🔎</div>
        <h3 style="font-size:20px;">কোনো ফলাফল নেই</h3>
        <p>Search বা sort পরিবর্তন করুন</p>
      </div>
    `;
    return;
  }

  truckList.innerHTML = trucks
    .map((truck, index) => {
      const totals = getTruckTotals(truck);
      const isProfit = totals.balance >= 0;
      const profitClass = isProfit ? "profit-color" : "loss-color";
      const fitnessLeft = getDaysLeft(truck.fitness);
      const taxLeft = getDaysLeft(truck.tax);

      let chips = "";

      if ((truck.status || "Running") === "Running") {
        chips += `<span class="status-chip status-running">Running</span>`;
      } else if ((truck.status || "") === "Maintenance") {
        chips += `<span class="status-chip status-maintenance">Maintenance</span>`;
      } else {
        chips += `<span class="status-chip status-inactive">Inactive</span>`;
      }

      if (fitnessLeft !== null && fitnessLeft <= 15) {
        chips += `<span class="status-chip status-warning">Fitness ${fitnessLeft < 0 ? "Expired" : `${fitnessLeft} দিন`}</span>`;
      }

      if (taxLeft !== null && taxLeft <= 15) {
        chips += `<span class="status-chip status-warning">Tax ${taxLeft < 0 ? "Expired" : `${taxLeft} দিন`}</span>`;
      }

      return `
        <div class="compact-bus-card" onclick="openTruckDetail('${truck.id}')">
          <div class="compact-bus-top">
            <div class="compact-bus-left">
              <div class="compact-bus-icon">🚚</div>

              <div class="compact-bus-meta">
                <div class="compact-bus-number">${index + 1}. ${escapeHtml(truck.number || "-")}</div>
                <div class="compact-bus-route">${escapeHtml(truck.route || "")}</div>
                <div class="compact-bus-badges">${chips}</div>
              </div>
            </div>

            <div class="compact-bus-actions" onclick="event.stopPropagation()">
              <button class="compact-action-btn" onclick="openEditTruck('${truck.id}')">✎</button>
              <button class="compact-action-btn" onclick="deleteTruck('${truck.id}')">🗑</button>
            </div>
          </div>

          <div class="compact-bus-stats">
            <div class="compact-stat">
              <span>আয়</span>
              <strong class="income-color">${formatMoney(totals.income)}</strong>
            </div>

            <div class="compact-stat">
              <span>ব্যয়</span>
              <strong class="expense-color">${formatMoney(totals.expense)}</strong>
            </div>

            <div class="compact-stat">
              <span>${isProfit ? "লাভ" : "ক্ষতি"}</span>
              <strong class="${profitClass}">${formatMoney(Math.abs(totals.balance))}</strong>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

/* =========================
   TRUCK FORM
========================= */
function resetTruckForm() {
  editingTruckId = null;

  const titleEl = document.getElementById("truckFormTitle");
  if (titleEl) titleEl.innerText = "নতুন ট্রাক";

  [
    "truckNumber",
    "truckModel",
    "truckRoute",
    "truckReg",
    "truckFitness",
    "truckTax",
    "driverName",
    "driverPhone",
    "helperName"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  const statusEl = document.getElementById("truckStatus");
  if (statusEl) statusEl.value = "Running";
}

function openTruckForm() {
  resetTruckForm();
  openSheet("truckFormSheet");
}

function closeTruckForm() {
  closeSheet("truckFormSheet");
}

async function saveTruck() {
  const saveBtn = document.querySelector("#truckFormSheet .sheet-save");
  setButtonLoading(saveBtn, "সংরক্ষণ হচ্ছে...", true);

  try {
    const number = document.getElementById("truckNumber")?.value?.trim() || "";

    if (!number) {
      alert("ট্রাক নম্বর দিতে হবে");
      return;
    }

    const trucks = getTrucks();

    const duplicate = trucks.find(
      (truck) =>
        (truck.number || "").trim().toLowerCase() === number.toLowerCase() &&
        truck.id !== editingTruckId
    );

    if (duplicate) {
      alert("এই ট্রাক নম্বর আগে থেকেই আছে");
      return;
    }

    const truckData = {
      id: editingTruckId || generateTruckId("truck"),
      number,
      model: document.getElementById("truckModel")?.value?.trim() || "",
      route: document.getElementById("truckRoute")?.value?.trim() || "",
      reg: document.getElementById("truckReg")?.value?.trim() || "",
      fitness: document.getElementById("truckFitness")?.value || "",
      tax: document.getElementById("truckTax")?.value || "",
      status: document.getElementById("truckStatus")?.value || "Running",
      driver: {
        name: document.getElementById("driverName")?.value?.trim() || "",
        phone: document.getElementById("driverPhone")?.value?.trim() || ""
      },
      helper: {
        name: document.getElementById("helperName")?.value?.trim() || ""
      }
    };

    if (editingTruckId) {
      const oldTruck = trucks.find((truck) => truck.id === editingTruckId);

      truckData.incomes = oldTruck?.incomes || [];
      truckData.expenses = oldTruck?.expenses || [];
      truckData.createdAt = oldTruck?.createdAt || new Date().toISOString();

      saveTrucks(trucks.map((truck) => (truck.id === editingTruckId ? truckData : truck)));
    } else {
      truckData.incomes = [];
      truckData.expenses = [];
      truckData.createdAt = new Date().toISOString();
      trucks.push(truckData);
      saveTrucks(trucks);
    }

    if (isAppOnline()) {
      await rebuildTruckHisabMirror();
    }

    closeTruckForm();
    renderTruckList();
    applyAdvancedTruckReport();
    renderTruckSmartAnalytics();

    if (currentTruckId && currentTruckId === editingTruckId) {
      openTruckDetail(currentTruckId);
    }
  } catch (err) {
    console.error("Truck save failed:", err);
    alert("ট্রাক সংরক্ষণ করা যায়নি");
  } finally {
    setButtonLoading(saveBtn, "সংরক্ষণ হচ্ছে...", false);
  }
}

function openEditTruck(truckId) {
  const truck = getTrucks().find((item) => item.id === truckId);
  if (!truck) return;

  editingTruckId = truckId;

  const titleEl = document.getElementById("truckFormTitle");
  if (titleEl) titleEl.innerText = "ট্রাক Edit করুন";

  document.getElementById("truckNumber").value = truck.number || "";
  document.getElementById("truckModel").value = truck.model || "";
  document.getElementById("truckRoute").value = truck.route || "";
  document.getElementById("truckReg").value = truck.reg || "";
  document.getElementById("truckFitness").value = truck.fitness || "";
  document.getElementById("truckTax").value = truck.tax || "";
  document.getElementById("truckStatus").value = truck.status || "Running";
  document.getElementById("driverName").value = truck.driver?.name || "";
  document.getElementById("driverPhone").value = truck.driver?.phone || "";
  document.getElementById("helperName").value = truck.helper?.name || "";

  openSheet("truckFormSheet");
}

async function deleteTruck(truckId) {
  if (!confirm("এই ট্রাক delete করতে চান?")) return;

  const targetTruck = getTrucks().find((truck) => truck.id === truckId);
  const updated = getTrucks().filter((truck) => truck.id !== truckId);
  saveTrucks(updated);

  if (isAppOnline() && targetTruck) {
    for (const item of targetTruck.incomes || []) {
      await removeTruckIncomeFromHishab(item.id);
    }
    for (const item of targetTruck.expenses || []) {
      await removeTruckExpenseFromHishab(item.id);
    }
  }

  if (currentTruckId === truckId) {
    backToTruckList();
  }

  renderTruckList();
  applyAdvancedTruckReport();
  renderTruckSmartAnalytics();
}

/* =========================
   DETAIL PAGE
========================= */
function openTruckDetail(truckId) {
  currentTruckId = truckId;
  currentTruckTab = "income";

  document.getElementById("truckListPage")?.classList.add("hidden");
  document.getElementById("truckDetailPage")?.classList.remove("hidden");

  handleTruckDetailReportMode();
  renderTruckDetail();
  applyTruckDetailReport();
}

function backToTruckList() {
  currentTruckId = null;
  document.getElementById("truckDetailPage")?.classList.add("hidden");
  document.getElementById("truckListPage")?.classList.remove("hidden");

  renderTruckList();
  applyAdvancedTruckReport();
  renderTruckSmartAnalytics();
}

function openEditCurrentTruck() {
  if (!currentTruckId) return;
  openEditTruck(currentTruckId);
}

function switchTruckDetailTab(tab) {
  currentTruckTab = tab;

  document.getElementById("incomeTabBtn")?.classList.toggle("active", tab === "income");
  document.getElementById("expenseTabBtn")?.classList.toggle("active", tab === "expense");
  document.getElementById("addIncomeBtn")?.classList.toggle("hidden", tab !== "income");
  document.getElementById("addExpenseBtn")?.classList.toggle("hidden", tab !== "expense");

  renderTruckDetail();
}

function renderTruckDetail() {
  const truck = getTrucks().find((item) => item.id === currentTruckId);
  if (!truck) {
    backToTruckList();
    return;
  }

  const totals = getTruckTotals(truck);
  const isProfit = totals.balance >= 0;

  document.getElementById("detailTruckNumber").innerText = truck.number || "TRUCK";

  const detailIncomeEl = document.getElementById("detailIncome");
  const detailExpenseEl = document.getElementById("detailExpense");
  const profitLabel = document.getElementById("detailProfitLabel");
  const profitValue = document.getElementById("detailProfitValue");
  const profitCard = document.getElementById("detailProfitCard");

  if (detailIncomeEl) {
    detailIncomeEl.innerText = formatMoney(totals.income);
    setAmountColor(detailIncomeEl, "income");
  }

  if (detailExpenseEl) {
    detailExpenseEl.innerText = formatMoney(totals.expense);
    setAmountColor(detailExpenseEl, "expense");
  }

  if (profitLabel) profitLabel.innerText = isProfit ? "লাভ" : "ক্ষতি";

  if (profitValue) {
    profitValue.innerText = formatMoney(Math.abs(totals.balance));
    setAmountColor(profitValue, "profitloss", totals.balance);
  }

  if (profitCard) {
    profitCard.classList.remove("profit-border", "loss-border");
    profitCard.classList.add(isProfit ? "profit-border" : "loss-border");
  }

  document.getElementById("incomeTabCount").innerText = (truck.incomes || []).length;
  document.getElementById("expenseTabCount").innerText = (truck.expenses || []).length;

  renderTruckHistory(truck);
}

function renderTruckHistory(truck) {
  const historyList = document.getElementById("historyList");
  const noHistoryState = document.getElementById("noHistoryState");
  const noHistoryText = document.getElementById("noHistoryText");

  if (!historyList || !noHistoryState || !noHistoryText) return;

  if (currentTruckTab === "income") {
    const incomes = truck.incomes || [];

    if (!incomes.length) {
      historyList.innerHTML = "";
      noHistoryState.classList.remove("hidden");
      noHistoryText.innerText = "কোনো আয় নেই";
      return;
    }

    noHistoryState.classList.add("hidden");

    historyList.innerHTML = incomes
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .map((item) => {
        const paymentText = item.paymentMethod === "Mixed"
          ? `পেমেন্ট: Mixed (${formatPaymentSplitInline(item.paymentSplit)})`
          : `পেমেন্ট: ${escapeHtml(item.paymentMethod || "Cash")}`;

        return `
          <div class="history-card">
            <div class="history-top">
              <div>
                <div class="history-date">${escapeHtml(item.date)} · ${Number(item.trips || 0)} ট্রিপ</div>
                <div class="history-meta">${paymentText}</div>
              </div>
              <div class="history-amount income-color">+${formatMoney(item.amount)}</div>
            </div>

            <div class="history-actions">
              <button class="history-action-btn edit" onclick="openEditTruckIncome('${truck.id}','${item.id}')">✎</button>
              <button class="history-action-btn delete" onclick="deleteTruckIncome('${truck.id}','${item.id}')">🗑</button>
            </div>
          </div>
        `;
      })
      .join("");
  } else {
    const expenses = truck.expenses || [];

    if (!expenses.length) {
      historyList.innerHTML = "";
      noHistoryState.classList.remove("hidden");
      noHistoryText.innerText = "কোনো ব্যয় নেই";
      return;
    }

    noHistoryState.classList.add("hidden");

    historyList.innerHTML = expenses
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .map((item) => {
        const total = getExpenseTotal(item);
        const paymentText = item.paymentMethod === "Mixed"
          ? `পেমেন্ট: Mixed (${formatPaymentSplitInline(item.paymentSplit)})`
          : `পেমেন্ট: ${escapeHtml(item.paymentMethod || "Cash")}`;

        return `
          <div class="history-card">
            <div class="history-top">
              <div>
                <div class="history-date">${escapeHtml(item.date)}</div>
                <div class="history-meta">
                  ডিজেল: ${formatMoney(item.diesel || 0)} |
                  মেরামত: ${formatMoney(item.repair || 0)} |
                  ড্রাইভার: ${formatMoney(item.driverSalary || 0)} |
                  অন্যান্য: ${formatMoney(item.other || 0)}
                </div>
                <div class="history-meta">${paymentText}</div>
                ${item.note ? `<div class="history-meta">${escapeHtml(item.note)}</div>` : ""}
              </div>
              <div class="history-amount expense-color">-${formatMoney(total)}</div>
            </div>

            <div class="history-actions">
              <button class="history-action-btn edit" onclick="openEditTruckExpense('${truck.id}','${item.id}')">✎</button>
              <button class="history-action-btn delete" onclick="deleteTruckExpense('${truck.id}','${item.id}')">🗑</button>
            </div>
          </div>
        `;
      })
      .join("");
  }
}

/* =========================
   INCOME
========================= */
function openTruckIncomeSheet() {
  if (!currentTruckId) return;

  editingTruckIncomeId = null;

  setTodayValue("incomeDate");
  document.getElementById("incomeTrips").value = "";
  document.getElementById("incomeAmount").value = "";

  const paymentMethodEl = document.getElementById("incomePaymentMethod");
  if (paymentMethodEl) paymentMethodEl.value = "Cash";

  clearSplitValues("income");
  toggleTruckIncomePaymentMethod();
  updateTruckIncomeSplitPreview();

  openSheet("truckIncomeSheet");
}

function closeTruckIncomeSheet() {
  closeSheet("truckIncomeSheet");
}

function openEditTruckIncome(truckId, incomeId) {
  const truck = getTrucks().find((t) => t.id === truckId);
  if (!truck) return;

  const item = (truck.incomes || []).find((x) => x.id === incomeId);
  if (!item) return;

  currentTruckId = truckId;
  editingTruckIncomeId = incomeId;

  document.getElementById("incomeDate").value = item.date || "";
  document.getElementById("incomeTrips").value = Number(item.trips || 0);
  document.getElementById("incomeAmount").value = Number(item.amount || 0);

  const paymentMethodEl = document.getElementById("incomePaymentMethod");
  if (paymentMethodEl) paymentMethodEl.value = item.paymentMethod || "Cash";

  writeSplitValues("income", item.paymentSplit || {});
  toggleTruckIncomePaymentMethod();
  updateTruckIncomeSplitPreview();

  openSheet("truckIncomeSheet");
}

async function saveTruckIncome() {
  const saveBtn = document.querySelector("#truckIncomeSheet .sheet-save");
  setButtonLoading(saveBtn, "সংরক্ষণ হচ্ছে...", true);

  try {
    const date = document.getElementById("incomeDate")?.value || "";
    const trips = Number(document.getElementById("incomeTrips")?.value || 0);
    const amount = Number(document.getElementById("incomeAmount")?.value || 0);

    if (!date || amount <= 0) {
      alert("সঠিক আয় তথ্য দিন");
      return;
    }

    const paymentMethod = document.getElementById("incomePaymentMethod")?.value || "Cash";
    const paymentSplit = readSplitValues("income");

    if (paymentMethod === "Mixed") {
      const splitTotal = sumSplitValues(paymentSplit);
      if (splitTotal !== amount) {
        alert("Mixed payment total এবং amount সমান হতে হবে");
        return;
      }
    }

    let savedTruck = null;
    let savedIncome = null;

    const trucks = getTrucks().map((truck) => {
      if (truck.id === currentTruckId) {
        truck.incomes = truck.incomes || [];

        if (editingTruckIncomeId) {
          truck.incomes = truck.incomes.map((item) => {
            if (item.id !== editingTruckIncomeId) return item;

            const updatedItem = {
              ...item,
              date,
              trips,
              amount,
              paymentMethod,
              paymentSplit: paymentMethod === "Mixed" ? paymentSplit : {}
            };

            savedTruck = truck;
            savedIncome = updatedItem;
            return updatedItem;
          });
        } else {
          const newIncome = {
            id: generateTruckId("income"),
            date,
            trips,
            amount,
            paymentMethod,
            paymentSplit: paymentMethod === "Mixed" ? paymentSplit : {}
          };

          truck.incomes.push(newIncome);
          savedTruck = truck;
          savedIncome = newIncome;
        }
      }
      return truck;
    });

    saveTrucks(trucks);
    await syncTruckIncomeToHishab(savedTruck, savedIncome);

    editingTruckIncomeId = null;
    closeTruckIncomeSheet();
    renderTruckDetail();
    renderTruckList();
    applyAdvancedTruckReport();
    applyTruckDetailReport();
    renderTruckSmartAnalytics();
  } catch (err) {
    console.error("Truck income save failed:", err);
    alert("আয় সংরক্ষণ করা যায়নি");
  } finally {
    setButtonLoading(saveBtn, "সংরক্ষণ হচ্ছে...", false);
  }
}

/* =========================
   EXPENSE
========================= */
function openTruckExpenseSheet() {
  if (!currentTruckId) return;

  editingTruckExpenseId = null;

  setTodayValue("expenseDate");
  document.getElementById("expenseDiesel").value = "";
  document.getElementById("expenseRepair").value = "";
  document.getElementById("expenseDriverSalary").value = "";
  document.getElementById("expenseOther").value = "";
  document.getElementById("expenseNote").value = "";

  const paymentMethodEl = document.getElementById("expensePaymentMethod");
  if (paymentMethodEl) paymentMethodEl.value = "Cash";

  clearSplitValues("expense");
  toggleTruckExpensePaymentMethod();
  updateTruckExpenseSplitPreview();

  openSheet("truckExpenseSheet");
}

function closeTruckExpenseSheet() {
  closeSheet("truckExpenseSheet");
}

function openEditTruckExpense(truckId, expenseId) {
  const truck = getTrucks().find((t) => t.id === truckId);
  if (!truck) return;

  const item = (truck.expenses || []).find((x) => x.id === expenseId);
  if (!item) return;

  currentTruckId = truckId;
  editingTruckExpenseId = expenseId;

  document.getElementById("expenseDate").value = item.date || "";
  document.getElementById("expenseDiesel").value = Number(item.diesel || 0);
  document.getElementById("expenseRepair").value = Number(item.repair || 0);
  document.getElementById("expenseDriverSalary").value = Number(item.driverSalary || 0);
  document.getElementById("expenseOther").value = Number(item.other || 0);
  document.getElementById("expenseNote").value = item.note || "";

  const paymentMethodEl = document.getElementById("expensePaymentMethod");
  if (paymentMethodEl) paymentMethodEl.value = item.paymentMethod || "Cash";

  writeSplitValues("expense", item.paymentSplit || {});
  toggleTruckExpensePaymentMethod();
  updateTruckExpenseSplitPreview();

  openSheet("truckExpenseSheet");
}

async function saveTruckExpense() {
  const saveBtn = document.querySelector("#truckExpenseSheet .sheet-save");
  setButtonLoading(saveBtn, "সংরক্ষণ হচ্ছে...", true);

  try {
    const date = document.getElementById("expenseDate")?.value || "";
    const diesel = Number(document.getElementById("expenseDiesel")?.value || 0);
    const repair = Number(document.getElementById("expenseRepair")?.value || 0);
    const driverSalary = Number(document.getElementById("expenseDriverSalary")?.value || 0);
    const other = Number(document.getElementById("expenseOther")?.value || 0);
    const note = document.getElementById("expenseNote")?.value?.trim() || "";

    const total = diesel + repair + driverSalary + other;

    if (!date || total <= 0) {
      alert("সঠিক ব্যয় তথ্য দিন");
      return;
    }

    const paymentMethod = document.getElementById("expensePaymentMethod")?.value || "Cash";
    const paymentSplit = readSplitValues("expense");

    if (paymentMethod === "Mixed") {
      const splitTotal = sumSplitValues(paymentSplit);
      if (splitTotal !== total) {
        alert("Mixed payment total এবং expense total সমান হতে হবে");
        return;
      }
    }

    let savedTruck = null;
    let savedExpense = null;

    const trucks = getTrucks().map((truck) => {
      if (truck.id === currentTruckId) {
        truck.expenses = truck.expenses || [];

        if (editingTruckExpenseId) {
          truck.expenses = truck.expenses.map((item) => {
            if (item.id !== editingTruckExpenseId) return item;

            const updatedItem = {
              ...item,
              date,
              diesel,
              repair,
              driverSalary,
              other,
              note,
              paymentMethod,
              paymentSplit: paymentMethod === "Mixed" ? paymentSplit : {}
            };

            savedTruck = truck;
            savedExpense = updatedItem;
            return updatedItem;
          });
        } else {
          const newExpense = {
            id: generateTruckId("expense"),
            date,
            diesel,
            repair,
            driverSalary,
            other,
            note,
            paymentMethod,
            paymentSplit: paymentMethod === "Mixed" ? paymentSplit : {}
          };

          truck.expenses.push(newExpense);
          savedTruck = truck;
          savedExpense = newExpense;
        }
      }
      return truck;
    });

    saveTrucks(trucks);
    await syncTruckExpenseToHishab(savedTruck, savedExpense);

    editingTruckExpenseId = null;
    closeTruckExpenseSheet();
    renderTruckDetail();
    renderTruckList();
    applyAdvancedTruckReport();
    applyTruckDetailReport();
    renderTruckSmartAnalytics();
  } catch (err) {
    console.error("Truck expense save failed:", err);
    alert("ব্যয় সংরক্ষণ করা যায়নি");
  } finally {
    setButtonLoading(saveBtn, "সংরক্ষণ হচ্ছে...", false);
  }
}

/* =========================
   DELETE ITEMS
========================= */
async function deleteTruckIncome(truckId, incomeId) {
  if (!confirm("এই আয় delete করবেন?")) return;

  const trucks = getTrucks().map((truck) => {
    if (truck.id === truckId) {
      truck.incomes = (truck.incomes || []).filter((item) => item.id !== incomeId);
    }
    return truck;
  });

  saveTrucks(trucks);
  await removeTruckIncomeFromHishab(incomeId);

  renderTruckDetail();
  renderTruckList();
  applyAdvancedTruckReport();
  applyTruckDetailReport();
  renderTruckSmartAnalytics();
}

async function deleteTruckExpense(truckId, expenseId) {
  if (!confirm("এই ব্যয় delete করবেন?")) return;

  const trucks = getTrucks().map((truck) => {
    if (truck.id === truckId) {
      truck.expenses = (truck.expenses || []).filter((item) => item.id !== expenseId);
    }
    return truck;
  });

  saveTrucks(trucks);
  await removeTruckExpenseFromHishab(expenseId);

  renderTruckDetail();
  renderTruckList();
  applyAdvancedTruckReport();
  applyTruckDetailReport();
  renderTruckSmartAnalytics();
}

/* =========================
   SHEET CLOSE
========================= */
function setupTruckSheetOutsideClose() {
  const sheetIds = ["truckFormSheet", "truckIncomeSheet", "truckExpenseSheet"];

  sheetIds.forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        closeSheet(id);
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    sheetIds.forEach((id) => {
      const overlay = document.getElementById(id);
      if (overlay?.classList.contains("show")) {
        closeSheet(id);
      }
    });
  });
}

/* =========================
   PDF
========================= */
function downloadTruckPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("PDF library load হয়নি");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("TRUCK REPORT", 20, 20);

  doc.setFontSize(11);
  doc.text(`Filter: ${lastTruckReportData.label}`, 20, 35);
  doc.text(`Income: ${lastTruckReportData.income}`, 20, 45);
  doc.text(`Expense: ${lastTruckReportData.expense}`, 20, 55);
  doc.text(`Balance: ${lastTruckReportData.balance}`, 20, 65);
  doc.text(`Trips: ${lastTruckReportData.trips}`, 20, 75);

  let y = 90;

  getTrucks().forEach((truck, index) => {
    if (y > 260) {
      doc.addPage();
      y = 20;
    }

    const totals = getTruckTotals(truck);

    doc.text(`${index + 1}. ${truck.number || "-"}`, 20, y);
    doc.text(`Route: ${truck.route || "-"}`, 25, y + 8);
    doc.text(
      `Income: ${totals.income} | Expense: ${totals.expense} | Balance: ${totals.balance}`,
      25,
      y + 16
    );

    y += 28;
  });

  doc.save("Truck-Report.pdf");
}

/* =========================
   ONLINE SYNC
========================= */
window.addEventListener("online", async () => {
  try {
    await flushTruckQueue();
    await loadTruckCloudToLocal();
    await rebuildTruckHisabMirror();

    renderTruckList();
    applyAdvancedTruckReport();
    applyTruckDetailReport();
    renderTruckSmartAnalytics();
  } catch (err) {
    console.error("Truck online sync failed:", err);
  }
});

/* =========================
   INIT
========================= */
  document.addEventListener("DOMContentLoaded", async () => {
  const sessionInfo = await resolveTruckStorageKey();

  if (!sessionInfo?.authUser && !sessionInfo?.localUser) {
    localStorage.removeItem("loggedInUser");
    window.location.replace("login.html");
    return;
  }

  try {
    await flushTruckQueue();
  } catch (err) {
    console.error("Initial truck queue flush failed:", err);
  }

  await loadTruckCloudToLocal();

  if (isAppOnline()) {
    await rebuildTruckHisabMirror();
  }

  handleTruckReportModeChange();
  handleTruckDetailReportMode();
  renderTruckList();
  applyAdvancedTruckReport();
  renderTruckSmartAnalytics();
  setupTruckSheetOutsideClose();
  syncSheetOpenState();

  document.getElementById("incomePaymentMethod")?.addEventListener("change", toggleTruckIncomePaymentMethod);
  document.getElementById("expensePaymentMethod")?.addEventListener("change", toggleTruckExpensePaymentMethod);

  [
    "incomeSplitCash",
    "incomeSplitBkash",
    "incomeSplitNagad",
    "incomeSplitRocket",
    "incomeSplitUpay",
    "incomeSplitBank",
    "incomeSplitCard"
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateTruckIncomeSplitPreview);
  });

  [
    "expenseSplitCash",
    "expenseSplitBkash",
    "expenseSplitNagad",
    "expenseSplitRocket",
    "expenseSplitUpay",
    "expenseSplitBank",
    "expenseSplitCard"
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateTruckExpenseSplitPreview);
  });

  toggleTruckIncomePaymentMethod();
  toggleTruckExpensePaymentMethod();
  updateTruckIncomeSplitPreview();
  updateTruckExpenseSplitPreview();
});

/* =========================
   EXPORT
========================= */
window.goTruckDashboard = goTruckDashboard;
window.openTruckForm = openTruckForm;
window.closeTruckForm = closeTruckForm;
window.saveTruck = saveTruck;
window.openEditTruck = openEditTruck;
window.deleteTruck = deleteTruck;
window.openTruckDetail = openTruckDetail;
window.backToTruckList = backToTruckList;
window.openEditCurrentTruck = openEditCurrentTruck;
window.switchTruckDetailTab = switchTruckDetailTab;

window.openTruckIncomeSheet = openTruckIncomeSheet;
window.closeTruckIncomeSheet = closeTruckIncomeSheet;
window.saveTruckIncome = saveTruckIncome;
window.openEditTruckIncome = openEditTruckIncome;

window.openTruckExpenseSheet = openTruckExpenseSheet;
window.closeTruckExpenseSheet = closeTruckExpenseSheet;
window.saveTruckExpense = saveTruckExpense;
window.openEditTruckExpense = openEditTruckExpense;

window.deleteTruckIncome = deleteTruckIncome;
window.deleteTruckExpense = deleteTruckExpense;

window.handleTruckReportModeChange = handleTruckReportModeChange;
window.handleTruckDetailReportMode = handleTruckDetailReportMode;
window.applyAdvancedTruckReport = applyAdvancedTruckReport;
window.applyTruckDetailReport = applyTruckDetailReport;
window.downloadTruckPDF = downloadTruckPDF;
window.renderTruckList = renderTruckList;

window.toggleTruckIncomePaymentMethod = toggleTruckIncomePaymentMethod;
window.toggleTruckExpensePaymentMethod = toggleTruckExpensePaymentMethod;
window.updateTruckIncomeSplitPreview = updateTruckIncomeSplitPreview;
window.updateTruckExpenseSplitPreview = updateTruckExpenseSplitPreview;