import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

import {
  loadGarageCloudData,
  saveGarageCloudData,
  getEmptyGarageData
} from "./garage-cloud.js";

import {
  upsertHishabSyncEntry,
  deleteHishabSyncEntry
} from "./hishab-bridge.js";

import {
  addSyncTask,
  isAppOnline
} from "./offline-queue.js";

import { flushGarageQueue } from "./garage-sync.js";

/* =========================
   USER / KEYS
========================= */
let GARAGE_NS = "default_user";

let GARAGE_CAR_KEY = "shebaGarageCars_default_user";
let GARAGE_INCOME_KEY = "shebaGarageIncome_default_user";
let GARAGE_EXPENSE_KEY = "shebaGarageExpense_default_user";
let GARAGE_EMPLOYEE_KEY = "shebaGarageEmployee_default_user";
let GARAGE_ATTENDANCE_KEY = "shebaGarageAttendance_default_user";

function makeSafeUserKey(value) {
  return String(value || "default_user")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]@]/g, "_");
}

function makeLegacyGarageNs(userData) {
  return String(
    userData?.username || userData?.email || "default_user"
  ).replace(/[.#$/\[\]]/g, "_");
}

function copyOldGarageDataIfNeeded(oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return;

  const oldValue = localStorage.getItem(oldKey);
  const newValue = localStorage.getItem(newKey);

  if (!newValue && oldValue) {
    localStorage.setItem(newKey, oldValue);
  }
}

async function resolveGarageKeys() {
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

  GARAGE_NS = makeSafeUserKey(identity);

  GARAGE_CAR_KEY = `shebaGarageCars_${GARAGE_NS}`;
  GARAGE_INCOME_KEY = `shebaGarageIncome_${GARAGE_NS}`;
  GARAGE_EXPENSE_KEY = `shebaGarageExpense_${GARAGE_NS}`;
  GARAGE_EMPLOYEE_KEY = `shebaGarageEmployee_${GARAGE_NS}`;
  GARAGE_ATTENDANCE_KEY = `shebaGarageAttendance_${GARAGE_NS}`;

  /* পুরোনো username-based key থাকলে নতুন email-based key-তে copy করবে */
  const legacyNs = makeLegacyGarageNs(localUser || authUser || {});

  const OLD_GARAGE_CAR_KEY = `shebaGarageCars_${legacyNs}`;
  const OLD_GARAGE_INCOME_KEY = `shebaGarageIncome_${legacyNs}`;
  const OLD_GARAGE_EXPENSE_KEY = `shebaGarageExpense_${legacyNs}`;
  const OLD_GARAGE_EMPLOYEE_KEY = `shebaGarageEmployee_${legacyNs}`;
  const OLD_GARAGE_ATTENDANCE_KEY = `shebaGarageAttendance_${legacyNs}`;

  copyOldGarageDataIfNeeded(OLD_GARAGE_CAR_KEY, GARAGE_CAR_KEY);
  copyOldGarageDataIfNeeded(OLD_GARAGE_INCOME_KEY, GARAGE_INCOME_KEY);
  copyOldGarageDataIfNeeded(OLD_GARAGE_EXPENSE_KEY, GARAGE_EXPENSE_KEY);
  copyOldGarageDataIfNeeded(OLD_GARAGE_EMPLOYEE_KEY, GARAGE_EMPLOYEE_KEY);
  copyOldGarageDataIfNeeded(OLD_GARAGE_ATTENDANCE_KEY, GARAGE_ATTENDANCE_KEY);

  return {
    authUser,
    localUser
  };
}
/* =========================
   DOM HELPER
========================= */
const $ = (id) => document.getElementById(id);

/* =========================
   STATE
========================= */
let currentGarageExpenseFilter = "all";
let selectedExpenseCategory = "";
let editingGarageCarId = null;
let editingGarageIncomeId = null;
let editingGarageExpenseId = null;
let editingGarageEmployeeId = null;
let currentGarageCarDetailId = null;
let currentDuePaymentIncomeId = null;
let currentSalaryPaymentEmployeeId = null;
let garageProfitChart = null;
let invoiceCurrentIncomeId = null;

/* =========================
   STORAGE
========================= */
function safeRead(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : fallback;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getGarageCars() {
  return safeRead(GARAGE_CAR_KEY, []);
}
function saveGarageCars(data) {
  localStorage.setItem(GARAGE_CAR_KEY, JSON.stringify(Array.isArray(data) ? data : []));
}

function getGarageIncome() {
  return safeRead(GARAGE_INCOME_KEY, []);
}
function saveGarageIncomeData(data) {
  localStorage.setItem(GARAGE_INCOME_KEY, JSON.stringify(Array.isArray(data) ? data : []));
}

function getGarageExpense() {
  return safeRead(GARAGE_EXPENSE_KEY, []);
}
function saveGarageExpenseData(data) {
  localStorage.setItem(GARAGE_EXPENSE_KEY, JSON.stringify(Array.isArray(data) ? data : []));
}

function getGarageEmployees() {
  return safeRead(GARAGE_EMPLOYEE_KEY, []);
}
function saveGarageEmployees(data) {
  localStorage.setItem(GARAGE_EMPLOYEE_KEY, JSON.stringify(Array.isArray(data) ? data : []));
}

function getGarageAttendance() {
  return safeRead(GARAGE_ATTENDANCE_KEY, []);
}
function saveGarageAttendance(data) {
  localStorage.setItem(GARAGE_ATTENDANCE_KEY, JSON.stringify(Array.isArray(data) ? data : []));
}

/* =========================
   CLOUD SYNC
========================= */
function getGaragePayload() {
  return {
    cars: getGarageCars(),
    income: getGarageIncome(),
    expense: getGarageExpense(),
    employees: getGarageEmployees(),
    attendance: getGarageAttendance()
  };
}

function queueGarageSave() {
  addSyncTask({
    module: "garage",
    action: "save_full_state",
    payload: getGaragePayload()
  });
}

async function pushGarageToCloud() {
  if (!isAppOnline()) {
    queueGarageSave();
    return;
  }

  try {
    await saveGarageCloudData(getGaragePayload());
  } catch (err) {
    console.error("Garage cloud save failed:", err);
    queueGarageSave();
  }
}

async function scanGarageFromCloud() {
  try {
    const data = await loadGarageCloudData();
    const finalData = data || getEmptyGarageData();

    saveGarageCars(Array.isArray(finalData.cars) ? finalData.cars : []);
    saveGarageIncomeData(Array.isArray(finalData.income) ? finalData.income : []);
    saveGarageExpenseData(Array.isArray(finalData.expense) ? finalData.expense : []);
    saveGarageEmployees(Array.isArray(finalData.employees) ? finalData.employees : []);
    saveGarageAttendance(Array.isArray(finalData.attendance) ? finalData.attendance : []);

    renderAllGarage();
  } catch (err) {
    console.error("Garage cloud load failed:", err);
    renderAllGarage();
  }
}

/* =========================
   AUTH / HISHAB MIRROR
========================= */
async function getAuthUserId() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }

  return user.id;
}

/* =========================
   PAYMENT METHOD HELPERS
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

const GARAGE_SPLIT_METHODS = [
  ["Cash", "Cash"],
  ["bKash", "Bkash"],
  ["Nagad", "Nagad"],
  ["Rocket", "Rocket"],
  ["Upay", "Upay"],
  ["Bank", "Bank"],
  ["Card", "Card"]
];

function getGarageSplitInputId(type, suffix) {
  const prefixMap = {
    income: "garageIncomeSplit",
    due: "garageDueSplit",
    expense: "garageExpenseSplit",
    salary: "garageSalarySplit"
  };
  return `${prefixMap[type]}${suffix}`;
}

function resetGarageSplitInputs(type) {
  GARAGE_SPLIT_METHODS.forEach(([, suffix]) => {
    const el = $(getGarageSplitInputId(type, suffix));
    if (el) el.value = "";
  });
}

function fillGarageSplitInputs(type, split = {}) {
  GARAGE_SPLIT_METHODS.forEach(([label, suffix]) => {
    const el = $(getGarageSplitInputId(type, suffix));
    if (el) el.value = Number(split?.[label] || 0) || "";
  });
}

function getGarageSplitObject(type) {
  const obj = {};
  GARAGE_SPLIT_METHODS.forEach(([label, suffix]) => {
    const val = Number($(getGarageSplitInputId(type, suffix))?.value || 0);
    if (val > 0) obj[label] = val;
  });
  return obj;
}

function getGarageSplitTotal(type) {
  return GARAGE_SPLIT_METHODS.reduce((sum, [, suffix]) => {
    return sum + Number($(getGarageSplitInputId(type, suffix))?.value || 0);
  }, 0);
}

function formatGarageSplit(split = {}) {
  return Object.entries(split)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([method, amount]) => `${method} ${formatMoney(amount)}`)
    .join(" | ");
}

function renderGarageSplitHtml(split = {}) {
  const text = formatGarageSplit(split);
  return text ? `<div class="history-meta bigger-subtext">Split: ${escapeHtml(text)}</div>` : "";
}

function getMethodSetFromBreakdown(split = {}) {
  return Object.entries(split)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([method]) => normalizePaymentMethod(method, ""));
}

function getGarageIncomeDisplayMethod(item) {
  const methods = new Set();

  const baseSplitMethods = getMethodSetFromBreakdown(item?.paymentBreakdown || {});
  if (baseSplitMethods.length) {
    baseSplitMethods.forEach((m) => methods.add(m));
  } else {
    const baseMethod = normalizePaymentMethod(item?.paymentMethod || "", "");
    if (Number(item?.paid || 0) > 0 && baseMethod) methods.add(baseMethod);
  }

  (Array.isArray(item?.duePayments) ? item.duePayments : []).forEach((payment) => {
    const splitMethods = getMethodSetFromBreakdown(payment?.split || {});
    if (splitMethods.length) {
      splitMethods.forEach((m) => methods.add(m));
    } else {
      const amount = Number(payment?.amount || 0);
      const method = normalizePaymentMethod(payment?.method || "", "");
      if (amount > 0 && method) methods.add(method);
    }
  });

  if (methods.size > 1) return "Mixed";
  if (methods.size === 1) return [...methods][0];

  if (normalizePaymentMethod(item?.paymentMethod, "Cash") === "Mixed") return "Mixed";
  return normalizePaymentMethod(item?.paymentMethod, "Cash");
}

function getGarageExpenseDisplayMethod(item) {
  const splitMethods = getMethodSetFromBreakdown(item?.paymentBreakdown || {});
  if (splitMethods.length > 1) return "Mixed";
  if (splitMethods.length === 1) return splitMethods[0];
  if (normalizePaymentMethod(item?.paymentMethod, "Cash") === "Mixed") return "Mixed";
  return normalizePaymentMethod(item?.paymentMethod, "Cash");
}

function buildGarageIncomeHisabNote(item) {
  const parts = [];
  if (item?.note) parts.push(item.note);

  const splitText = formatGarageSplit(item?.paymentBreakdown || {});
  if (splitText) parts.push(`Split: ${splitText}`);

  return parts.join(" | ");
}

function buildGarageExpenseHisabNote(item) {
  const parts = [];
  if (item?.note) parts.push(item.note);

  const splitText = formatGarageSplit(item?.paymentBreakdown || {});
  if (splitText) parts.push(`Split: ${splitText}`);

  return parts.join(" | ");
}

function makeGarageIncomeHisabPayload(item) {
  return {
    module_name: "garage",
    entry_type: "income",
    source_table: "garage_income",
    source_id: item.id,
    entry_date: item.date || new Date().toISOString().slice(0, 10),
    party_name: item.customerName || item.carNumber || "",
    category: item.type || "Garage Service",
    total_amount: Number(item.amount || 0),
    paid_amount: Number(item.paid || 0),
    due_amount: Number(item.due || 0),
    payment_method: getGarageIncomeDisplayMethod(item),
    note: buildGarageIncomeHisabNote(item)
  };
}

function makeGarageExpenseHisabPayload(item) {
  return {
    module_name: "garage",
    entry_type: "expense",
    source_table: "garage_expense",
    source_id: item.id,
    entry_date: item.date || new Date().toISOString().slice(0, 10),
    party_name: item.employeeName || "",
    category: item.category || "Garage Expense",
    total_amount: Number(item.amount || 0),
    paid_amount: Number(item.amount || 0),
    due_amount: 0,
    payment_method: getGarageExpenseDisplayMethod(item),
    note: buildGarageExpenseHisabNote(item)
  };
}

async function syncGarageIncomeToHishab(item) {
  if (!item || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeGarageIncomeHisabPayload(item));
  } catch (err) {
    console.error("Garage income -> hishab sync failed:", err);
  }
}

async function syncGarageExpenseToHishab(item) {
  if (!item || !isAppOnline()) return;

  try {
    await upsertHishabSyncEntry(makeGarageExpenseHisabPayload(item));
  } catch (err) {
    console.error("Garage expense -> hishab sync failed:", err);
  }
}

async function removeGarageIncomeFromHishab(incomeId) {
  if (!incomeId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("garage_income", incomeId);
  } catch (err) {
    console.error("Garage income -> hishab delete failed:", err);
  }
}

async function removeGarageExpenseFromHishab(expenseId) {
  if (!expenseId || !isAppOnline()) return;

  try {
    await deleteHishabSyncEntry("garage_expense", expenseId);
  } catch (err) {
    console.error("Garage expense -> hishab delete failed:", err);
  }
}

async function clearGarageHisabMirror() {
  if (!isAppOnline()) return;

  try {
    const userId = await getAuthUserId();

    const { error } = await supabase
      .from("hisab_entries")
      .delete()
      .eq("user_id", userId)
      .in("source_table", ["garage_income", "garage_expense"]);

    if (error) throw error;
  } catch (err) {
    console.error("Clear garage hishab mirror failed:", err);
  }
}

async function rebuildGarageHisabMirror() {
  if (!isAppOnline()) return;

  try {
    await clearGarageHisabMirror();

    const incomes = getGarageIncome();
    const expenses = getGarageExpense();

    for (const item of incomes) {
      await syncGarageIncomeToHishab(item);
    }

    for (const item of expenses) {
      await syncGarageExpenseToHishab(item);
    }
  } catch (err) {
    console.error("Garage hishab rebuild failed:", err);
  }
}

/* =========================
   HELPERS
========================= */
function formatMoney(value) {
  return "৳" + Number(value || 0).toLocaleString("en-US");
}

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function goDashboard() {
  window.location.href = "dashboard.html";
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}

function sameDate(date1, date2) {
  return String(date1 || "") === String(date2 || "");
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  const today = new Date(todayString());
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(dateStr);
  dueDate.setHours(0, 0, 0, 0);
  return dueDate < today;
}

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

function updateIncomeSnapshotsByCar(carId, carData) {
  const incomes = getGarageIncome();
  let changed = false;

  const updated = incomes.map((item) => {
    if (item.carId !== carId) return item;
    changed = true;
    return {
      ...item,
      carNumber: carData?.number || "",
      customerName: carData?.customer || "",
      customerPhone: carData?.phone || ""
    };
  });

  if (changed) {
    saveGarageIncomeData(updated);
  }

  return changed ? updated : incomes;
}

function updateExpenseSnapshotsByEmployee(employeeId, employeeData) {
  const expenses = getGarageExpense();
  let changed = false;

  const updated = expenses.map((item) => {
    if (item.employeeId !== employeeId) return item;
    changed = true;
    return {
      ...item,
      employeeName: employeeData?.name || ""
    };
  });

  if (changed) {
    saveGarageExpenseData(updated);
  }

  return changed ? updated : expenses;
}

/* =========================
   COLOR HELPERS
========================= */
function clearAmountClasses(elm) {
  if (!elm) return;
  elm.classList.remove(
    "income-color",
    "expense-color",
    "profit-color",
    "loss-color",
    "due-color",
    "income",
    "expense",
    "profit",
    "loss"
  );
}

function setAmountColor(elm, type, value = 0) {
  if (!elm) return;

  clearAmountClasses(elm);
  elm.style.removeProperty("color");

  let className = "";
  let color = "";

  if (type === "income") {
    className = "income-color";
    color = "#35de79";
  } else if (type === "expense") {
    className = "expense-color";
    color = "#ef4444";
  } else {
    const isProfit = Number(value) >= 0;
    className = isProfit ? "profit-color" : "loss-color";
    color = isProfit ? "#35de79" : "#ef4444";
  }

  elm.classList.add(className);
  elm.style.setProperty("color", color, "important");
}

function setDueColor(elm) {
  if (!elm) return;
  clearAmountClasses(elm);
  elm.classList.add("due-color");
  elm.style.setProperty("color", "#ffd86f", "important");
}

/* =========================
   THEME
========================= */
function applyGarageTheme() {
  const savedTheme = localStorage.getItem("appTheme") || "light";

  if (savedTheme === "dark") {
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
    document.body.classList.remove("light");
  } else {
    document.documentElement.classList.remove("dark");
    document.body.classList.add("light");
    document.body.classList.remove("dark");
  }
}

/* =========================
   TOTALS
========================= */
function getGarageTotals() {
  const incomes = getGarageIncome();
  const expenses = getGarageExpense();

  const totalPaidIncome = incomes.reduce((sum, item) => sum + Number(item.paid || 0), 0);
  const totalExpense = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return {
    income: totalPaidIncome,
    expense: totalExpense,
    profit: totalPaidIncome - totalExpense
  };
}

function getTodayGarageIncomeTotal() {
  const today = todayString();
  return getGarageIncome()
    .filter((item) => sameDate(item.date, today))
    .reduce((sum, item) => sum + Number(item.paid || 0), 0);
}

function getTodayGarageExpenseTotal() {
  const today = todayString();
  return getGarageExpense()
    .filter((item) => sameDate(item.date, today))
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

function getMonthlyGarageIncomeTotal() {
  const now = new Date();
  return getGarageIncome().reduce((sum, item) => {
    const d = new Date(item.date);
    if (!isNaN(d.getTime()) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
      return sum + Number(item.paid || 0);
    }
    return sum;
  }, 0);
}

function getMonthlyGarageExpenseTotal() {
  const now = new Date();
  return getGarageExpense().reduce((sum, item) => {
    const d = new Date(item.date);
    if (!isNaN(d.getTime()) && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
      return sum + Number(item.amount || 0);
    }
    return sum;
  }, 0);
}

/* =========================
   PAGE NAVIGATION
========================= */
function hideAllGaragePages() {
  $("garageDashboardPage")?.classList.add("hidden");
  $("garageIncomePage")?.classList.add("hidden");
  $("garageExpensePage")?.classList.add("hidden");
  $("garageEmployeePage")?.classList.add("hidden");
  $("garageReportPage")?.classList.add("hidden");
  $("garageCarDetailPage")?.classList.add("hidden");
}

function openGarageIncomePage() {
  hideAllGaragePages();
  $("garageIncomePage")?.classList.remove("hidden");
  renderGarageIncomeList();
}

function openGarageExpensePage() {
  hideAllGaragePages();
  $("garageExpensePage")?.classList.remove("hidden");
  renderGarageExpenseList();
}

function openGarageEmployeePage() {
  hideAllGaragePages();
  $("garageEmployeePage")?.classList.remove("hidden");
  renderGarageEmployeeList();
}

function openGarageReportPage() {
  hideAllGaragePages();
  $("garageReportPage")?.classList.remove("hidden");
  handleGarageReportModeChange();
  applyGarageReport();
}

function openGarageCarDetailPage(carId) {
  currentGarageCarDetailId = carId;
  hideAllGaragePages();
  $("garageCarDetailPage")?.classList.remove("hidden");
  renderGarageCarDetail();
}

function backToGarageHome() {
  hideAllGaragePages();
  $("garageDashboardPage")?.classList.remove("hidden");
  renderGarageDashboard();
}

/* =========================
   DASHBOARD
========================= */
function renderGarageDashboard() {
  const totals = getGarageTotals();

  if ($("garageTotalIncome")) {
    $("garageTotalIncome").innerText = formatMoney(totals.income);
    setAmountColor($("garageTotalIncome"), "income");
  }

  if ($("garageTotalExpense")) {
    $("garageTotalExpense").innerText = formatMoney(totals.expense);
    setAmountColor($("garageTotalExpense"), "expense");
  }

  if ($("garageTotalProfit")) {
    $("garageTotalProfit").innerText = formatMoney(Math.abs(totals.profit));
    setAmountColor($("garageTotalProfit"), "profitloss", totals.profit);
  }

  renderGarageCarList();
  renderRecentGarageIncome();
  renderGarageRiskList();
  renderGarageProfitChart();
}

/* =========================
   RISK / ALERT
========================= */
function renderGarageRiskList() {
  const list = $("garageRiskList");
  const empty = $("garageNoRiskState");
  if (!list || !empty) return;

  const risks = [];
  const incomes = getGarageIncome();
  const employees = getGarageEmployees();

  incomes.forEach((item) => {
    const dueAmount = Number(item.due || 0);
    if (dueAmount > 0) {
      risks.push({
        title: `${item.carNumber || "-"} · Due pending`,
        html: `
          Due <span class="due-color">${formatMoney(dueAmount)}</span>
          ${item.dueDate ? ` | Last Date ${escapeHtml(item.dueDate)}` : ""}
        `
      });
    }
  });

  employees.forEach((emp) => {
    const salaryDue = Number(emp.salaryDue || 0);
    if (salaryDue > 0) {
      risks.push({
        title: `${emp.name || "কর্মচারী"} · Salary unpaid`,
        html: `Due <span class="due-color">${formatMoney(salaryDue)}</span>`
      });
    }
  });

  const todayExpense = Number(getTodayGarageExpenseTotal() || 0);
  const todayIncome = Number(getTodayGarageIncomeTotal() || 0);

  if (todayExpense > todayIncome && todayExpense > 0) {
    risks.push({
      title: "আজ ব্যয় বেশি",
      html: `
        আয় <span class="income-color">${formatMoney(todayIncome)}</span> |
        ব্যয় <span class="expense-color">${formatMoney(todayExpense)}</span>
      `
    });
  }

  if (!risks.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  list.innerHTML = risks
    .slice(0, 8)
    .map((item) => `
      <div class="history-card premium-card">
        <div class="history-date">${escapeHtml(item.title)}</div>
        <div class="history-meta bigger-subtext">${item.html}</div>
      </div>
    `)
    .join("");
}

/* =========================
   CAR
========================= */
function openCarModal() {
  editingGarageCarId = null;
  if ($("garageCarNumber")) $("garageCarNumber").value = "";
  if ($("garageCarCustomer")) $("garageCarCustomer").value = "";
  if ($("garageCarPhone")) $("garageCarPhone").value = "";
  if ($("garageCarAddress")) $("garageCarAddress").value = "";
  $("garageCarModal")?.classList.add("show");
}

function closeCarModal() {
  $("garageCarModal")?.classList.remove("show");
}

async function saveGarageCar() {
  const number = $("garageCarNumber")?.value.trim() || "";
  const customer = $("garageCarCustomer")?.value.trim() || "";
  const phone = $("garageCarPhone")?.value.trim() || "";
  const address = $("garageCarAddress")?.value.trim() || "";

  if (!number) {
    alert("গাড়ির নম্বর দিতে হবে");
    return;
  }

  let cars = getGarageCars();
  let savedCar = null;

  if (editingGarageCarId) {
    cars = cars.map((item) => {
      if (item.id !== editingGarageCarId) return item;
      savedCar = { ...item, number, customer, phone, address };
      return savedCar;
    });
  } else {
    savedCar = {
      id: generateId("car"),
      number,
      customer,
      phone,
      address,
      createdAt: new Date().toISOString()
    };
    cars.push(savedCar);
  }

  saveGarageCars(cars);

  if (savedCar && editingGarageCarId) {
    const updatedIncomes = updateIncomeSnapshotsByCar(savedCar.id, savedCar);
    if (isAppOnline()) {
      for (const item of updatedIncomes.filter((x) => x.carId === savedCar.id)) {
        await syncGarageIncomeToHishab(item);
      }
    }
  }

  closeCarModal();
  updateGarageCarDropdown();
  renderGarageDashboard();
  renderGarageIncomeList();
  if (currentGarageCarDetailId === savedCar?.id) renderGarageCarDetail();
  await pushGarageToCloud();
}

function editGarageCar(id) {
  const car = getGarageCars().find((item) => item.id === id);
  if (!car) return;

  editingGarageCarId = id;
  if ($("garageCarNumber")) $("garageCarNumber").value = car.number || "";
  if ($("garageCarCustomer")) $("garageCarCustomer").value = car.customer || "";
  if ($("garageCarPhone")) $("garageCarPhone").value = car.phone || "";
  if ($("garageCarAddress")) $("garageCarAddress").value = car.address || "";
  $("garageCarModal")?.classList.add("show");
}

async function deleteGarageCar(id) {
  if (!confirm("এই গাড়ি delete করতে চান?")) return;

  const removedIncomeItems = getGarageIncome().filter((item) => item.carId === id);

  saveGarageCars(getGarageCars().filter((item) => item.id !== id));
  saveGarageIncomeData(getGarageIncome().filter((item) => item.carId !== id));

  if (currentGarageCarDetailId === id) {
    currentGarageCarDetailId = null;
  }

  if (isAppOnline()) {
    for (const item of removedIncomeItems) {
      await removeGarageIncomeFromHishab(item.id);
    }
  }

  renderGarageDashboard();
  renderGarageIncomeList();
  updateGarageCarDropdown();
  await pushGarageToCloud();

  if (isAppOnline()) {
    await rebuildGarageHisabMirror();
  }
}

function renderGarageCarList() {
  const list = $("garageCarList");
  const noState = $("garageNoCarState");
  if (!list || !noState) return;

  const search = ($("garageCarSearch")?.value || "").trim().toLowerCase();
  const allCars = getGarageCars();

  const cars = allCars.filter((item) =>
    (item.number || "").toLowerCase().includes(search) ||
    (item.customer || "").toLowerCase().includes(search) ||
    (item.phone || "").toLowerCase().includes(search)
  );

  if (!allCars.length) {
    list.innerHTML = "";
    noState.classList.remove("hidden");
    return;
  }

  if (!cars.length) {
    list.innerHTML = `
      <div class="garage-empty-state small">
        <div class="garage-empty-icon">🔎</div>
        <p>কোনো ফলাফল নেই</p>
      </div>
    `;
    noState.classList.add("hidden");
    return;
  }

  noState.classList.add("hidden");

  list.innerHTML = cars.map((car, index) => {
    const services = getGarageIncome().filter((item) => item.carId === car.id);
    const paidTotal = services.reduce((sum, item) => sum + Number(item.paid || 0), 0);
    const dueTotal = services.reduce((sum, item) => sum + Number(item.due || 0), 0);
    const visitCount = services.length;
    const lastService = services
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];

    return `
      <div class="garage-wide-card premium-card">
        <div class="history-top">
          <div class="garage-car-main" onclick="openGarageCarDetailPage('${car.id}')">
            <div class="history-date bigger-text">${index + 1}. ${escapeHtml(car.number)}</div>
            <div class="history-meta bigger-subtext">
              ${escapeHtml(car.customer || "কাস্টমার নেই")}${car.phone ? " · " + escapeHtml(car.phone) : ""}
            </div>
            <div class="history-meta bigger-subtext">
              Visit ${visitCount} |
              Paid <span class="income-color">${formatMoney(paidTotal)}</span> |
              Due <span class="due-color">${formatMoney(dueTotal)}</span>
            </div>
            ${lastService ? `<div class="history-meta bigger-subtext">Last Service: ${escapeHtml(lastService.type || "-")} · ${escapeHtml(lastService.date || "-")}</div>` : ""}
          </div>

          <div class="compact-bus-actions">
            <button class="compact-action-btn" onclick="editGarageCar('${car.id}')">✎</button>
            <button class="compact-action-btn" onclick="deleteGarageCar('${car.id}')">🗑</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================
   CAR DETAIL
========================= */
function renderDueHistoryHtml(item) {
  const history = Array.isArray(item.duePayments) ? item.duePayments : [];
  if (!history.length) return "";
  return `
    <div class="due-history-wrap">
      <div class="history-meta bigger-subtext"><strong>Due Payment History:</strong></div>
      ${history.map((h) => `
        <div class="history-meta bigger-subtext">
          • <span class="income-color">${formatMoney(h.amount)}</span> paid on ${escapeHtml(h.date || "-")}
          ${h.method ? ` · ${escapeHtml(normalizePaymentMethod(h.method, "Cash"))}` : ""}
        </div>
        ${h.split && Object.keys(h.split).length ? `<div class="history-meta bigger-subtext">   ${escapeHtml(formatGarageSplit(h.split))}</div>` : ""}
      `).join("")}
    </div>
  `;
}

function renderGarageCarDetail() {
  const car = getGarageCars().find((item) => item.id === currentGarageCarDetailId);
  if (!car) {
    backToGarageHome();
    return;
  }

  if ($("garageCarDetailTitle")) $("garageCarDetailTitle").innerText = car.number || "গাড়ির ডিটেইলস";

  const services = getGarageIncome()
    .filter((item) => item.carId === car.id)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if ($("carDetailJobs")) $("carDetailJobs").innerText = services.length;

  if ($("carDetailIncome")) {
    const val = services.reduce((sum, item) => sum + Number(item.paid || 0), 0);
    $("carDetailIncome").innerText = formatMoney(val);
    setAmountColor($("carDetailIncome"), "income");
  }

  if ($("carDetailDue")) {
    const dueVal = services.reduce((sum, item) => sum + Number(item.due || 0), 0);
    $("carDetailDue").innerText = formatMoney(dueVal);
    setDueColor($("carDetailDue"));
  }

  if (!services.length) {
    if ($("garageCarServiceHistory")) $("garageCarServiceHistory").innerHTML = "";
    $("garageCarNoHistory")?.classList.remove("hidden");
    return;
  }

  $("garageCarNoHistory")?.classList.add("hidden");

  if ($("garageCarServiceHistory")) {
    $("garageCarServiceHistory").innerHTML = services.map((item) => {
      const status = Number(item.due || 0) <= 0 ? "Full Paid" : "Due Pending";
      const overdue = item.dueDate && isOverdue(item.dueDate) && Number(item.due || 0) > 0;
      const method = getGarageIncomeDisplayMethod(item);

      return `
        <div class="history-card premium-card">
          <div class="history-top">
            <div>
              <div class="history-date bigger-text">${escapeHtml(item.type || "Service")} · ${status}</div>
              <div class="history-meta bigger-subtext">Date: ${escapeHtml(item.date || "")}</div>
              <div class="history-meta bigger-subtext">
                Total Bill: ${formatMoney(item.amount)} |
                Paid: <span class="income-color">${formatMoney(item.paid)}</span> |
                Due: <span class="due-color">${formatMoney(item.due)}</span>
              </div>
              <div class="history-meta bigger-subtext">Method: ${escapeHtml(method)}</div>
              ${renderGarageSplitHtml(item.paymentBreakdown || {})}
              <div class="history-meta bigger-subtext">Due Date: ${item.dueDate ? escapeHtml(item.dueDate) : "-"}</div>
              ${overdue ? `<div class="history-meta overdue-text">⚠ Due date পার হয়ে গেছে</div>` : ""}
              ${item.note ? `<div class="history-meta bigger-subtext">Details: ${escapeHtml(item.note)}</div>` : ""}
              ${renderDueHistoryHtml(item)}
            </div>
            <div class="history-amount income-color">${formatMoney(item.paid)}</div>
          </div>
          <div class="compact-bus-actions" style="justify-content:flex-end;margin-top:10px;">
            ${Number(item.due || 0) > 0 ? `<button class="compact-action-btn" onclick="openDuePaymentModal('${item.id}')">৳</button>` : ""}
            <button class="compact-action-btn" onclick="openInvoiceModal('${item.id}')">🧾</button>
            <button class="compact-action-btn" onclick="editGarageIncome('${item.id}')">✎</button>
            <button class="compact-action-btn" onclick="deleteGarageIncome('${item.id}')">🗑</button>
          </div>
        </div>
      `;
    }).join("");
  }
}

/* =========================
   SERVICE / INCOME
========================= */
function updateGarageCarDropdown() {
  const cars = getGarageCars();
  const select = $("garageIncomeCar");
  if (!select) return;

  if (!cars.length) {
    select.innerHTML = `<option value="">আগে গাড়ি যোগ করুন</option>`;
    return;
  }

  select.innerHTML = cars.map((item) => `<option value="${item.id}">${escapeHtml(item.number)}</option>`).join("");
}

function updateGarageDuePreview() {
  const amount = Number($("garageIncomeAmount")?.value || 0);
  const paid = Number($("garageIncomePaid")?.value || 0);
  const due = Math.max(amount - paid, 0);
  if ($("garageIncomeDue")) $("garageIncomeDue").value = due || "";
}

function toggleGarageIncomeSplit() {
  const isMixed = $("garageIncomeMethod")?.value === "Mixed";
  $("garageIncomeSplitWrap")?.classList.toggle("hidden", !isMixed);

  if ($("garageIncomePaid")) {
    $("garageIncomePaid").readOnly = isMixed;
  }

  if (!isMixed) {
    resetGarageSplitInputs("income");
  } else {
    updateGarageIncomeMixedTotal();
  }

  updateGarageDuePreview();
}

function updateGarageIncomeMixedTotal() {
  if ($("garageIncomeMethod")?.value !== "Mixed") return;
  const total = getGarageSplitTotal("income");
  if ($("garageIncomePaid")) $("garageIncomePaid").value = total || "";
  updateGarageDuePreview();
}

function openIncomeModal() {
  editingGarageIncomeId = null;
  updateGarageCarDropdown();

  if ($("garageIncomeDate")) $("garageIncomeDate").value = todayString();
  if ($("garageIncomeType")) $("garageIncomeType").value = "";
  if ($("garageIncomeAmount")) $("garageIncomeAmount").value = "";
  if ($("garageIncomePaid")) $("garageIncomePaid").value = "";
  if ($("garageIncomeDue")) $("garageIncomeDue").value = "";
  if ($("garageIncomeDueDate")) $("garageIncomeDueDate").value = "";
  if ($("garageIncomeMethod")) $("garageIncomeMethod").value = "Cash";
  if ($("garageIncomeNote")) $("garageIncomeNote").value = "";

  resetGarageSplitInputs("income");
  toggleGarageIncomeSplit();

  if (!getGarageCars().length) {
    alert("আগে গাড়ি যোগ করুন");
    return;
  }

  $("garageIncomeModal")?.classList.add("show");
}

function closeIncomeModal() {
  $("garageIncomeModal")?.classList.remove("show");
}

async function saveGarageIncome() {
  const date = $("garageIncomeDate")?.value || todayString();
  const carId = $("garageIncomeCar")?.value || "";
  const type = $("garageIncomeType")?.value.trim() || "";
  const note = $("garageIncomeNote")?.value.trim() || "";
  const dueDate = $("garageIncomeDueDate")?.value || "";
  const paymentMethod = normalizePaymentMethod($("garageIncomeMethod")?.value, "Cash");

  const rawAmount = Number($("garageIncomeAmount")?.value || 0);
  let rawPaid = Number($("garageIncomePaid")?.value || 0);
  const rawDue = Number($("garageIncomeDue")?.value || 0);

  let paymentBreakdown = {};

  if (paymentMethod === "Mixed") {
    paymentBreakdown = getGarageSplitObject("income");
    rawPaid = getGarageSplitTotal("income");

    if (rawPaid <= 0) {
      alert("Mixed payment-এর জন্য split amount দিন");
      return;
    }
  }

  if (!date || !carId) {
    alert("তারিখ এবং গাড়ি নির্বাচন করুন");
    return;
  }

  if (!type && rawAmount <= 0 && rawPaid <= 0 && rawDue <= 0 && !note) {
    alert("অন্তত ১টা তথ্য দিন");
    return;
  }

  let amount = rawAmount;
  let paid = rawPaid;
  let due = rawDue;

  if (amount <= 0) {
    amount = Math.max(rawPaid + rawDue, 0);
  }

  if (paid <= 0 && amount > 0) {
    paid = Math.max(amount - rawDue, 0);
  }

  if (due <= 0 && amount > 0) {
    due = Math.max(amount - paid, 0);
  }

  if (paid > amount) {
    amount = paid;
  }

  const car = getGarageCars().find((item) => item.id === carId);
  let incomes = getGarageIncome();

  if (editingGarageIncomeId) {
    const oldItem = incomes.find((x) => x.id === editingGarageIncomeId);

    incomes = incomes.map((item) =>
      item.id === editingGarageIncomeId
        ? {
            ...item,
            date,
            carId,
            carNumber: car?.number || "",
            customerName: car?.customer || "",
            customerPhone: car?.phone || "",
            type,
            amount,
            paid,
            due,
            dueDate,
            paymentMethod,
            paymentBreakdown,
            note,
            duePayments: oldItem?.duePayments || []
          }
        : item
    );
  } else {
    incomes.push({
      id: generateId("income"),
      date,
      carId,
      carNumber: car?.number || "",
      customerName: car?.customer || "",
      customerPhone: car?.phone || "",
      type,
      amount,
      paid,
      due,
      dueDate,
      paymentMethod,
      paymentBreakdown,
      note,
      duePayments: [],
      createdAt: new Date().toISOString()
    });
  }

  saveGarageIncomeData(incomes);

  const latestIncomeItem = editingGarageIncomeId
    ? incomes.find((item) => item.id === editingGarageIncomeId)
    : incomes[incomes.length - 1];

  await syncGarageIncomeToHishab(latestIncomeItem);

  closeIncomeModal();
  renderAllGarage();
  await pushGarageToCloud();
}

function editGarageIncome(id) {
  const item = getGarageIncome().find((x) => x.id === id);
  if (!item) return;

  editingGarageIncomeId = id;
  updateGarageCarDropdown();

  if ($("garageIncomeDate")) $("garageIncomeDate").value = item.date || todayString();
  if ($("garageIncomeCar")) $("garageIncomeCar").value = item.carId || "";
  if ($("garageIncomeType")) $("garageIncomeType").value = item.type || "";
  if ($("garageIncomeAmount")) $("garageIncomeAmount").value = item.amount || "";
  if ($("garageIncomePaid")) $("garageIncomePaid").value = item.paid || "";
  if ($("garageIncomeDue")) $("garageIncomeDue").value = item.due || "";
  if ($("garageIncomeDueDate")) $("garageIncomeDueDate").value = item.dueDate || "";
  if ($("garageIncomeMethod")) $("garageIncomeMethod").value = normalizePaymentMethod(item.paymentMethod, "Cash");
  if ($("garageIncomeNote")) $("garageIncomeNote").value = item.note || "";

  fillGarageSplitInputs("income", item.paymentBreakdown || {});
  toggleGarageIncomeSplit();

  $("garageIncomeModal")?.classList.add("show");
}

async function deleteGarageIncome(id) {
  if (!confirm("এই সার্ভিস / আয় delete করতে চান?")) return;

  saveGarageIncomeData(getGarageIncome().filter((item) => item.id !== id));
  await removeGarageIncomeFromHishab(id);

  renderAllGarage();
  await pushGarageToCloud();
}

function renderGarageIncomeList() {
  const todayEl = $("garageTodayIncome");
  if (todayEl) {
    todayEl.innerText = formatMoney(getTodayGarageIncomeTotal());
    setAmountColor(todayEl, "income");
  }

  const list = $("garageIncomeList");
  const empty = $("garageNoIncomeState");
  if (!list || !empty) return;

  const incomes = getGarageIncome().slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (!incomes.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  list.innerHTML = incomes.map((item) => {
    const status = Number(item.due || 0) <= 0 ? "Full Paid" : "Due Pending";
    const overdue = item.dueDate && isOverdue(item.dueDate) && Number(item.due || 0) > 0;
    const method = getGarageIncomeDisplayMethod(item);

    return `
      <div class="history-card premium-card">
        <div class="history-top">
          <div>
            <div class="history-date bigger-text">${escapeHtml(item.carNumber || "-")} · ${escapeHtml(item.type || "")}</div>
            <div class="history-meta bigger-subtext">Customer: ${escapeHtml(item.customerName || "-")}</div>
            <div class="history-meta bigger-subtext">Status: ${status}</div>
            <div class="history-meta bigger-subtext">Date: ${escapeHtml(item.date || "")}</div>
            <div class="history-meta bigger-subtext">
              Total Bill: ${formatMoney(item.amount)} |
              Paid: <span class="income-color">${formatMoney(item.paid)}</span> |
              Due: <span class="due-color">${formatMoney(item.due)}</span>
            </div>
            <div class="history-meta bigger-subtext">Method: ${escapeHtml(method)}</div>
            ${renderGarageSplitHtml(item.paymentBreakdown || {})}
            <div class="history-meta bigger-subtext">Due Date: ${item.dueDate ? escapeHtml(item.dueDate) : "-"}</div>
            ${overdue ? `<div class="history-meta overdue-text">⚠ Due date পার হয়ে গেছে</div>` : ""}
            ${item.note ? `<div class="history-meta bigger-subtext">Details: ${escapeHtml(item.note)}</div>` : ""}
            ${renderDueHistoryHtml(item)}
          </div>
          <div class="history-amount income-color">${formatMoney(item.paid)}</div>
        </div>
        <div class="compact-bus-actions" style="justify-content:flex-end;margin-top:10px;">
          ${Number(item.due || 0) > 0 ? `<button class="compact-action-btn" onclick="openDuePaymentModal('${item.id}')">৳</button>` : ""}
          <button class="compact-action-btn" onclick="openInvoiceModal('${item.id}')">🧾</button>
          <button class="compact-action-btn" onclick="editGarageIncome('${item.id}')">✎</button>
          <button class="compact-action-btn" onclick="deleteGarageIncome('${item.id}')">🗑</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderRecentGarageIncome() {
  const list = $("recentGarageIncomeList");
  const empty = $("garageNoRecentIncome");
  if (!list || !empty) return;

  const incomes = getGarageIncome()
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .slice(0, 5);

  if (!incomes.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  list.innerHTML = incomes.map((item) => {
    const status = Number(item.due || 0) <= 0 ? "Full Paid" : "Due Pending";
    const method = getGarageIncomeDisplayMethod(item);

    return `
      <div class="history-card premium-card">
        <div class="history-top">
          <div>
            <div class="history-date bigger-text">${escapeHtml(item.carNumber || "-")} · ${escapeHtml(item.type || "")}</div>
            <div class="history-meta bigger-subtext">Status: ${status} · Date: ${escapeHtml(item.date || "")}</div>
            <div class="history-meta bigger-subtext">
              Bill: ${formatMoney(item.amount)} |
              Paid: <span class="income-color">${formatMoney(item.paid)}</span> |
              Due: <span class="due-color">${formatMoney(item.due)}</span>
            </div>
            <div class="history-meta bigger-subtext">Method: ${escapeHtml(method)}</div>
            ${renderGarageSplitHtml(item.paymentBreakdown || {})}
          </div>
          <div class="history-amount income-color">${formatMoney(item.paid)}</div>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================
   DUE PAYMENT
========================= */
function toggleGarageDueSplit() {
  const isMixed = $("garageDuePayMethod")?.value === "Mixed";
  $("garageDueSplitWrap")?.classList.toggle("hidden", !isMixed);

  if ($("garageDuePayAmount")) {
    $("garageDuePayAmount").readOnly = isMixed;
  }

  if (!isMixed) {
    resetGarageSplitInputs("due");
  } else {
    updateGarageDueMixedTotal();
  }
}

function updateGarageDueMixedTotal() {
  if ($("garageDuePayMethod")?.value !== "Mixed") return;
  const total = getGarageSplitTotal("due");
  if ($("garageDuePayAmount")) $("garageDuePayAmount").value = total || "";
}

function openDuePaymentModal(incomeId) {
  const item = getGarageIncome().find((x) => x.id === incomeId);
  if (!item) return;

  currentDuePaymentIncomeId = incomeId;
  if ($("garageDueCurrent")) $("garageDueCurrent").value = Number(item.due || 0);
  if ($("garageDuePayAmount")) $("garageDuePayAmount").value = "";
  if ($("garageDuePayDate")) $("garageDuePayDate").value = todayString();
  if ($("garageDuePayMethod")) $("garageDuePayMethod").value = "Cash";

  resetGarageSplitInputs("due");
  toggleGarageDueSplit();

  $("garageDuePaymentModal")?.classList.add("show");
}

function closeDuePaymentModal() {
  $("garageDuePaymentModal")?.classList.remove("show");
  currentDuePaymentIncomeId = null;
}

async function saveDuePayment() {
  let payAmount = Number($("garageDuePayAmount")?.value || 0);
  const payDate = $("garageDuePayDate")?.value || todayString();
  const payMethod = normalizePaymentMethod($("garageDuePayMethod")?.value, "Cash");

  let split = {};

  if (payMethod === "Mixed") {
    split = getGarageSplitObject("due");
    payAmount = getGarageSplitTotal("due");

    if (payAmount <= 0) {
      alert("Mixed payment-এর জন্য split amount দিন");
      return;
    }
  }

  if (!currentDuePaymentIncomeId) return;
  if (payAmount <= 0) {
    alert("সঠিক পরিমাণ দিন");
    return;
  }

  let incomes = getGarageIncome();
  const item = incomes.find((x) => x.id === currentDuePaymentIncomeId);
  if (!item) return;

  if (payAmount > Number(item.due || 0)) {
    alert("Due amount এর চেয়ে বেশি দেওয়া যাবে না");
    return;
  }

  incomes = incomes.map((x) => {
    if (x.id !== currentDuePaymentIncomeId) return x;

    const newPaid = Number(x.paid || 0) + payAmount;
    const newDue = Number(x.amount || 0) - newPaid;
    const history = Array.isArray(x.duePayments) ? x.duePayments.slice() : [];
    history.push({ amount: payAmount, date: payDate, method: payMethod, split });

    return {
      ...x,
      paid: newPaid,
      due: Math.max(newDue, 0),
      duePayments: history
    };
  });

  saveGarageIncomeData(incomes);

  const updatedIncomeItem = incomes.find((x) => x.id === currentDuePaymentIncomeId);
  await syncGarageIncomeToHishab(updatedIncomeItem);

  closeDuePaymentModal();
  renderAllGarage();
  await pushGarageToCloud();
}

async function markGarageFullPaid() {
  if (!currentDuePaymentIncomeId) return;

  let incomes = getGarageIncome();
  const item = incomes.find((x) => x.id === currentDuePaymentIncomeId);
  if (!item) return;

  const due = Number(item.due || 0);
  if (due <= 0) {
    closeDuePaymentModal();
    return;
  }

  const date = $("garageDuePayDate")?.value || todayString();
  const method = normalizePaymentMethod($("garageDuePayMethod")?.value, "Cash");
  let split = {};

  if (method === "Mixed") {
    split = getGarageSplitObject("due");
    const total = getGarageSplitTotal("due");

    if (total !== due) {
      alert(`Mixed split total ঠিক ${formatMoney(due)} হতে হবে`);
      return;
    }
  }

  incomes = incomes.map((x) => {
    if (x.id !== currentDuePaymentIncomeId) return x;

    const history = Array.isArray(x.duePayments) ? x.duePayments.slice() : [];
    history.push({ amount: due, date, method, split });

    return {
      ...x,
      paid: Number(x.amount || 0),
      due: 0,
      duePayments: history
    };
  });

  saveGarageIncomeData(incomes);

  const updatedIncomeItem = incomes.find((x) => x.id === currentDuePaymentIncomeId);
  await syncGarageIncomeToHishab(updatedIncomeItem);

  closeDuePaymentModal();
  renderAllGarage();
  await pushGarageToCloud();
}

/* =========================
   EXPENSE
========================= */
function toggleGarageExpenseSplit() {
  const isMixed = $("garageExpenseMethod")?.value === "Mixed";
  $("garageExpenseSplitWrap")?.classList.toggle("hidden", !isMixed);

  if ($("garageExpenseAmount")) {
    $("garageExpenseAmount").readOnly = isMixed;
  }

  if (!isMixed) {
    resetGarageSplitInputs("expense");
  } else {
    updateGarageExpenseMixedTotal();
  }
}

function updateGarageExpenseMixedTotal() {
  if ($("garageExpenseMethod")?.value !== "Mixed") return;
  const total = getGarageSplitTotal("expense");
  if ($("garageExpenseAmount")) $("garageExpenseAmount").value = total || "";
}

function selectExpenseCategory(category, btn) {
  selectedExpenseCategory = category;

  document.querySelectorAll(".expense-select-chip").forEach((chip) => chip.classList.remove("active"));
  if (btn) btn.classList.add("active");

  if ($("garageExpenseEmployeeWrap")) {
    $("garageExpenseEmployeeWrap").style.display = category === "কর্মচারী বেতন" ? "block" : "none";
  }

  updateEmployeeDropdown();
}

function updateEmployeeDropdown() {
  const employees = getGarageEmployees();

  const expenseSelect = $("garageExpenseEmployee");
  const attendanceSelect = $("garageAttendanceEmployee");

  if (expenseSelect) {
    expenseSelect.innerHTML =
      `<option value="">কর্মচারী বাছাই করুন</option>` +
      employees.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
  }

  if (attendanceSelect) {
    attendanceSelect.innerHTML =
      `<option value="">কর্মচারী বাছাই করুন</option>` +
      employees.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
  }
}

function openExpenseModal() {
  editingGarageExpenseId = null;
  selectedExpenseCategory = "";
  if ($("garageExpenseDate")) $("garageExpenseDate").value = todayString();
  if ($("garageExpenseNote")) $("garageExpenseNote").value = "";
  if ($("garageExpenseAmount")) $("garageExpenseAmount").value = "";
  if ($("garageExpenseMethod")) $("garageExpenseMethod").value = "Cash";

  resetGarageSplitInputs("expense");
  toggleGarageExpenseSplit();

  document.querySelectorAll(".expense-select-chip").forEach((chip) => chip.classList.remove("active"));
  if ($("garageExpenseEmployeeWrap")) $("garageExpenseEmployeeWrap").style.display = "none";

  updateEmployeeDropdown();
  $("garageExpenseModal")?.classList.add("show");
}

function closeExpenseModal() {
  $("garageExpenseModal")?.classList.remove("show");
}

async function saveGarageExpense() {
  const date = $("garageExpenseDate")?.value || todayString();
  const note = $("garageExpenseNote")?.value.trim() || "";
  let amount = Number($("garageExpenseAmount")?.value || 0);
  const employeeId = $("garageExpenseEmployee")?.value || "";
  const paymentMethod = normalizePaymentMethod($("garageExpenseMethod")?.value, "Cash");

  let paymentBreakdown = {};

  if (paymentMethod === "Mixed") {
    paymentBreakdown = getGarageSplitObject("expense");
    amount = getGarageSplitTotal("expense");

    if (amount <= 0) {
      alert("Mixed payment-এর জন্য split amount দিন");
      return;
    }
  }

  if (!date || !selectedExpenseCategory) {
    alert("ক্যাটাগরি ও তারিখ দিন");
    return;
  }

  if (amount <= 0 && !note) {
    alert("অন্তত amount বা details দিন");
    return;
  }

  const employee = getGarageEmployees().find((item) => item.id === employeeId);
  let expenses = getGarageExpense();

  const itemData = {
    date,
    category: selectedExpenseCategory,
    employeeId: selectedExpenseCategory === "কর্মচারী বেতন" ? employeeId : "",
    employeeName: selectedExpenseCategory === "কর্মচারী বেতন" ? (employee?.name || "") : "",
    note,
    amount: Math.max(amount, 0),
    paymentMethod,
    paymentBreakdown
  };

  if (editingGarageExpenseId) {
    expenses = expenses.map((item) =>
      item.id === editingGarageExpenseId ? { ...item, ...itemData } : item
    );
  } else {
    expenses.push({
      id: generateId("expense"),
      ...itemData,
      createdAt: new Date().toISOString()
    });
  }

  saveGarageExpenseData(expenses);

  const latestExpenseItem = editingGarageExpenseId
    ? expenses.find((item) => item.id === editingGarageExpenseId)
    : expenses[expenses.length - 1];

  await syncGarageExpenseToHishab(latestExpenseItem);

  closeExpenseModal();
  renderAllGarage();
  await pushGarageToCloud();
}

function editGarageExpense(id) {
  const item = getGarageExpense().find((x) => x.id === id);
  if (!item) return;

  editingGarageExpenseId = id;
  selectedExpenseCategory = item.category || "";

  if ($("garageExpenseDate")) $("garageExpenseDate").value = item.date || todayString();
  if ($("garageExpenseNote")) $("garageExpenseNote").value = item.note || "";
  if ($("garageExpenseAmount")) $("garageExpenseAmount").value = item.amount || "";
  if ($("garageExpenseMethod")) $("garageExpenseMethod").value = normalizePaymentMethod(item.paymentMethod, "Cash");

  fillGarageSplitInputs("expense", item.paymentBreakdown || {});
  toggleGarageExpenseSplit();

  updateEmployeeDropdown();
  if ($("garageExpenseEmployee")) $("garageExpenseEmployee").value = item.employeeId || "";

  document.querySelectorAll(".expense-select-chip").forEach((chip) => {
    chip.classList.remove("active");
    if (chip.textContent.trim() === item.category) chip.classList.add("active");
  });

  if ($("garageExpenseEmployeeWrap")) {
    $("garageExpenseEmployeeWrap").style.display = item.category === "কর্মচারী বেতন" ? "block" : "none";
  }

  $("garageExpenseModal")?.classList.add("show");
}

async function deleteGarageExpense(id) {
  if (!confirm("এই ব্যয় delete করতে চান?")) return;

  saveGarageExpenseData(getGarageExpense().filter((item) => item.id !== id));
  await removeGarageExpenseFromHishab(id);

  renderAllGarage();
  await pushGarageToCloud();
}

function filterGarageExpense(category, btn) {
  currentGarageExpenseFilter = category;
  document.querySelectorAll("#garageExpensePage .garage-chip").forEach((chip) => chip.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderGarageExpenseList();
}

function renderGarageExpenseList() {
  const totalEl = $("garageExpenseTotalPage");
  const list = $("garageExpenseList");
  const empty = $("garageNoExpenseState");
  if (!list || !empty) return;

  const all = getGarageExpense().slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const filtered = currentGarageExpenseFilter === "all"
    ? all
    : all.filter((item) => item.category === currentGarageExpenseFilter);

  if (totalEl) {
    totalEl.innerText = formatMoney(all.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    setAmountColor(totalEl, "expense");
  }

  if (!filtered.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  list.innerHTML = filtered.map((item) => `
    <div class="history-card premium-card">
      <div class="history-top">
        <div>
          <div class="history-date bigger-text">${escapeHtml(item.category || "-")}</div>
          <div class="history-meta bigger-subtext">${escapeHtml(item.date || "")}${item.employeeName ? " · " + escapeHtml(item.employeeName) : ""}</div>
          <div class="history-meta bigger-subtext">Method: ${escapeHtml(getGarageExpenseDisplayMethod(item))}</div>
          ${renderGarageSplitHtml(item.paymentBreakdown || {})}
          ${item.note ? `<div class="history-meta bigger-subtext">Details: ${escapeHtml(item.note)}</div>` : ""}
        </div>
        <div class="history-amount expense-color">-${formatMoney(item.amount)}</div>
      </div>
      <div class="compact-bus-actions" style="justify-content:flex-end;margin-top:10px;">
        <button class="compact-action-btn" onclick="editGarageExpense('${item.id}')">✎</button>
        <button class="compact-action-btn" onclick="deleteGarageExpense('${item.id}')">🗑</button>
      </div>
    </div>
  `).join("");
}

/* =========================
   EMPLOYEE / SALARY / ATTENDANCE
========================= */
function toggleGarageSalarySplit() {
  const isMixed = $("garageSalaryPayMethod")?.value === "Mixed";
  $("garageSalarySplitWrap")?.classList.toggle("hidden", !isMixed);

  if ($("garageSalaryPayAmount")) {
    $("garageSalaryPayAmount").readOnly = isMixed;
  }

  if (!isMixed) {
    resetGarageSplitInputs("salary");
  } else {
    updateGarageSalaryMixedTotal();
  }
}

function updateGarageSalaryMixedTotal() {
  if ($("garageSalaryPayMethod")?.value !== "Mixed") return;
  const total = getGarageSplitTotal("salary");
  if ($("garageSalaryPayAmount")) $("garageSalaryPayAmount").value = total || "";
}

function openEmployeeModal() {
  editingGarageEmployeeId = null;
  if ($("garageEmployeeName")) $("garageEmployeeName").value = "";
  if ($("garageEmployeePost")) $("garageEmployeePost").value = "";
  if ($("garageEmployeePhone")) $("garageEmployeePhone").value = "";
  if ($("garageEmployeeSalary")) $("garageEmployeeSalary").value = "";
  $("garageEmployeeModal")?.classList.add("show");
}

function closeEmployeeModal() {
  $("garageEmployeeModal")?.classList.remove("show");
}

async function saveGarageEmployee() {
  const name = $("garageEmployeeName")?.value.trim() || "";
  const post = $("garageEmployeePost")?.value.trim() || "";
  const phone = $("garageEmployeePhone")?.value.trim() || "";
  const salary = Number($("garageEmployeeSalary")?.value || 0);

  if (!name) {
    alert("নাম দিন");
    return;
  }

  let employees = getGarageEmployees();
  let savedEmployee = null;

  if (editingGarageEmployeeId) {
    employees = employees.map((item) => {
      if (item.id !== editingGarageEmployeeId) return item;

      const newSalary = Math.max(salary, 0);
      const alreadyPaid = Number(item.salaryPaid || 0);
      const salaryDue = Math.max(newSalary - alreadyPaid, 0);

      savedEmployee = {
        ...item,
        name,
        post,
        phone,
        salary: newSalary,
        salaryDue
      };

      return savedEmployee;
    });
  } else {
    savedEmployee = {
      id: generateId("employee"),
      name,
      post,
      phone,
      salary: Math.max(salary, 0),
      salaryPaid: 0,
      salaryDue: Math.max(salary, 0),
      salaryHistory: [],
      createdAt: new Date().toISOString()
    };
    employees.push(savedEmployee);
  }

  saveGarageEmployees(employees);

  if (savedEmployee && editingGarageEmployeeId) {
    const updatedExpenses = updateExpenseSnapshotsByEmployee(savedEmployee.id, savedEmployee);
    if (isAppOnline()) {
      for (const item of updatedExpenses.filter((x) => x.employeeId === savedEmployee.id)) {
        await syncGarageExpenseToHishab(item);
      }
    }
  }

  closeEmployeeModal();
  updateEmployeeDropdown();
  renderGarageEmployeeList();
  await pushGarageToCloud();
}

function editGarageEmployee(id) {
  const item = getGarageEmployees().find((x) => x.id === id);
  if (!item) return;

  editingGarageEmployeeId = id;
  if ($("garageEmployeeName")) $("garageEmployeeName").value = item.name || "";
  if ($("garageEmployeePost")) $("garageEmployeePost").value = item.post || "";
  if ($("garageEmployeePhone")) $("garageEmployeePhone").value = item.phone || "";
  if ($("garageEmployeeSalary")) $("garageEmployeeSalary").value = item.salary || "";
  $("garageEmployeeModal")?.classList.add("show");
}

async function deleteGarageEmployee(id) {
  if (!confirm("এই কর্মচারী delete করতে চান?")) return;

  saveGarageEmployees(getGarageEmployees().filter((item) => item.id !== id));
  renderGarageEmployeeList();
  updateEmployeeDropdown();
  await pushGarageToCloud();
}

function renderSalaryHistoryHtml(emp) {
  const history = Array.isArray(emp.salaryHistory) ? emp.salaryHistory : [];
  if (!history.length) return "";
  return `
    <div class="due-history-wrap">
      <div class="history-meta bigger-subtext"><strong>Salary History:</strong></div>
      ${history.map((h) => `
        <div class="history-meta bigger-subtext">
          • <span class="income-color">${formatMoney(h.amount)}</span> paid on ${escapeHtml(h.date || "-")}
          ${h.method ? ` · ${escapeHtml(normalizePaymentMethod(h.method, "Cash"))}` : ""}
        </div>
        ${h.split && Object.keys(h.split).length ? `<div class="history-meta bigger-subtext">   ${escapeHtml(formatGarageSplit(h.split))}</div>` : ""}
      `).join("")}
    </div>
  `;
}

function getAttendanceSummary(employeeId) {
  const attendance = getGarageAttendance().filter((x) => x.employeeId === employeeId);
  return {
    present: attendance.filter((x) => x.status === "Present").length,
    absent: attendance.filter((x) => x.status === "Absent").length,
    half: attendance.filter((x) => x.status === "Half-day").length,
    overtime: attendance.filter((x) => x.status === "Overtime").length
  };
}

function renderGarageEmployeeList() {
  const countEl = $("garageEmployeeCount");
  const totalEl = $("garageTotalSalary");
  const list = $("garageEmployeeList");
  const empty = $("garageNoEmployeeState");
  if (!list || !empty) return;

  const employees = getGarageEmployees().slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  if (countEl) countEl.innerText = employees.length;

  if (totalEl) {
    totalEl.innerText = "মোট বেতন: " + formatMoney(
      employees.reduce((sum, item) => sum + Number(item.salary || 0), 0)
    );
    setAmountColor(totalEl, "expense");
  }

  if (!employees.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  list.innerHTML = employees.map((item) => {
    const att = getAttendanceSummary(item.id);
    return `
      <div class="history-card premium-card">
        <div class="history-top">
          <div>
            <div class="history-date bigger-text">${escapeHtml(item.name)}</div>
            <div class="history-meta bigger-subtext">${escapeHtml(item.post || "কর্মচারী")}${item.phone ? " · " + escapeHtml(item.phone) : ""}</div>
            <div class="history-meta bigger-subtext">
              মাসিক বেতন <span class="expense-color">${formatMoney(item.salary)}</span> |
              Paid <span class="income-color">${formatMoney(item.salaryPaid || 0)}</span> |
              Due <span class="due-color">${formatMoney(item.salaryDue || 0)}</span>
            </div>
            <div class="history-meta bigger-subtext">Attendance: P ${att.present} | A ${att.absent} | H ${att.half} | O ${att.overtime}</div>
            ${renderSalaryHistoryHtml(item)}
          </div>
          <div class="history-amount expense-color">${formatMoney(item.salary)}</div>
        </div>
        <div class="compact-bus-actions" style="justify-content:flex-end;margin-top:10px;">
          <button class="compact-action-btn" onclick="openSalaryPaymentModal('${item.id}')">৳</button>
          <button class="compact-action-btn" onclick="editGarageEmployee('${item.id}')">✎</button>
          <button class="compact-action-btn" onclick="deleteGarageEmployee('${item.id}')">🗑</button>
        </div>
      </div>
    `;
  }).join("");
}

function openSalaryPaymentModal(employeeId) {
  const emp = getGarageEmployees().find((x) => x.id === employeeId);
  if (!emp) return;

  currentSalaryPaymentEmployeeId = employeeId;
  if ($("garageSalaryEmployeeName")) $("garageSalaryEmployeeName").value = emp.name || "";
  if ($("garageSalaryCurrentDue")) $("garageSalaryCurrentDue").value = Number(emp.salaryDue || 0);
  if ($("garageSalaryPayAmount")) $("garageSalaryPayAmount").value = "";
  if ($("garageSalaryPayDate")) $("garageSalaryPayDate").value = todayString();
  if ($("garageSalaryPayMethod")) $("garageSalaryPayMethod").value = "Cash";

  resetGarageSplitInputs("salary");
  toggleGarageSalarySplit();

  $("garageSalaryPaymentModal")?.classList.add("show");
}

function closeSalaryPaymentModal() {
  $("garageSalaryPaymentModal")?.classList.remove("show");
  currentSalaryPaymentEmployeeId = null;
}

async function saveSalaryPayment() {
  let amount = Number($("garageSalaryPayAmount")?.value || 0);
  const date = $("garageSalaryPayDate")?.value || todayString();
  const method = normalizePaymentMethod($("garageSalaryPayMethod")?.value, "Cash");
  let split = {};

  if (method === "Mixed") {
    split = getGarageSplitObject("salary");
    amount = getGarageSplitTotal("salary");

    if (amount <= 0) {
      alert("Mixed payment-এর জন্য split amount দিন");
      return;
    }
  }

  if (!currentSalaryPaymentEmployeeId) return;
  if (amount <= 0) {
    alert("সঠিক amount দিন");
    return;
  }

  let employees = getGarageEmployees();
  const emp = employees.find((x) => x.id === currentSalaryPaymentEmployeeId);
  if (!emp) return;

  if (amount > Number(emp.salaryDue || 0)) {
    alert("Salary due এর চেয়ে বেশি দেওয়া যাবে না");
    return;
  }

  employees = employees.map((x) => {
    if (x.id !== currentSalaryPaymentEmployeeId) return x;

    const newPaid = Number(x.salaryPaid || 0) + amount;
    const newDue = Math.max(Number(x.salary || 0) - newPaid, 0);
    const history = Array.isArray(x.salaryHistory) ? x.salaryHistory.slice() : [];
    history.push({ amount, date, method, split });

    return {
      ...x,
      salaryPaid: newPaid,
      salaryDue: newDue,
      salaryHistory: history
    };
  });

  saveGarageEmployees(employees);
  closeSalaryPaymentModal();
  renderGarageEmployeeList();
  renderGarageRiskList();
  await pushGarageToCloud();
}

async function markSalaryFullPaid() {
  if (!currentSalaryPaymentEmployeeId) return;

  let employees = getGarageEmployees();
  const emp = employees.find((x) => x.id === currentSalaryPaymentEmployeeId);
  if (!emp) return;

  const due = Number(emp.salaryDue || 0);
  if (due <= 0) {
    closeSalaryPaymentModal();
    return;
  }

  const date = $("garageSalaryPayDate")?.value || todayString();
  const method = normalizePaymentMethod($("garageSalaryPayMethod")?.value, "Cash");
  let split = {};

  if (method === "Mixed") {
    split = getGarageSplitObject("salary");
    const total = getGarageSplitTotal("salary");

    if (total !== due) {
      alert(`Mixed split total ঠিক ${formatMoney(due)} হতে হবে`);
      return;
    }
  }

  employees = employees.map((x) => {
    if (x.id !== currentSalaryPaymentEmployeeId) return x;

    const history = Array.isArray(x.salaryHistory) ? x.salaryHistory.slice() : [];
    history.push({ amount: due, date, method, split });

    return {
      ...x,
      salaryPaid: Number(x.salary || 0),
      salaryDue: 0,
      salaryHistory: history
    };
  });

  saveGarageEmployees(employees);
  closeSalaryPaymentModal();
  renderGarageEmployeeList();
  renderGarageRiskList();
  await pushGarageToCloud();
}

function openAttendanceModal() {
  updateEmployeeDropdown();
  if ($("garageAttendanceDate")) $("garageAttendanceDate").value = todayString();
  if ($("garageAttendanceStatus")) $("garageAttendanceStatus").value = "Present";
  $("garageAttendanceModal")?.classList.add("show");
}

function closeAttendanceModal() {
  $("garageAttendanceModal")?.classList.remove("show");
}

async function saveAttendance() {
  const employeeId = $("garageAttendanceEmployee")?.value || "";
  const date = $("garageAttendanceDate")?.value || "";
  const status = $("garageAttendanceStatus")?.value || "Present";

  if (!employeeId || !date) {
    alert("সব তথ্য দিন");
    return;
  }

  let attendance = getGarageAttendance();
  const existingIndex = attendance.findIndex((x) => x.employeeId === employeeId && x.date === date);
  const employee = getGarageEmployees().find((x) => x.id === employeeId);

  const item = {
    id: existingIndex >= 0 ? attendance[existingIndex].id : generateId("attendance"),
    employeeId,
    employeeName: employee?.name || "",
    date,
    status
  };

  if (existingIndex >= 0) attendance[existingIndex] = item;
  else attendance.push(item);

  saveGarageAttendance(attendance);
  closeAttendanceModal();
  renderGarageEmployeeList();
  await pushGarageToCloud();
}

/* =========================
   REPORT
========================= */
function handleGarageReportModeChange() {
  const mode = $("garageReportMode")?.value;
  const wrap = $("garageReportDynamicFields");
  if (!wrap) return;

  const today = todayString();
  const year = new Date().getFullYear();
  const month = new Date().getMonth();

  if (mode === "today") {
    wrap.innerHTML = "";
  } else if (mode === "singleDate") {
    wrap.innerHTML = `<input id="garageReportSingleDate" class="garage-search" type="date" value="${today}" onchange="applyGarageReport()">`;
  } else if (mode === "monthYear") {
    wrap.innerHTML = `
      <select id="garageReportMonth" class="garage-search" onchange="applyGarageReport()">${monthOptions(String(month))}</select>
      <select id="garageReportYear" class="garage-search" onchange="applyGarageReport()">${yearOptions(String(year))}</select>
    `;
  } else if (mode === "yearOnly") {
    wrap.innerHTML = `<select id="garageReportYearOnly" class="garage-search" onchange="applyGarageReport()">${yearOptions(String(year))}</select>`;
  } else if (mode === "dateRange") {
    wrap.innerHTML = `
      <input id="garageReportFromDate" class="garage-search" type="date" value="${today}" onchange="applyGarageReport()">
      <input id="garageReportToDate" class="garage-search" type="date" value="${today}" onchange="applyGarageReport()">
    `;
  }

  applyGarageReport();
}

function incomeMatchesFilter(item, mode) {
  const d = new Date(item.date);
  if (isNaN(d.getTime())) return false;

  if (mode === "today") return sameDate(item.date, todayString());
  if (mode === "singleDate") return item.date === $("garageReportSingleDate")?.value;
  if (mode === "monthYear") {
    return d.getMonth() === Number($("garageReportMonth")?.value) &&
      d.getFullYear() === Number($("garageReportYear")?.value);
  }
  if (mode === "yearOnly") {
    return d.getFullYear() === Number($("garageReportYearOnly")?.value);
  }
  if (mode === "dateRange") {
    const from = new Date($("garageReportFromDate")?.value);
    const to = new Date($("garageReportToDate")?.value);
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);
    return d >= from && d <= to;
  }
  return false;
}

function expenseMatchesFilter(item, mode) {
  const d = new Date(item.date);
  if (isNaN(d.getTime())) return false;

  if (mode === "today") return sameDate(item.date, todayString());
  if (mode === "singleDate") return item.date === $("garageReportSingleDate")?.value;
  if (mode === "monthYear") {
    return d.getMonth() === Number($("garageReportMonth")?.value) &&
      d.getFullYear() === Number($("garageReportYear")?.value);
  }
  if (mode === "yearOnly") {
    return d.getFullYear() === Number($("garageReportYearOnly")?.value);
  }
  if (mode === "dateRange") {
    const from = new Date($("garageReportFromDate")?.value);
    const to = new Date($("garageReportToDate")?.value);
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);
    return d >= from && d <= to;
  }
  return false;
}

function applyGarageReport() {
  const mode = $("garageReportMode")?.value || "today";

  const incomes = getGarageIncome().filter((item) => incomeMatchesFilter(item, mode));
  const expenses = getGarageExpense().filter((item) => expenseMatchesFilter(item, mode));

  const totalIncome = incomes.reduce((sum, item) => sum + Number(item.paid || 0), 0);
  const totalExpense = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalProfit = totalIncome - totalExpense;
  const pendingList = incomes.filter((item) => Number(item.due || 0) > 0);

  if ($("reportTotalIncome")) {
    $("reportTotalIncome").innerText = formatMoney(totalIncome);
    setAmountColor($("reportTotalIncome"), "income");
  }

  if ($("reportTotalExpense")) {
    $("reportTotalExpense").innerText = formatMoney(totalExpense);
    setAmountColor($("reportTotalExpense"), "expense");
  }

  if ($("reportTotalProfit")) {
    $("reportTotalProfit").innerText = formatMoney(Math.abs(totalProfit));
    setAmountColor($("reportTotalProfit"), "profitloss", totalProfit);
  }

  renderGaragePendingList(pendingList);
}

function renderGaragePendingList(pendingList) {
  const list = $("garagePendingList");
  const empty = $("garageNoPendingState");
  if (!list || !empty) return;

  if (!pendingList.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  list.innerHTML = pendingList.map((item) => `
    <div class="history-card premium-card">
      <div class="history-top">
        <div>
          <div class="history-date bigger-text">${escapeHtml(item.carNumber || "-")} · ${escapeHtml(item.type || "")}</div>
          <div class="history-meta bigger-subtext">Date: ${escapeHtml(item.date || "")}</div>
          <div class="history-meta bigger-subtext">Total Bill: ${formatMoney(item.amount)} | Paid: <span class="income-color">${formatMoney(item.paid)}</span></div>
          <div class="history-meta bigger-subtext">Due: <span class="due-color">${formatMoney(item.due)}</span> | Due Date: ${item.dueDate ? escapeHtml(item.dueDate) : "-"}</div>
          <div class="history-meta bigger-subtext">Method: ${escapeHtml(getGarageIncomeDisplayMethod(item))}</div>
          ${renderGarageSplitHtml(item.paymentBreakdown || {})}
          ${item.note ? `<div class="history-meta bigger-subtext">Details: ${escapeHtml(item.note)}</div>` : ""}
        </div>
        <div class="history-amount due-color">${formatMoney(item.due)}</div>
      </div>
    </div>
  `).join("");
}

/* =========================
   CHART
========================= */
function renderGarageProfitChart() {
  const canvas = $("garageProfitChart");
  if (!canvas || typeof Chart === "undefined") return;

  const isDark =
    document.documentElement.classList.contains("dark") ||
    document.body.classList.contains("dark");

  const totalIncome = getMonthlyGarageIncomeTotal();
  const totalExpense = getMonthlyGarageExpenseTotal();
  const totalProfit = totalIncome - totalExpense;

  if (garageProfitChart) garageProfitChart.destroy();

  garageProfitChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["মাসিক আয়", "মাসিক ব্যয়", "মাসিক লাভ/ক্ষতি"],
      datasets: [{
        data: [totalIncome, totalExpense, Math.abs(totalProfit)],
        backgroundColor: [
          "#35de79",
          "#ef4444",
          totalProfit >= 0 ? "#35de79" : "#ef4444"
        ],
        borderColor: [
          "#35de79",
          "#ef4444",
          totalProfit >= 0 ? "#35de79" : "#ef4444"
        ],
        borderWidth: 1,
        borderRadius: 14,
        barThickness: 34
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: {
            color: isDark ? "#cbd5e1" : "#475569",
            font: { size: 13, weight: "700" }
          },
          grid: {
            color: isDark ? "rgba(255,255,255,.06)" : "rgba(15,23,42,.08)"
          }
        },
        y: {
          ticks: {
            color: isDark ? "#cbd5e1" : "#475569",
            font: { size: 13, weight: "700" }
          },
          grid: {
            color: isDark ? "rgba(255,255,255,.06)" : "rgba(15,23,42,.08)"
          }
        }
      }
    }
  });
}

/* =========================
   INVOICE / WHATSAPP
========================= */
function openInvoiceModal(incomeId = "") {
  let item = null;

  if (incomeId) item = getGarageIncome().find((x) => x.id === incomeId);
  else if (currentGarageCarDetailId) item = getGarageIncome().find((x) => x.carId === currentGarageCarDetailId);

  if (!item) {
    alert("Invoice-এর জন্য কোনো service record পাওয়া যায়নি");
    return;
  }

  invoiceCurrentIncomeId = item.id;
  if ($("invoiceCarNumber")) $("invoiceCarNumber").innerText = item.carNumber || "-";
  if ($("invoiceOwnerName")) $("invoiceOwnerName").innerText = item.customerName || "-";
  if ($("invoiceServiceType")) $("invoiceServiceType").innerText = item.type || "-";
  if ($("invoiceDate")) $("invoiceDate").innerText = item.date || "-";
  if ($("invoiceAmount")) $("invoiceAmount").innerText = formatMoney(item.amount);
  if ($("invoicePaid")) $("invoicePaid").innerText = formatMoney(item.paid);
  if ($("invoiceDue")) $("invoiceDue").innerText = formatMoney(item.due);
  if ($("invoiceDueDate")) $("invoiceDueDate").innerText = item.dueDate || "-";
  if ($("invoiceNote")) {
    const method = getGarageIncomeDisplayMethod(item);
    const splitText = formatGarageSplit(item.paymentBreakdown || {});
    const detailParts = [];
    if (item.note) detailParts.push(item.note);
    detailParts.push(`Method: ${method}`);
    if (splitText) detailParts.push(`Split: ${splitText}`);
    $("invoiceNote").innerText = detailParts.join(" | ");
  }

  $("garageInvoiceModal")?.classList.add("show");
}

function closeInvoiceModal() {
  $("garageInvoiceModal")?.classList.remove("show");
}

function printInvoice() {
  const printArea = $("garageInvoicePrintArea");
  if (!printArea) return;

  const printWindow = window.open("", "_blank");
  printWindow.document.write(`
    <html>
    <head>
      <title>Invoice</title>
      <style>
        body{font-family:Arial,sans-serif;padding:30px;color:#111;}
        .invoice-brand{text-align:center;font-size:28px;font-weight:700;}
        .invoice-title{text-align:center;font-size:22px;margin:12px 0 24px 0;}
        .invoice-row{margin-bottom:10px;font-size:18px;}
        .invoice-thankyou{text-align:center;margin-top:30px;font-size:18px;font-weight:700;}
      </style>
    </head>
    <body>${printArea.innerHTML}</body>
    </html>
  `);
  printWindow.document.close();
  printWindow.print();
}

function sendInvoiceWhatsApp() {
  const item = getGarageIncome().find((x) => x.id === invoiceCurrentIncomeId);
  if (!item) return;

  const splitText = formatGarageSplit(item.paymentBreakdown || {});
  const msg =
`Garage Invoice

গাড়ি: ${item.carNumber || "-"}
কাস্টমার: ${item.customerName || "-"}
সার্ভিস: ${item.type || "-"}
তারিখ: ${item.date || "-"}
মোট বিল: ${formatMoney(item.amount)}
Paid: ${formatMoney(item.paid)}
Due: ${formatMoney(item.due)}
Payment Method: ${getGarageIncomeDisplayMethod(item)}
${splitText ? `Split: ${splitText}\n` : ""}Due Date: ${item.dueDate || "-"}
Details: ${item.note || "-"}

ধন্যবাদ, আবার আসবেন`;

  window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank");
}

function sendDueWhatsApp() {
  const item = getGarageIncome().find((x) => x.id === invoiceCurrentIncomeId);
  if (!item) return;

  const msg =
`Due Reminder

গাড়ি: ${item.carNumber || "-"}
কাস্টমার: ${item.customerName || "-"}
সার্ভিস: ${item.type || "-"}
Due Amount: ${formatMoney(item.due)}
Due Date: ${item.dueDate || "-"}
Current Method: ${getGarageIncomeDisplayMethod(item)}

অনুগ্রহ করে বাকি টাকা পরিশোধ করুন।`;

  window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank");
}

/* =========================
   BACKUP / RESTORE
========================= */
function exportGarageBackup() {
  const backup = {
    user: GARAGE_NS,
    exportedAt: new Date().toISOString(),
    cars: getGarageCars(),
    income: getGarageIncome(),
    expense: getGarageExpense(),
    employees: getGarageEmployees(),
    attendance: getGarageAttendance()
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `garage-backup-${GARAGE_NS}.json`;
  a.click();
}

function openRestoreModal() {
  if ($("garageRestoreFile")) $("garageRestoreFile").value = "";
  $("garageRestoreModal")?.classList.add("show");
}

function closeRestoreModal() {
  $("garageRestoreModal")?.classList.remove("show");
}

async function restoreGarageBackup() {
  const file = $("garageRestoreFile")?.files?.[0];
  if (!file) {
    alert("Backup file select করুন");
    return;
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const data = JSON.parse(e.target.result);

      saveGarageCars(Array.isArray(data.cars) ? data.cars : []);
      saveGarageIncomeData(Array.isArray(data.income) ? data.income : []);
      saveGarageExpenseData(Array.isArray(data.expense) ? data.expense : []);
      saveGarageEmployees(Array.isArray(data.employees) ? data.employees : []);
      saveGarageAttendance(Array.isArray(data.attendance) ? data.attendance : []);

      closeRestoreModal();
      renderAllGarage();
      await pushGarageToCloud();

      if (isAppOnline()) {
        await rebuildGarageHisabMirror();
      }

      alert("Backup restore সফল হয়েছে");
    } catch (err) {
      console.error(err);
      alert("Invalid backup file");
    }
  };
  reader.readAsText(file);
}

/* =========================
   REPORT PRINT
========================= */
function printReportSummary() {
  const income = $("reportTotalIncome")?.innerText || "৳0";
  const expense = $("reportTotalExpense")?.innerText || "৳0";
  const profit = $("reportTotalProfit")?.innerText || "৳0";

  const w = window.open("", "_blank");
  w.document.write(`
    <html>
    <head>
      <title>Garage Report</title>
      <style>
        body{font-family:Arial,sans-serif;padding:30px;color:#111;}
        h1{text-align:center;}
        .row{margin:14px 0;font-size:20px;}
      </style>
    </head>
    <body>
      <h1>Garage Report</h1>
      <div class="row">মোট আয়: ${income}</div>
      <div class="row">মোট ব্যয়: ${expense}</div>
      <div class="row">লাভ / ক্ষতি: ${profit}</div>
    </body>
    </html>
  `);
  w.document.close();
  w.print();
}

/* =========================
   RENDER ALL
========================= */
function renderAllGarage() {
  renderGarageDashboard();
  renderGarageIncomeList();
  renderGarageExpenseList();
  renderGarageEmployeeList();

  if (currentGarageCarDetailId) renderGarageCarDetail();

  if ($("garageReportPage") && !$("garageReportPage").classList.contains("hidden")) {
    handleGarageReportModeChange();
  }
}

/* =========================
   MODAL CLOSE
========================= */
function setupGarageModalOutsideClose() {
  [
    "garageCarModal",
    "garageIncomeModal",
    "garageDuePaymentModal",
    "garageExpenseModal",
    "garageEmployeeModal",
    "garageSalaryPaymentModal",
    "garageAttendanceModal",
    "garageRestoreModal",
    "garageInvoiceModal"
  ].forEach((id) => {
    const overlay = $(id);
    if (!overlay) return;

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.classList.remove("show");
      }
    });
  });
}

/* =========================
   THEME REFRESH
========================= */
function refreshGarageThemeUI() {
  applyGarageTheme();
  renderGarageProfitChart();
}

/* =========================
   ONLINE SYNC
========================= */
window.addEventListener("online", async () => {
  try {
    await flushGarageQueue();
    await scanGarageFromCloud();
    await rebuildGarageHisabMirror();
  } catch (err) {
    console.error("Garage online sync failed:", err);
  }
});

/* =========================
   EXPORT
========================= */
window.goDashboard = goDashboard;
window.renderAllGarage = renderAllGarage;

window.openGarageIncomePage = openGarageIncomePage;
window.openGarageExpensePage = openGarageExpensePage;
window.openGarageEmployeePage = openGarageEmployeePage;
window.openGarageReportPage = openGarageReportPage;
window.openGarageCarDetailPage = openGarageCarDetailPage;
window.backToGarageHome = backToGarageHome;

window.openCarModal = openCarModal;
window.closeCarModal = closeCarModal;
window.saveGarageCar = saveGarageCar;
window.editGarageCar = editGarageCar;
window.deleteGarageCar = deleteGarageCar;
window.renderGarageCarList = renderGarageCarList;

window.openIncomeModal = openIncomeModal;
window.closeIncomeModal = closeIncomeModal;
window.saveGarageIncome = saveGarageIncome;
window.editGarageIncome = editGarageIncome;
window.deleteGarageIncome = deleteGarageIncome;
window.updateGarageDuePreview = updateGarageDuePreview;
window.toggleGarageIncomeSplit = toggleGarageIncomeSplit;

window.openDuePaymentModal = openDuePaymentModal;
window.closeDuePaymentModal = closeDuePaymentModal;
window.saveDuePayment = saveDuePayment;
window.markGarageFullPaid = markGarageFullPaid;
window.toggleGarageDueSplit = toggleGarageDueSplit;

window.openExpenseModal = openExpenseModal;
window.closeExpenseModal = closeExpenseModal;
window.saveGarageExpense = saveGarageExpense;
window.editGarageExpense = editGarageExpense;
window.deleteGarageExpense = deleteGarageExpense;
window.filterGarageExpense = filterGarageExpense;
window.selectExpenseCategory = selectExpenseCategory;
window.toggleGarageExpenseSplit = toggleGarageExpenseSplit;

window.openEmployeeModal = openEmployeeModal;
window.closeEmployeeModal = closeEmployeeModal;
window.saveGarageEmployee = saveGarageEmployee;
window.editGarageEmployee = editGarageEmployee;
window.deleteGarageEmployee = deleteGarageEmployee;

window.openSalaryPaymentModal = openSalaryPaymentModal;
window.closeSalaryPaymentModal = closeSalaryPaymentModal;
window.saveSalaryPayment = saveSalaryPayment;
window.markSalaryFullPaid = markSalaryFullPaid;
window.toggleGarageSalarySplit = toggleGarageSalarySplit;

window.openAttendanceModal = openAttendanceModal;
window.closeAttendanceModal = closeAttendanceModal;
window.saveAttendance = saveAttendance;

window.openInvoiceModal = openInvoiceModal;
window.closeInvoiceModal = closeInvoiceModal;
window.printInvoice = printInvoice;
window.sendInvoiceWhatsApp = sendInvoiceWhatsApp;
window.sendDueWhatsApp = sendDueWhatsApp;

window.exportGarageBackup = exportGarageBackup;
window.openRestoreModal = openRestoreModal;
window.closeRestoreModal = closeRestoreModal;
window.restoreGarageBackup = restoreGarageBackup;

window.handleGarageReportModeChange = handleGarageReportModeChange;
window.applyGarageReport = applyGarageReport;
window.printReportSummary = printReportSummary;
window.renderGarageProfitChart = renderGarageProfitChart;
window.refreshGarageThemeUI = refreshGarageThemeUI;

/* =========================
   INIT
========================= */
document.addEventListener("DOMContentLoaded", async function () {
  const sessionInfo = await resolveGarageKeys();

  if (!sessionInfo?.authUser && !sessionInfo?.localUser) {
    localStorage.removeItem("loggedInUser");
    window.location.replace("login.html");
    return;
  }

  applyGarageTheme();
  updateGarageCarDropdown();
  updateEmployeeDropdown();
  setupGarageModalOutsideClose();

  if ($("garageAttendanceDate")) $("garageAttendanceDate").value = todayString();

  const incomeAmountEl = $("garageIncomeAmount");
  const incomePaidEl = $("garageIncomePaid");

  if (incomeAmountEl) incomeAmountEl.addEventListener("input", updateGarageDuePreview);
  if (incomePaidEl) incomePaidEl.addEventListener("input", updateGarageDuePreview);

  [
    "garageIncomeSplitCash",
    "garageIncomeSplitBkash",
    "garageIncomeSplitNagad",
    "garageIncomeSplitRocket",
    "garageIncomeSplitUpay",
    "garageIncomeSplitBank",
    "garageIncomeSplitCard"
  ].forEach((id) => {
    $(id)?.addEventListener("input", updateGarageIncomeMixedTotal);
  });

  [
    "garageDueSplitCash",
    "garageDueSplitBkash",
    "garageDueSplitNagad",
    "garageDueSplitRocket",
    "garageDueSplitUpay",
    "garageDueSplitBank",
    "garageDueSplitCard"
  ].forEach((id) => {
    $(id)?.addEventListener("input", updateGarageDueMixedTotal);
  });

  [
    "garageExpenseSplitCash",
    "garageExpenseSplitBkash",
    "garageExpenseSplitNagad",
    "garageExpenseSplitRocket",
    "garageExpenseSplitUpay",
    "garageExpenseSplitBank",
    "garageExpenseSplitCard"
  ].forEach((id) => {
    $(id)?.addEventListener("input", updateGarageExpenseMixedTotal);
  });

  [
    "garageSalarySplitCash",
    "garageSalarySplitBkash",
    "garageSalarySplitNagad",
    "garageSalarySplitRocket",
    "garageSalarySplitUpay",
    "garageSalarySplitBank",
    "garageSalarySplitCard"
  ].forEach((id) => {
    $(id)?.addEventListener("input", updateGarageSalaryMixedTotal);
  });

  toggleGarageIncomeSplit();
  toggleGarageDueSplit();
  toggleGarageExpenseSplit();
  toggleGarageSalarySplit();

  renderAllGarage();

  try {
    await flushGarageQueue();
  } catch (err) {
    console.error("Initial garage queue flush failed:", err);
  }

  await scanGarageFromCloud();

  if (isAppOnline()) {
    await rebuildGarageHisabMirror();
  }
});