import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

import {
  loadBusCloudData,
  saveBusCloudData,
  getEmptyBusData
} from "./bus-cloud.js";

import {
  upsertHishabSyncEntry,
  deleteHishabSyncEntry
} from "./hishab-bridge.js";

import {
  addSyncTask,
  isAppOnline
} from "./offline-queue.js";

import { flushBusQueue } from "./bus-sync.js";

let BUS_NS = "default_user";
let BUS_KEY = "shebaBus_default_user";

function makeSafeBusUserKey(value) {
  return String(value || "default_user")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]@]/g, "_");
}

function makeLegacyBusNs(userData) {
  return String(
    userData?.username || userData?.email || "default_user"
  ).replace(/[.#$/\[\]]/g, "_");
}

function copyOldBusDataIfNeeded(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;

  const oldValue = localStorage.getItem(oldKey);
  const newValue = localStorage.getItem(newKey);

  if (!newValue && oldValue) {
    localStorage.setItem(newKey, oldValue);
  }
}

async function resolveBusStorageKey() {
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

  BUS_NS = makeSafeBusUserKey(identity);
  BUS_KEY = `shebaBus_${BUS_NS}`;

  const legacyNs = makeLegacyBusNs(localUser || authUser || {});
  const OLD_BUS_KEY = `shebaBus_${legacyNs}`;

  copyOldBusDataIfNeeded(OLD_BUS_KEY, BUS_KEY);

  return {
    authUser,
    localUser
  };
}

let currentBusId = null;
let editingBusId = null;
let editingIncomeId = null;
let editingExpenseId = null;
let currentTab = "income";
let busChart = null;
let detailBusChart = null;

let lastReportData = {
  income: 0,
  expense: 0,
  balance: 0,
  trips: 0,
  label: "রিপোর্ট"
};

let lastDetailReportData = {
  income: 0,
  expense: 0,
  balance: 0,
  trips: 0,
  label: "এই বাসের রিপোর্ট"
};

/* =========================
   PAYMENT HELPERS
========================= */
function normalizePaymentMethod(value, fallback = "Cash") {
  const allowed = [
    "Cash",
    "bKash",
    "Nagad",
    "Rocket",
    "Upay",
    "Bank",
    "Card",
    "Mixed"
  ];

  const clean = String(value || "").trim();
  return allowed.includes(clean) ? clean : fallback;
}

const BUS_SPLIT_METHODS = [
  ["Cash", "Cash"],
  ["bKash", "Bkash"],
  ["Nagad", "Nagad"],
  ["Rocket", "Rocket"],
  ["Upay", "Upay"],
  ["Bank", "Bank"],
  ["Card", "Card"]
];

function getBusSplitInputId(type, suffix) {
  return type === "income"
    ? `busIncomeSplit${suffix}`
    : `busExpenseSplit${suffix}`;
}

function resetBusSplitInputs(type) {
  BUS_SPLIT_METHODS.forEach(([, suffix]) => {
    const el = document.getElementById(getBusSplitInputId(type, suffix));
    if (el) el.value = "";
  });
}

function fillBusSplitInputs(type, split = {}) {
  BUS_SPLIT_METHODS.forEach(([label, suffix]) => {
    const el = document.getElementById(getBusSplitInputId(type, suffix));
    if (el) el.value = Number(split?.[label] || 0) || "";
  });
}

function getBusSplitObject(type) {
  const obj = {};

  BUS_SPLIT_METHODS.forEach(([label, suffix]) => {
    const val = Number(document.getElementById(getBusSplitInputId(type, suffix))?.value || 0);
    if (val > 0) obj[label] = val;
  });

  return obj;
}

function getBusSplitTotal(type) {
  return BUS_SPLIT_METHODS.reduce((sum, [, suffix]) => {
    return sum + Number(document.getElementById(getBusSplitInputId(type, suffix))?.value || 0);
  }, 0);
}

function formatBusSplit(split = {}) {
  return Object.entries(split)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([method, amount]) => `${method} ${formatMoney(amount)}`)
    .join(" | ");
}

function renderBusSplitHtml(split = {}) {
  const text = formatBusSplit(split);
  return text ? `<div class="history-meta">Split: ${escapeHtml(text)}</div>` : "";
}

function getBusIncomeDisplayMethod(item) {
  if (!item) return "Cash";
  if (item.paymentBreakdown && Object.keys(item.paymentBreakdown).length > 1) return "Mixed";
  return normalizePaymentMethod(item.paymentMethod, "Cash");
}

function getBusExpenseDisplayMethod(item) {
  if (!item) return "Cash";
  if (item.paymentBreakdown && Object.keys(item.paymentBreakdown).length > 1) return "Mixed";
  return normalizePaymentMethod(item.paymentMethod, "Cash");
}

function updateBusIncomeMixedTotal() {
  if (document.getElementById("busIncomeMethod")?.value !== "Mixed") return;

  const total = getBusSplitTotal("income");
  const amountEl = document.getElementById("incomeAmount");
  if (amountEl) amountEl.value = total || "";
}

function toggleBusIncomeSplit() {
  const isMixed = document.getElementById("busIncomeMethod")?.value === "Mixed";
  const wrap = document.getElementById("busIncomeSplitWrap");
  const amountEl = document.getElementById("incomeAmount");

  if (wrap) wrap.classList.toggle("hidden", !isMixed);

  if (amountEl) {
    amountEl.readOnly = isMixed;
  }

  if (!isMixed) {
    resetBusSplitInputs("income");
  } else {
    updateBusIncomeMixedTotal();
  }
}

function toggleBusExpenseSplit() {
  const isMixed = document.getElementById("busExpenseMethod")?.value === "Mixed";
  const wrap = document.getElementById("busExpenseSplitWrap");

  if (wrap) wrap.classList.toggle("hidden", !isMixed);

  if (!isMixed) {
    resetBusSplitInputs("expense");
  }
}

/* =========================
   LOCAL + CLOUD STORAGE
========================= */
function readBusArray(keyName) {
  try {
    const raw = localStorage.getItem(keyName);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getBuses() {
  return readBusArray(BUS_KEY);
}

function getBusPayload() {
  return {
    buses: getBuses()
  };
}

function queueBusSave() {
  addSyncTask({
    module: "bus",
    action: "save_full_state",
    payload: getBusPayload()
  });
}

async function saveBusCloud() {
  await saveBusCloudData(getBusPayload());
}

function saveBuses(buses) {
  localStorage.setItem(BUS_KEY, JSON.stringify(buses));
  localStorage.setItem("busCountCache", String(buses.length));

  if (!isAppOnline()) {
    queueBusSave();
    return;
  }

  saveBusCloud().catch((err) => {
    console.error("Bus cloud save failed:", err);
    queueBusSave();
  });
}

async function loadBusCloudToLocal() {
  try {
    const localBuses = getBuses();
    const data = await loadBusCloudData();
    const finalData = data || getEmptyBusData();
    const cloudBuses = Array.isArray(finalData.buses) ? finalData.buses : [];

    const busesToUse = cloudBuses.length ? cloudBuses : localBuses;

    localStorage.setItem(BUS_KEY, JSON.stringify(busesToUse));
    localStorage.setItem("busCountCache", String(busesToUse.length));
  } catch (err) {
    console.error("Bus cloud load failed:", err);
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

function makeBusIncomeHisabPayload(bus, item) {
  const splitText = formatBusSplit(item?.paymentBreakdown || {});
  const noteParts = [
    `${Number(item?.trips || 0)} ট্রিপ`
  ];

  if (bus?.route) {
    noteParts.push(`Route: ${bus.route}`);
  }

  if (splitText) {
    noteParts.push(`Split: ${splitText}`);
  }

  return {
    module_name: "bus",
    entry_type: "income",
    source_table: "bus_income",
    source_id: item.id,
    entry_date: item.date || new Date().toISOString().slice(0, 10),
    party_name: bus?.number || bus?.route || "Bus Income",
    category: "Bus Trip Income",
    total_amount: Number(item.amount || 0),
    paid_amount: Number(item.amount || 0),
    due_amount: 0,
    payment_method: getBusIncomeDisplayMethod(item),
    note: noteParts.join(" | ")
  };
}

function makeBusExpenseHisabPayload(bus, item) {
  const total = expenseTotal(item);
  const splitText = formatBusSplit(item?.paymentBreakdown || {});
  const baseNote =
    item.note ||
    `ডিজেল: ${Number(item.diesel || 0)}, সার্ভিস: ${Number(item.service || 0)}, ড্রাইভার: ${Number(item.driverSalary || 0)}, অন্যান্য: ${Number(item.other || 0)}`;

  const note = splitText ? `${baseNote} | Split: ${splitText}` : baseNote;

  return {
    module_name: "bus",
    entry_type: "expense",
    source_table: "bus_expense",
    source_id: item.id,
    entry_date: item.date || new Date().toISOString().slice(0, 10),
    party_name: bus?.number || bus?.route || "Bus Expense",
    category: "Bus Expense",
    total_amount: Number(total || 0),
    paid_amount: Number(total || 0),
    due_amount: 0,
    payment_method: getBusExpenseDisplayMethod(item),
    note
  };
}

async function syncBusIncomeToHishab(bus, item) {
  if (!bus || !item || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeBusIncomeHisabPayload(bus, item));
  } catch (err) {
    console.error("Bus income -> hishab sync failed:", err);
  }
}

async function syncBusExpenseToHishab(bus, item) {
  if (!bus || !item || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeBusExpenseHisabPayload(bus, item));
  } catch (err) {
    console.error("Bus expense -> hishab sync failed:", err);
  }
}

async function removeBusIncomeFromHishab(incomeId) {
  if (!incomeId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("bus_income", incomeId);
  } catch (err) {
    console.error("Bus income -> hishab delete failed:", err);
  }
}

async function removeBusExpenseFromHishab(expenseId) {
  if (!expenseId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("bus_expense", expenseId);
  } catch (err) {
    console.error("Bus expense -> hishab delete failed:", err);
  }
}

async function clearBusHisabMirror() {
  if (!isAppOnline()) return;

  try {
    const userId = await getAuthUserId();

    const { error } = await supabase
      .from("hisab_entries")
      .delete()
      .eq("user_id", userId)
      .in("source_table", ["bus_income", "bus_expense"]);

    if (error) throw error;
  } catch (err) {
    console.error("Clear bus hishab mirror failed:", err);
  }
}

async function rebuildBusHisabMirror() {
  if (!isAppOnline()) return;

  try {
    await clearBusHisabMirror();

    const buses = getBuses();

    for (const bus of buses) {
      for (const income of bus.incomes || []) {
        await syncBusIncomeToHishab(bus, income);
      }

      for (const expense of bus.expenses || []) {
        await syncBusExpenseToHishab(bus, expense);
      }
    }
  } catch (err) {
    console.error("Bus hishab rebuild failed:", err);
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

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function goDashboard() {
  window.location.href = "dashboard.html";
}

function setToday(inputId) {
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

function daysLeft(dateString) {
  if (!dateString) return null;

  const today = new Date();
  const target = new Date(dateString);

  if (isNaN(target.getTime())) return null;

  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);

  return Math.ceil((target - today) / (1000 * 60 * 60 * 24));
}

function expenseTotal(item) {
  return (
    Number(item.diesel || 0) +
    Number(item.service || 0) +
    Number(item.driverSalary || 0) +
    Number(item.other || 0)
  );
}

function getBusTotals(bus) {
  const totalIncome = (bus.incomes || []).reduce((sum, item) => {
    return sum + Number(item.amount || 0);
  }, 0);

  const totalExpense = (bus.expenses || []).reduce((sum, item) => {
    return sum + expenseTotal(item);
  }, 0);

  return {
    income: totalIncome,
    expense: totalExpense,
    balance: totalIncome - totalExpense
  };
}

function getAllTotals(buses) {
  let income = 0;
  let expense = 0;

  buses.forEach((bus) => {
    const totals = getBusTotals(bus);
    income += totals.income;
    expense += totals.expense;
  });

  return {
    income,
    expense,
    balance: income - expense
  };
}

/* =========================
   SEARCH + SORT
========================= */
function getFilteredBuses() {
  const buses = getBuses();
  const search = document.getElementById("busSearch")?.value?.trim().toLowerCase() || "";
  const sort = document.getElementById("busSort")?.value || "latest";

  const filtered = buses.filter((bus) => {
    return (
      (bus.number || "").toLowerCase().includes(search) ||
      (bus.route || "").toLowerCase().includes(search) ||
      (bus.model || "").toLowerCase().includes(search)
    );
  });

  filtered.sort((a, b) => {
    const aTotals = getBusTotals(a);
    const bTotals = getBusTotals(b);

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
function renderTopSummary() {
  const buses = getBuses();
  const totals = getAllTotals(buses);

  const busCountEl = document.getElementById("summaryBusCount");
  const incomeEl = document.getElementById("summaryIncome");
  const expenseEl = document.getElementById("summaryExpense");
  const profitEl = document.getElementById("summaryProfit");

  if (busCountEl) busCountEl.innerText = buses.length;

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
function renderWarningCard() {
  const buses = getBuses();
  const warningCard = document.getElementById("warningCard");
  const warningList = document.getElementById("warningList");

  if (!warningCard || !warningList) return;

  const warnings = [];

  buses.forEach((bus) => {
    const fitness = daysLeft(bus.fitness);
    const tax = daysLeft(bus.tax);

    if (fitness !== null && fitness <= 30) {
      warnings.push(
        `${bus.number || "Unknown"} - Fitness ${fitness < 0 ? "মেয়াদ শেষ" : `${fitness} দিনের মধ্যে শেষ`}`
      );
    }

    if (tax !== null && tax <= 30) {
      warnings.push(
        `${bus.number || "Unknown"} - Tax ${tax < 0 ? "মেয়াদ শেষ" : `${tax} দিনের মধ্যে শেষ`}`
      );
    }
  });

  if (!warnings.length) {
    warningCard.classList.add("hidden");
    warningList.innerHTML = "";
    return;
  }

  warningCard.classList.remove("hidden");
  warningList.innerHTML = warnings
    .map((item) => `<div class="warning-item">${escapeHtml(item)}</div>`)
    .join("");
}

/* =========================
   MONTH / YEAR OPTIONS
========================= */
function monthOptions(selected = "") {
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

function yearOptions(selected = "") {
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
function handleReportModeChange() {
  const mode = document.getElementById("reportMode")?.value;
  const wrap = document.getElementById("reportDynamicFields");

  if (!wrap) return;

  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();
  const month = new Date().getMonth();

  if (mode === "monthYear") {
    wrap.innerHTML = `
      <select id="reportMonth" class="report-filter">${monthOptions(String(month))}</select>
      <select id="reportYear" class="report-filter">${yearOptions(String(year))}</select>
    `;
  } else if (mode === "yearOnly") {
    wrap.innerHTML = `
      <select id="reportYearOnly" class="report-filter">${yearOptions(String(year))}</select>
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

/* =========================
   DETAIL REPORT MODE
========================= */
function handleDetailReportMode() {
  const mode = document.getElementById("detailReportMode")?.value;
  const wrap = document.getElementById("detailReportFields");

  if (!wrap) return;

  const today = new Date().toISOString().split("T")[0];
  const year = new Date().getFullYear();
  const month = new Date().getMonth();

  if (mode === "monthYear") {
    wrap.innerHTML = `
      <select id="detailMonth" class="report-filter">${monthOptions(String(month))}</select>
      <select id="detailYear" class="report-filter">${yearOptions(String(year))}</select>
    `;
  } else if (mode === "yearOnly") {
    wrap.innerHTML = `
      <select id="detailYearOnly" class="report-filter">${yearOptions(String(year))}</select>
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
function getCurrentMonthData() {
  const buses = getBuses();
  const now = new Date();

  let income = 0;
  let expense = 0;

  buses.forEach((bus) => {
    (bus.incomes || []).forEach((item) => {
      const d = new Date(item.date);
      if (!isNaN(d.getTime()) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        income += Number(item.amount || 0);
      }
    });

    (bus.expenses || []).forEach((item) => {
      const d = new Date(item.date);
      if (!isNaN(d.getTime()) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        expense += expenseTotal(item);
      }
    });
  });

  return { income, expense };
}

function calculatePrediction() {
  const buses = getBuses();
  const monthlyMap = {};

  buses.forEach((bus) => {
    (bus.incomes || []).forEach((item) => {
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return;

      const key = `${d.getFullYear()}-${d.getMonth()}`;

      if (!monthlyMap[key]) {
        monthlyMap[key] = 0;
      }

      monthlyMap[key] += Number(item.amount || 0);
    });
  });

  const values = Object.values(monthlyMap);
  if (!values.length) return 0;

  const lastThree = values.slice(-3);
  const total = lastThree.reduce((sum, v) => sum + v, 0);

  return Math.round(total / lastThree.length);
}

function getBestBus() {
  const buses = getBuses();
  if (!buses.length) return "-";

  let bestBus = null;
  let bestIncome = -1;

  buses.forEach((bus) => {
    const totals = getBusTotals(bus);
    if (totals.income > bestIncome) {
      bestIncome = totals.income;
      bestBus = bus;
    }
  });

  return bestBus ? bestBus.number : "-";
}

function getSmartAlertMessage() {
  const buses = getBuses();
  const alerts = [];

  buses.forEach((bus) => {
    const totals = getBusTotals(bus);
    const fitness = daysLeft(bus.fitness);
    const tax = daysLeft(bus.tax);

    if (fitness !== null && fitness <= 7) {
      alerts.push(`${bus.number} fitness urgent`);
    }

    if (tax !== null && tax <= 7) {
      alerts.push(`${bus.number} tax urgent`);
    }

    if (totals.balance < 0) {
      alerts.push(`${bus.number} loss চলছে`);
    }
  });

  if (!alerts.length) {
    return "সব সিস্টেম ঠিক আছে";
  }

  return alerts.slice(0, 3).join(" | ");
}

function renderSmartAnalytics() {
  const prediction = calculatePrediction();
  const bestBus = getBestBus();
  const monthData = getCurrentMonthData();
  const alertText = getSmartAlertMessage();

  const aiPredictionIncome = document.getElementById("aiPredictionIncome");
  const bestBusNumber = document.getElementById("bestBusNumber");
  const monthlySummaryIncome = document.getElementById("monthlySummaryIncome");
  const monthlySummaryExpense = document.getElementById("monthlySummaryExpense");
  const smartAlertText = document.getElementById("smartAlertText");

  if (aiPredictionIncome) {
    aiPredictionIncome.innerText = formatMoney(prediction);
    setAmountColor(aiPredictionIncome, "income");
  }

  if (bestBusNumber) {
    bestBusNumber.innerText = bestBus;
    bestBusNumber.style.setProperty("color", "#22c55e", "important");
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

    if (
      alertText.toLowerCase().includes("loss") ||
      alertText.toLowerCase().includes("urgent")
    ) {
      smartAlertText.style.setProperty("color", "#ef4444", "important");
    } else {
      smartAlertText.style.setProperty("color", "#ffffff", "important");
    }
  }
}

/* =========================
   CHARTS
========================= */
function renderChart(reportData) {
  const canvas = document.getElementById("busChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (busChart) {
    busChart.destroy();
  }

  busChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["আয়", "ব্যয়", "লাভ/ক্ষতি"],
      datasets: [
        {
          label: "Bus Report",
          data: [reportData.income, reportData.expense, Math.abs(reportData.balance)],
          borderRadius: 12,
          barThickness: 34
        }
      ]
    },
    options: {
      responsive: true,
      animation: {
        duration: 1600,
        easing: "easeOutQuart"
      },
      plugins: {
        legend: {
          labels: { color: "#ffffff" }
        }
      },
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

function renderDetailChart(reportData) {
  const canvas = document.getElementById("detailBusChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (detailBusChart) {
    detailBusChart.destroy();
  }

  detailBusChart = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["আয়", "ব্যয়"],
      datasets: [
        {
          data: [reportData.income, reportData.expense],
          hoverOffset: 12
        }
      ]
    },
    options: {
      responsive: true,
      animation: {
        duration: 1400,
        easing: "easeOutExpo"
      },
      plugins: {
        legend: {
          labels: { color: "#ffffff" }
        }
      }
    }
  });
}

/* =========================
   MAIN ADVANCED REPORT
========================= */
function applyAdvancedReport() {
  const mode = document.getElementById("reportMode")?.value;
  const buses = getBuses();

  if (!mode) return;

  let income = 0;
  let expense = 0;
  let trips = 0;
  let label = "";

  buses.forEach((bus) => {
    (bus.incomes || []).forEach((item) => {
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return;

      if (mode === "monthYear") {
        const monthEl = document.getElementById("reportMonth");
        const yearEl = document.getElementById("reportYear");
        if (!monthEl || !yearEl) return;

        const m = Number(monthEl.value);
        const y = Number(yearEl.value);

        if (d.getMonth() === m && d.getFullYear() === y) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }

      if (mode === "yearOnly") {
        const yearOnlyEl = document.getElementById("reportYearOnly");
        if (!yearOnlyEl) return;

        const y = Number(yearOnlyEl.value);

        if (d.getFullYear() === y) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }

      if (mode === "singleDate") {
        const singleDateEl = document.getElementById("reportSingleDate");
        if (!singleDateEl) return;

        const target = singleDateEl.value;

        if (item.date === target) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }

      if (mode === "dateRange") {
        const fromEl = document.getElementById("reportFromDate");
        const toEl = document.getElementById("reportToDate");
        if (!fromEl || !toEl) return;

        const from = new Date(fromEl.value);
        const to = new Date(toEl.value);

        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);

        if (d >= from && d <= to) {
          income += Number(item.amount || 0);
          trips += Number(item.trips || 0);
        }
      }
    });

    (bus.expenses || []).forEach((item) => {
      const d = new Date(item.date);
      if (isNaN(d.getTime())) return;

      if (mode === "monthYear") {
        const monthEl = document.getElementById("reportMonth");
        const yearEl = document.getElementById("reportYear");
        if (!monthEl || !yearEl) return;

        const m = Number(monthEl.value);
        const y = Number(yearEl.value);

        if (d.getMonth() === m && d.getFullYear() === y) {
          expense += expenseTotal(item);
        }
      }

      if (mode === "yearOnly") {
        const yearOnlyEl = document.getElementById("reportYearOnly");
        if (!yearOnlyEl) return;

        const y = Number(yearOnlyEl.value);

        if (d.getFullYear() === y) {
          expense += expenseTotal(item);
        }
      }

      if (mode === "singleDate") {
        const singleDateEl = document.getElementById("reportSingleDate");
        if (!singleDateEl) return;

        const target = singleDateEl.value;

        if (item.date === target) {
          expense += expenseTotal(item);
        }
      }

      if (mode === "dateRange") {
        const fromEl = document.getElementById("reportFromDate");
        const toEl = document.getElementById("reportToDate");
        if (!fromEl || !toEl) return;

        const from = new Date(fromEl.value);
        const to = new Date(toEl.value);

        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);

        if (d >= from && d <= to) {
          expense += expenseTotal(item);
        }
      }
    });
  });

  if (mode === "monthYear") {
    const monthEl = document.getElementById("reportMonth");
    const yearEl = document.getElementById("reportYear");
    if (monthEl && yearEl) {
      label = `${monthEl.selectedOptions[0].textContent} ${yearEl.value}`;
    }
  } else if (mode === "yearOnly") {
    const yearOnlyEl = document.getElementById("reportYearOnly");
    if (yearOnlyEl) {
      label = `${yearOnlyEl.value} সালের রিপোর্ট`;
    }
  } else if (mode === "singleDate") {
    const singleDateEl = document.getElementById("reportSingleDate");
    if (singleDateEl) {
      label = `${singleDateEl.value} তারিখের রিপোর্ট`;
    }
  } else if (mode === "dateRange") {
    const fromEl = document.getElementById("reportFromDate");
    const toEl = document.getElementById("reportToDate");
    if (fromEl && toEl) {
      label = `${fromEl.value} থেকে ${toEl.value}`;
    }
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

  lastReportData = { income, expense, balance, trips, label };
  renderChart(lastReportData);
}

/* =========================
   PER BUS REPORT
========================= */
function applyBusDetailReport() {
  const bus = getBuses().find((b) => b.id === currentBusId);
  if (!bus) return;

  const mode = document.getElementById("detailReportMode")?.value;
  if (!mode) return;

  let income = 0;
  let expense = 0;
  let trips = 0;
  let label = "";

  (bus.incomes || []).forEach((item) => {
    const d = new Date(item.date);
    if (isNaN(d.getTime())) return;

    if (mode === "monthYear") {
      const monthEl = document.getElementById("detailMonth");
      const yearEl = document.getElementById("detailYear");
      if (!monthEl || !yearEl) return;

      const m = Number(monthEl.value);
      const y = Number(yearEl.value);

      if (d.getMonth() === m && d.getFullYear() === y) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }

    if (mode === "yearOnly") {
      const yearOnlyEl = document.getElementById("detailYearOnly");
      if (!yearOnlyEl) return;

      const y = Number(yearOnlyEl.value);

      if (d.getFullYear() === y) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }

    if (mode === "singleDate") {
      const singleDateEl = document.getElementById("detailSingleDate");
      if (!singleDateEl) return;

      const target = singleDateEl.value;

      if (item.date === target) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }

    if (mode === "dateRange") {
      const fromEl = document.getElementById("detailFromDate");
      const toEl = document.getElementById("detailToDate");
      if (!fromEl || !toEl) return;

      const from = new Date(fromEl.value);
      const to = new Date(toEl.value);

      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);

      if (d >= from && d <= to) {
        income += Number(item.amount || 0);
        trips += Number(item.trips || 0);
      }
    }
  });

  (bus.expenses || []).forEach((item) => {
    const d = new Date(item.date);
    if (isNaN(d.getTime())) return;

    if (mode === "monthYear") {
      const monthEl = document.getElementById("detailMonth");
      const yearEl = document.getElementById("detailYear");
      if (!monthEl || !yearEl) return;

      const m = Number(monthEl.value);
      const y = Number(yearEl.value);

      if (d.getMonth() === m && d.getFullYear() === y) {
        expense += expenseTotal(item);
      }
    }

    if (mode === "yearOnly") {
      const yearOnlyEl = document.getElementById("detailYearOnly");
      if (!yearOnlyEl) return;

      const y = Number(yearOnlyEl.value);

      if (d.getFullYear() === y) {
        expense += expenseTotal(item);
      }
    }

    if (mode === "singleDate") {
      const singleDateEl = document.getElementById("detailSingleDate");
      if (!singleDateEl) return;

      const target = singleDateEl.value;

      if (item.date === target) {
        expense += expenseTotal(item);
      }
    }

    if (mode === "dateRange") {
      const fromEl = document.getElementById("detailFromDate");
      const toEl = document.getElementById("detailToDate");
      if (!fromEl || !toEl) return;

      const from = new Date(fromEl.value);
      const to = new Date(toEl.value);

      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);

      if (d >= from && d <= to) {
        expense += expenseTotal(item);
      }
    }
  });

  if (mode === "monthYear") {
    const monthEl = document.getElementById("detailMonth");
    const yearEl = document.getElementById("detailYear");
    if (monthEl && yearEl) {
      label = `${monthEl.selectedOptions[0].textContent} ${yearEl.value}`;
    }
  } else if (mode === "yearOnly") {
    const yearOnlyEl = document.getElementById("detailYearOnly");
    if (yearOnlyEl) {
      label = `${yearOnlyEl.value} সালের রিপোর্ট`;
    }
  } else if (mode === "singleDate") {
    const singleDateEl = document.getElementById("detailSingleDate");
    if (singleDateEl) {
      label = `${singleDateEl.value} তারিখের রিপোর্ট`;
    }
  } else if (mode === "dateRange") {
    const fromEl = document.getElementById("detailFromDate");
    const toEl = document.getElementById("detailToDate");
    if (fromEl && toEl) {
      label = `${fromEl.value} থেকে ${toEl.value}`;
    }
  }

  const balance = income - expense;

  const labelEl = document.getElementById("detailReportLabel");
  const incomeEl = document.getElementById("detailReportIncome");
  const expenseEl = document.getElementById("detailReportExpense");
  const tripsEl = document.getElementById("detailReportTrips");
  const bal = document.getElementById("detailReportBalance");

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

  if (bal) {
    bal.innerText = formatMoney(Math.abs(balance));
    setAmountColor(bal, "profitloss", balance);
  }

  lastDetailReportData = { income, expense, balance, trips, label };
  renderDetailChart(lastDetailReportData);
}

/* =========================
   LIST RENDER
========================= */
function renderBusList() {
  const buses = getFilteredBuses();
  const allBuses = getBuses();
  const busList = document.getElementById("busList");
  const emptyState = document.getElementById("emptyBusState");
  const countText = document.getElementById("busCountText");

  if (countText) countText.innerText = allBuses.length;

  renderTopSummary();
  renderWarningCard();

  if (!busList || !emptyState) return;

  if (!allBuses.length) {
    emptyState.classList.remove("hidden");
    busList.innerHTML = "";
    return;
  }

  emptyState.classList.add("hidden");

  if (!buses.length) {
    busList.innerHTML = `
      <div class="empty-state-bus" style="min-height:220px;">
        <div class="empty-bus-icon" style="font-size:54px;">🔎</div>
        <h3 style="font-size:20px;">কোনো ফলাফল নেই</h3>
        <p>Search বা sort পরিবর্তন করুন</p>
      </div>
    `;
    return;
  }

  busList.innerHTML = buses
    .map((bus, index) => {
      const totals = getBusTotals(bus);
      const isProfit = totals.balance >= 0;
      const profitClass = isProfit ? "profit-color" : "loss-color";
      const fitnessLeft = daysLeft(bus.fitness);
      const taxLeft = daysLeft(bus.tax);

      let chips = "";

      if ((bus.status || "Running") === "Running") {
        chips += `<span class="status-chip status-running">Running</span>`;
      } else if ((bus.status || "") === "Maintenance") {
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
        <div class="compact-bus-card" onclick="openBusDetail('${bus.id}')">
          <div class="compact-bus-top">
            <div class="compact-bus-left">
              <div class="compact-bus-icon">🚌</div>

              <div class="compact-bus-meta">
                <div class="compact-bus-number">${index + 1}. ${escapeHtml(bus.number || "-")}</div>
                <div class="compact-bus-route">${escapeHtml(bus.route || "")}</div>
                <div class="compact-bus-badges">${chips}</div>
              </div>
            </div>

            <div class="compact-bus-actions" onclick="event.stopPropagation()">
              <button class="compact-action-btn" onclick="openEditBus('${bus.id}')">✎</button>
              <button class="compact-action-btn" onclick="deleteBus('${bus.id}')">🗑</button>
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
              <span>${isProfit ? "লাভ" : "লস"}</span>
              <strong class="${profitClass}">${formatMoney(Math.abs(totals.balance))}</strong>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

/* =========================
   BUS FORM
========================= */
function resetBusForm() {
  editingBusId = null;

  const titleEl = document.getElementById("busFormTitle");
  if (titleEl) titleEl.innerText = "নতুন বাস";

  [
    "busNumber",
    "busModel",
    "busRoute",
    "busReg",
    "busFitness",
    "busTax",
    "driverName",
    "driverPhone",
    "helperName"
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  const statusEl = document.getElementById("busStatus");
  if (statusEl) statusEl.value = "Running";
}

function openBusForm() {
  resetBusForm();
  document.getElementById("busFormSheet")?.classList.add("show");
}

function closeBusForm() {
  document.getElementById("busFormSheet")?.classList.remove("show");
}

async function saveBus() {
  const number = document.getElementById("busNumber")?.value?.trim() || "";

  if (!number) {
    alert("বাস নম্বর দিতে হবে");
    return;
  }

  const busData = {
    id: editingBusId || generateId("bus"),
    number,
    model: document.getElementById("busModel")?.value?.trim() || "",
    route: document.getElementById("busRoute")?.value?.trim() || "",
    reg: document.getElementById("busReg")?.value?.trim() || "",
    fitness: document.getElementById("busFitness")?.value || "",
    tax: document.getElementById("busTax")?.value || "",
    status: document.getElementById("busStatus")?.value || "Running",
    driver: {
      name: document.getElementById("driverName")?.value?.trim() || "",
      phone: document.getElementById("driverPhone")?.value?.trim() || ""
    },
    helper: {
      name: document.getElementById("helperName")?.value?.trim() || ""
    }
  };

  const buses = getBuses();

  if (editingBusId) {
    const oldBus = buses.find((bus) => bus.id === editingBusId);

    busData.incomes = oldBus?.incomes || [];
    busData.expenses = oldBus?.expenses || [];
    busData.createdAt = oldBus?.createdAt || new Date().toISOString();

    saveBuses(
      buses.map((bus) => {
        return bus.id === editingBusId ? busData : bus;
      })
    );
  } else {
    busData.incomes = [];
    busData.expenses = [];
    busData.createdAt = new Date().toISOString();
    buses.push(busData);
    saveBuses(buses);
  }

  if (isAppOnline()) {
    await rebuildBusHisabMirror();
  }

  closeBusForm();
  renderBusList();
  applyAdvancedReport();
  renderSmartAnalytics();

  if (currentBusId && currentBusId === editingBusId) {
    openBusDetail(currentBusId);
  }
}

function openEditBus(busId) {
  const bus = getBuses().find((item) => item.id === busId);
  if (!bus) return;

  editingBusId = busId;

  const titleEl = document.getElementById("busFormTitle");
  if (titleEl) titleEl.innerText = "বাস Edit করুন";

  document.getElementById("busNumber").value = bus.number || "";
  document.getElementById("busModel").value = bus.model || "";
  document.getElementById("busRoute").value = bus.route || "";
  document.getElementById("busReg").value = bus.reg || "";
  document.getElementById("busFitness").value = bus.fitness || "";
  document.getElementById("busTax").value = bus.tax || "";
  document.getElementById("busStatus").value = bus.status || "Running";
  document.getElementById("driverName").value = bus.driver?.name || "";
  document.getElementById("driverPhone").value = bus.driver?.phone || "";
  document.getElementById("helperName").value = bus.helper?.name || "";

  document.getElementById("busFormSheet")?.classList.add("show");
}

async function deleteBus(busId) {
  if (!confirm("এই বাস delete করতে চান?")) return;

  const targetBus = getBuses().find((bus) => bus.id === busId);

  const updated = getBuses().filter((bus) => bus.id !== busId);
  saveBuses(updated);

  if (isAppOnline() && targetBus) {
    for (const item of targetBus.incomes || []) {
      await removeBusIncomeFromHishab(item.id);
    }

    for (const item of targetBus.expenses || []) {
      await removeBusExpenseFromHishab(item.id);
    }
  }

  if (currentBusId === busId) {
    backToBusList();
  }

  renderBusList();
  applyAdvancedReport();
  renderSmartAnalytics();
}

/* =========================
   DETAIL PAGE
========================= */
function openBusDetail(busId) {
  currentBusId = busId;
  currentTab = "income";

  document.getElementById("busListPage")?.classList.add("hidden");
  document.getElementById("busDetailPage")?.classList.remove("hidden");

  handleDetailReportMode();
  renderBusDetail();
  applyBusDetailReport();
}

function backToBusList() {
  currentBusId = null;
  document.getElementById("busDetailPage")?.classList.add("hidden");
  document.getElementById("busListPage")?.classList.remove("hidden");

  renderBusList();
  applyAdvancedReport();
  renderSmartAnalytics();
}

function openEditCurrentBus() {
  if (!currentBusId) return;
  openEditBus(currentBusId);
}

function switchDetailTab(tab) {
  currentTab = tab;

  document.getElementById("incomeTabBtn")?.classList.toggle("active", tab === "income");
  document.getElementById("expenseTabBtn")?.classList.toggle("active", tab === "expense");
  document.getElementById("addIncomeBtn")?.classList.toggle("hidden", tab !== "income");
  document.getElementById("addExpenseBtn")?.classList.toggle("hidden", tab !== "expense");

  renderBusDetail();
}

function renderBusDetail() {
  const bus = getBuses().find((item) => item.id === currentBusId);
  if (!bus) {
    backToBusList();
    return;
  }

  const totals = getBusTotals(bus);
  const isProfit = totals.balance >= 0;

  document.getElementById("detailBusNumber").innerText = bus.number || "BUS";

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

  if (profitLabel) profitLabel.innerText = isProfit ? "লাভ" : "লস";

  if (profitValue) {
    profitValue.innerText = formatMoney(Math.abs(totals.balance));
    setAmountColor(profitValue, "profitloss", totals.balance);
  }

  if (profitCard) {
    profitCard.classList.remove("profit-border", "loss-border");
    profitCard.classList.add(isProfit ? "profit-border" : "loss-border");
  }

  document.getElementById("incomeTabCount").innerText = (bus.incomes || []).length;
  document.getElementById("expenseTabCount").innerText = (bus.expenses || []).length;

  renderHistory(bus);
}

function renderHistory(bus) {
  const historyList = document.getElementById("historyList");
  const noHistoryState = document.getElementById("noHistoryState");
  const noHistoryText = document.getElementById("noHistoryText");

  if (!historyList || !noHistoryState || !noHistoryText) return;

  if (currentTab === "income") {
    const incomes = bus.incomes || [];

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
        return `
          <div class="history-card">
            <div class="history-top">
              <div>
                <div class="history-date">${escapeHtml(item.date)} · ${Number(item.trips || 0)} ট্রিপ</div>
                <div class="history-meta">Method: ${escapeHtml(getBusIncomeDisplayMethod(item))}</div>
                ${renderBusSplitHtml(item.paymentBreakdown || {})}
              </div>
              <div class="history-amount income-color">+${formatMoney(item.amount)}</div>
            </div>

            <div class="compact-bus-actions" style="justify-content:flex-end;margin-top:10px;">
              <button class="compact-action-btn" onclick="editIncome('${bus.id}','${item.id}')">✎</button>
              <button class="compact-action-btn" onclick="deleteIncome('${bus.id}','${item.id}')">🗑</button>
            </div>
          </div>
        `;
      })
      .join("");
  } else {
    const expenses = bus.expenses || [];

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
        const total = expenseTotal(item);

        return `
          <div class="history-card">
            <div class="history-top">
              <div>
                <div class="history-date">${escapeHtml(item.date)}</div>
                <div class="history-meta">
                  ডিজেল: ${formatMoney(item.diesel || 0)} |
                  সার্ভিস: ${formatMoney(item.service || 0)} |
                  ড্রাইভার: ${formatMoney(item.driverSalary || 0)} |
                  অন্যান্য: ${formatMoney(item.other || 0)}
                </div>
                <div class="history-meta">Method: ${escapeHtml(getBusExpenseDisplayMethod(item))}</div>
                ${renderBusSplitHtml(item.paymentBreakdown || {})}
                ${item.note ? `<div class="history-meta">${escapeHtml(item.note)}</div>` : ""}
              </div>
              <div class="history-amount expense-color">-${formatMoney(total)}</div>
            </div>

            <div class="compact-bus-actions" style="justify-content:flex-end;margin-top:10px;">
              <button class="compact-action-btn" onclick="editExpense('${bus.id}','${item.id}')">✎</button>
              <button class="compact-action-btn" onclick="deleteExpense('${bus.id}','${item.id}')">🗑</button>
            </div>
          </div>
        `;
      })
      .join("");
  }
}

/* =========================
   EDIT INCOME / EXPENSE
========================= */
function editIncome(busId, incomeId) {
  const bus = getBuses().find((b) => b.id === busId);
  if (!bus) return;

  const item = (bus.incomes || []).find((x) => x.id === incomeId);
  if (!item) return;

  currentBusId = busId;
  editingIncomeId = incomeId;

  document.getElementById("incomeDate").value = item.date || "";
  document.getElementById("incomeTrips").value = Number(item.trips || 0) || "";
  document.getElementById("incomeAmount").value = Number(item.amount || 0) || "";

  const methodEl = document.getElementById("busIncomeMethod");
  if (methodEl) {
    methodEl.value = getBusIncomeDisplayMethod(item);
  }

  resetBusSplitInputs("income");
  fillBusSplitInputs("income", item.paymentBreakdown || {});
  toggleBusIncomeSplit();

  document.getElementById("incomeSheet")?.classList.add("show");
}

function editExpense(busId, expenseId) {
  const bus = getBuses().find((b) => b.id === busId);
  if (!bus) return;

  const item = (bus.expenses || []).find((x) => x.id === expenseId);
  if (!item) return;

  currentBusId = busId;
  editingExpenseId = expenseId;

  document.getElementById("expenseDate").value = item.date || "";
  document.getElementById("expenseDiesel").value = Number(item.diesel || 0) || "";
  document.getElementById("expenseService").value = Number(item.service || 0) || "";
  document.getElementById("expenseDriverSalary").value = Number(item.driverSalary || 0) || "";
  document.getElementById("expenseOther").value = Number(item.other || 0) || "";
  document.getElementById("expenseNote").value = item.note || "";

  const methodEl = document.getElementById("busExpenseMethod");
  if (methodEl) {
    methodEl.value = getBusExpenseDisplayMethod(item);
  }

  resetBusSplitInputs("expense");
  fillBusSplitInputs("expense", item.paymentBreakdown || {});
  toggleBusExpenseSplit();

  document.getElementById("expenseSheet")?.classList.add("show");
}

/* =========================
   INCOME
========================= */
function openIncomeSheet() {
  if (!currentBusId) return;

  editingIncomeId = null;

  setToday("incomeDate");
  document.getElementById("incomeTrips").value = "";
  document.getElementById("incomeAmount").value = "";

  const methodEl = document.getElementById("busIncomeMethod");
  if (methodEl) methodEl.value = "Cash";

  resetBusSplitInputs("income");
  toggleBusIncomeSplit();

  document.getElementById("incomeSheet")?.classList.add("show");
}

function closeIncomeSheet() {
  document.getElementById("incomeSheet")?.classList.remove("show");
}

async function saveIncome() {
  const date = document.getElementById("incomeDate")?.value || "";
  const trips = Number(document.getElementById("incomeTrips")?.value || 0);
  let amount = Number(document.getElementById("incomeAmount")?.value || 0);
  const paymentMethod = normalizePaymentMethod(document.getElementById("busIncomeMethod")?.value, "Cash");

  let paymentBreakdown = {};

  if (paymentMethod === "Mixed") {
    paymentBreakdown = getBusSplitObject("income");
    amount = getBusSplitTotal("income");

    if (amount <= 0) {
      alert("Mixed payment-এর জন্য split amount দিন");
      return;
    }
  }

  if (!date || amount <= 0) {
    alert("সঠিক আয় তথ্য দিন");
    return;
  }

  let savedBus = null;
  let savedIncome = null;

  const buses = getBuses().map((bus) => {
    if (bus.id === currentBusId) {
      bus.incomes = bus.incomes || [];

      if (editingIncomeId) {
        bus.incomes = bus.incomes.map((item) => {
          if (item.id !== editingIncomeId) return item;

          const updatedIncome = {
            ...item,
            date,
            trips,
            amount,
            paymentMethod,
            paymentBreakdown
          };

          savedIncome = updatedIncome;
          return updatedIncome;
        });
      } else {
        const newIncome = {
          id: generateId("income"),
          date,
          trips,
          amount,
          paymentMethod,
          paymentBreakdown
        };

        bus.incomes.push(newIncome);
        savedIncome = newIncome;
      }

      savedBus = bus;
    }
    return bus;
  });

  saveBuses(buses);
  await syncBusIncomeToHishab(savedBus, savedIncome);

  editingIncomeId = null;
  closeIncomeSheet();
  renderBusDetail();
  renderBusList();
  applyAdvancedReport();
  applyBusDetailReport();
  renderSmartAnalytics();
}

/* =========================
   EXPENSE
========================= */
function openExpenseSheet() {
  if (!currentBusId) return;

  editingExpenseId = null;

  setToday("expenseDate");
  document.getElementById("expenseDiesel").value = "";
  document.getElementById("expenseService").value = "";
  document.getElementById("expenseDriverSalary").value = "";
  document.getElementById("expenseOther").value = "";
  document.getElementById("expenseNote").value = "";

  const methodEl = document.getElementById("busExpenseMethod");
  if (methodEl) methodEl.value = "Cash";

  resetBusSplitInputs("expense");
  toggleBusExpenseSplit();

  document.getElementById("expenseSheet")?.classList.add("show");
}

function closeExpenseSheet() {
  document.getElementById("expenseSheet")?.classList.remove("show");
}

async function saveExpense() {
  const date = document.getElementById("expenseDate")?.value || "";
  const diesel = Number(document.getElementById("expenseDiesel")?.value || 0);
  const service = Number(document.getElementById("expenseService")?.value || 0);
  const driverSalary = Number(document.getElementById("expenseDriverSalary")?.value || 0);
  const other = Number(document.getElementById("expenseOther")?.value || 0);
  const note = document.getElementById("expenseNote")?.value?.trim() || "";
  const paymentMethod = normalizePaymentMethod(document.getElementById("busExpenseMethod")?.value, "Cash");

  const total = diesel + service + driverSalary + other;
  let paymentBreakdown = {};

  if (paymentMethod === "Mixed") {
    paymentBreakdown = getBusSplitObject("expense");
    const splitTotal = getBusSplitTotal("expense");

    if (splitTotal <= 0) {
      alert("Mixed payment-এর জন্য split amount দিন");
      return;
    }

    if (splitTotal !== total) {
      alert(`Mixed split total ঠিক ${formatMoney(total)} হতে হবে`);
      return;
    }
  }

  if (!date || total <= 0) {
    alert("সঠিক ব্যয় তথ্য দিন");
    return;
  }

  let savedBus = null;
  let savedExpense = null;

  const buses = getBuses().map((bus) => {
    if (bus.id === currentBusId) {
      bus.expenses = bus.expenses || [];

      if (editingExpenseId) {
        bus.expenses = bus.expenses.map((item) => {
          if (item.id !== editingExpenseId) return item;

          const updatedExpense = {
            ...item,
            date,
            diesel,
            service,
            driverSalary,
            other,
            note,
            paymentMethod,
            paymentBreakdown
          };

          savedExpense = updatedExpense;
          return updatedExpense;
        });
      } else {
        const newExpense = {
          id: generateId("expense"),
          date,
          diesel,
          service,
          driverSalary,
          other,
          note,
          paymentMethod,
          paymentBreakdown
        };

        bus.expenses.push(newExpense);
        savedExpense = newExpense;
      }

      savedBus = bus;
    }
    return bus;
  });

  saveBuses(buses);
  await syncBusExpenseToHishab(savedBus, savedExpense);

  editingExpenseId = null;
  closeExpenseSheet();
  renderBusDetail();
  renderBusList();
  applyAdvancedReport();
  applyBusDetailReport();
  renderSmartAnalytics();
}

/* =========================
   DELETE ITEMS
========================= */
async function deleteIncome(busId, incomeId) {
  if (!confirm("এই আয় delete করবেন?")) return;

  const buses = getBuses().map((bus) => {
    if (bus.id === busId) {
      bus.incomes = (bus.incomes || []).filter((item) => item.id !== incomeId);
    }
    return bus;
  });

  saveBuses(buses);
  await removeBusIncomeFromHishab(incomeId);

  renderBusDetail();
  renderBusList();
  applyAdvancedReport();
  applyBusDetailReport();
  renderSmartAnalytics();
}

async function deleteExpense(busId, expenseId) {
  if (!confirm("এই ব্যয় delete করবেন?")) return;

  const buses = getBuses().map((bus) => {
    if (bus.id === busId) {
      bus.expenses = (bus.expenses || []).filter((item) => item.id !== expenseId);
    }
    return bus;
  });

  saveBuses(buses);
  await removeBusExpenseFromHishab(expenseId);

  renderBusDetail();
  renderBusList();
  applyAdvancedReport();
  applyBusDetailReport();
  renderSmartAnalytics();
}

/* =========================
   OUTSIDE CLICK CLOSE
========================= */
function setupSheetOutsideClose() {
  const sheetIds = ["busFormSheet", "incomeSheet", "expenseSheet"];

  sheetIds.forEach((id) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.classList.remove("show");
      }
    });
  });
}

/* =========================
   PDF
========================= */
function downloadBusPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("PDF library load হয়নি");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFontSize(16);
  doc.text("BUS REPORT", 20, 20);

  doc.setFontSize(11);
  doc.text(`Filter: ${lastReportData.label}`, 20, 35);
  doc.text(`Income: ${lastReportData.income}`, 20, 45);
  doc.text(`Expense: ${lastReportData.expense}`, 20, 55);
  doc.text(`Balance: ${lastReportData.balance}`, 20, 65);
  doc.text(`Trips: ${lastReportData.trips}`, 20, 75);

  let y = 90;

  getBuses().forEach((bus, index) => {
    if (y > 260) {
      doc.addPage();
      y = 20;
    }

    const totals = getBusTotals(bus);

    doc.text(`${index + 1}. ${bus.number || "-"}`, 20, y);
    doc.text(`Route: ${bus.route || "-"}`, 25, y + 8);
    doc.text(
      `Income: ${totals.income} | Expense: ${totals.expense} | Balance: ${totals.balance}`,
      25,
      y + 16
    );

    y += 28;
  });

  doc.save("Bus-Report.pdf");
}

/* =========================
   INIT
========================= */
window.addEventListener("online", async () => {
  try {
    await flushBusQueue();
    await loadBusCloudToLocal();
    await rebuildBusHisabMirror();

    renderBusList();
    applyAdvancedReport();
    applyBusDetailReport();
    renderSmartAnalytics();
  } catch (err) {
    console.error("Bus online sync failed:", err);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  const sessionInfo = await resolveBusStorageKey();

  if (!sessionInfo?.authUser && !sessionInfo?.localUser) {
    localStorage.removeItem("loggedInUser");
    window.location.replace("login.html");
    return;
  }

  try {
    await flushBusQueue();
  } catch (err) {
    console.error("Initial bus queue flush failed:", err);
  }

  await loadBusCloudToLocal();

  if (isAppOnline()) {
    await rebuildBusHisabMirror();
  }

  [
    "busIncomeSplitCash",
    "busIncomeSplitBkash",
    "busIncomeSplitNagad",
    "busIncomeSplitRocket",
    "busIncomeSplitUpay",
    "busIncomeSplitBank",
    "busIncomeSplitCard"
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", updateBusIncomeMixedTotal);
  });

  handleReportModeChange();
  handleDetailReportMode();
  renderBusList();
  applyAdvancedReport();
  renderSmartAnalytics();
  setupSheetOutsideClose();
  toggleBusIncomeSplit();
  toggleBusExpenseSplit();
});

/* =========================
   EXPORT
========================= */
window.goDashboard = goDashboard;
window.openBusForm = openBusForm;
window.closeBusForm = closeBusForm;
window.saveBus = saveBus;
window.openEditBus = openEditBus;
window.deleteBus = deleteBus;
window.openBusDetail = openBusDetail;
window.backToBusList = backToBusList;
window.openEditCurrentBus = openEditCurrentBus;
window.switchDetailTab = switchDetailTab;
window.openIncomeSheet = openIncomeSheet;
window.closeIncomeSheet = closeIncomeSheet;
window.saveIncome = saveIncome;
window.openExpenseSheet = openExpenseSheet;
window.closeExpenseSheet = closeExpenseSheet;
window.saveExpense = saveExpense;
window.deleteIncome = deleteIncome;
window.deleteExpense = deleteExpense;
window.editIncome = editIncome;
window.editExpense = editExpense;
window.handleReportModeChange = handleReportModeChange;
window.handleDetailReportMode = handleDetailReportMode;
window.applyAdvancedReport = applyAdvancedReport;
window.applyBusDetailReport = applyBusDetailReport;
window.downloadBusPDF = downloadBusPDF;
window.renderBusList = renderBusList;
window.toggleBusIncomeSplit = toggleBusIncomeSplit;
window.toggleBusExpenseSplit = toggleBusExpenseSplit;