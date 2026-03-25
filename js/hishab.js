import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

import {
  loadHishabCloudData,
  insertHishabCloudEntry
} from "./hishab-cloud.js";

import {
  addHishabSyncTask,
  flushHishabQueue
} from "./hishab-sync.js";

/* =========================
   LOGIN / CONFIG
========================= */
const loggedInUser = JSON.parse(localStorage.getItem("loggedInUser"));
if (!loggedInUser) {
  alert("প্রথমে Login করুন");
  window.location.href = "index.html";
}

const HISHAB_NS = String(
  loggedInUser?.username || loggedInUser?.email || "default_user"
).replace(/[.#$/\[\]]/g, "_");

const LOCAL_KEY = `sheba_accounts_supabase_v7_${HISHAB_NS}`;

const state = {
  entries: [],
  activeTab: "summary",
  detailEntryId: null,
  lastSyncAt: ""
};

/* =========================
   DOM HELPERS
========================= */
const el = (id) => document.getElementById(id);

function getVal(id, fallback = "") {
  const node = el(id);
  return node ? node.value : fallback;
}

function setVal(id, value) {
  const node = el(id);
  if (node) node.value = value ?? "";
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
   HELPERS
========================= */
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(value) {
  return "৳" + safeNumber(value).toLocaleString("en-US", {
    maximumFractionDigits: 2
  });
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatSyncClock(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function sameDate(a, b) {
  return String(a || "") === String(b || "");
}

function isToday(dateStr) {
  return sameDate(dateStr, todayStr());
}

function inMonth(dateStr, year, month) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === year && d.getMonth() + 1 === month;
}

function moduleLabel(module) {
  if (module === "garage") return "Garage";
  if (module === "store") return "Store";
  if (module === "bus") return "Bus";
  if (module === "truck") return "Truck";
  return "Manual";
}

function normalizeModuleName(value) {
  const v = String(value || "").toLowerCase().trim();
  if (v.includes("garage")) return "garage";
  if (v.includes("store")) return "store";
  if (v.includes("bus")) return "bus";
  if (v.includes("truck")) return "truck";
  return "manual";
}

function entryTypeLabel(type) {
  return type === "expense" ? "Expense" : "Income";
}

function entryTitle(entry) {
  return entry.party || entry.category || (entry.type === "expense" ? "Expense Entry" : "Income Entry");
}

function generateRefNo(prefix = "ACC") {
  return `${prefix}-${String(Date.now()).slice(-6)}`;
}

function getEntry(entryId) {
  return state.entries.find((e) => e.id === entryId);
}

function summaryStatBox(label, amount, colorClass = "", borderClass = "") {
  return `
    <div class="summary-stat-box ${borderClass}">
      <span>${escapeHtml(label)}</span>
      <strong class="${colorClass}">${formatMoney(amount)}</strong>
    </div>
  `;
}

function buildSummarySection(totals, mode = "today") {
  const balanceLabel =
    mode === "today"
      ? "আজকের ব্যালেন্স"
      : mode === "month"
      ? "মাসের ব্যালেন্স"
      : "বর্তমান ব্যালেন্স";

  const incomeLabel =
    mode === "today"
      ? "আজকের আয়"
      : mode === "month"
      ? "মাসের আয়"
      : "সর্বমোট আয়";

  const cashLabel =
    mode === "today"
      ? "আজকের নগদ আয়"
      : mode === "month"
      ? "মাসের নগদ আয়"
      : "সর্বমোট নগদ আয়";

  const dueIncomeLabel =
    mode === "today"
      ? "আজকের বাকি আয়"
      : mode === "month"
      ? "মাসের বাকি আয়"
      : "সর্বমোট বাকি আয়";

  const expenseLabel =
    mode === "today"
      ? "আজকের ব্যয়"
      : mode === "month"
      ? "মাসের ব্যয়"
      : "সর্বমোট ব্যয়";

  const receivableLabel =
    mode === "today"
      ? "আজকের পাওনা"
      : mode === "month"
      ? "মাসের পাওনা"
      : "মোট পাওনা";

  return `
    <div class="summary-section-wrap">
      <div class="summary-section-grid">
        ${summaryStatBox(incomeLabel, totals.totalIncome, "income-color", "income-border")}
        ${summaryStatBox(cashLabel, totals.cashIncome, "income-color", "income-border")}
        ${summaryStatBox(dueIncomeLabel, totals.dueIncome, "due-color", "due-border")}
        ${summaryStatBox(expenseLabel, totals.totalExpense, "expense-color", "expense-border")}
        ${summaryStatBox(receivableLabel, totals.receivable, "due-color", "due-border")}
        ${summaryStatBox(
          balanceLabel,
          Math.abs(totals.balance),
          totals.balance >= 0 ? "balance-positive" : "balance-negative",
          "balance-border"
        )}
      </div>
    </div>
  `;
}

/* =========================
   LOCAL
========================= */
function saveLocal() {
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({
      entries: state.entries,
      lastSyncAt: state.lastSyncAt
    })
  );
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    state.lastSyncAt = parsed.lastSyncAt || "";
  } catch (err) {
    console.error(err);
  }
}

/* =========================
   CLOUD / AUTH
========================= */
async function getUserId() {
  const { user } = await getCurrentUser();
  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }
  return user.id;
}

function normalizeEntry(entry) {
  let totalAmount = safeNumber(entry.totalAmount);
  let cashAmount = safeNumber(entry.cashAmount);
  let dueAmount = safeNumber(entry.dueAmount);

  if (!totalAmount && (cashAmount || dueAmount)) {
    totalAmount = cashAmount + dueAmount;
  }

  if (totalAmount > 0) {
    if (cashAmount > totalAmount) cashAmount = totalAmount;
    if (dueAmount > totalAmount) dueAmount = totalAmount;

    if (cashAmount + dueAmount > totalAmount) {
      dueAmount = Math.max(0, totalAmount - cashAmount);
    }

    if (!cashAmount && dueAmount > 0) {
      cashAmount = Math.max(0, totalAmount - dueAmount);
    } else if (!dueAmount && cashAmount > 0) {
      dueAmount = Math.max(0, totalAmount - cashAmount);
    }
  }

  return {
    id: entry.id || uid("acc"),
    sourceTable: entry.sourceTable || "manual",
    sourceId: entry.sourceId || entry.refNo || "",
    source: entry.source || "manual",
    module: normalizeModuleName(entry.module),
    type: entry.type === "expense" ? "expense" : "income",
    date: entry.date || todayStr(),
    refNo: entry.refNo || generateRefNo("ACC"),
    party: entry.party || "",
    category: entry.category || "",
    totalAmount: safeNumber(totalAmount),
    cashAmount: safeNumber(cashAmount),
    dueAmount: safeNumber(dueAmount),
    method: entry.method || "Cash",
    note: entry.note || "",
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: entry.updatedAt || new Date().toISOString()
  };
}

function rowToEntry(row) {
  return normalizeEntry({
    id: row.id,
    sourceTable: row.source_table || "manual",
    sourceId: row.source_id || "",
    source: row.source_table === "manual" ? "manual" : "sync",
    module: row.module_name,
    type: row.entry_type,
    date: row.entry_date,
    refNo: row.source_id || generateRefNo("ACC"),
    party: row.party_name,
    category: row.category,
    totalAmount: row.total_amount,
    cashAmount: row.paid_amount,
    dueAmount: row.due_amount,
    method: row.payment_method || "Cash",
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function entryToRow(entry) {
  return {
    module_name: entry.module,
    entry_type: entry.type,
    source_table: entry.sourceTable || "manual",
    source_id: entry.sourceId || entry.refNo || entry.id,
    entry_date: entry.date,
    party_name: entry.party,
    category: entry.category,
    total_amount: safeNumber(entry.totalAmount),
    paid_amount: safeNumber(entry.cashAmount),
    due_amount: safeNumber(entry.dueAmount),
    payment_method: entry.method || "Cash",
    note: entry.note,
    updated_at: new Date().toISOString()
  };
}

async function loadCloudEntries() {
  const payload = await loadHishabCloudData();
  state.entries = Array.isArray(payload?.entries)
    ? payload.entries.map(rowToEntry)
    : [];
  state.lastSyncAt = new Date().toISOString();
  saveLocal();
}

async function insertCloudEntry(entry) {
  const data = await insertHishabCloudEntry(entryToRow(entry));
  return rowToEntry(data);
}

/* =========================
   TOTALS
========================= */
function sumAmounts(entries) {
  const out = {
    totalIncome: 0,
    cashIncome: 0,
    dueIncome: 0,
    totalExpense: 0,
    cashExpense: 0,
    dueExpense: 0,
    balance: 0,
    receivable: 0,
    payable: 0
  };

  entries.forEach((entry) => {
    if (entry.type === "income") {
      out.totalIncome += safeNumber(entry.totalAmount);
      out.cashIncome += safeNumber(entry.cashAmount);
      out.dueIncome += safeNumber(entry.dueAmount);
    } else {
      out.totalExpense += safeNumber(entry.totalAmount);
      out.cashExpense += safeNumber(entry.cashAmount);
      out.dueExpense += safeNumber(entry.dueAmount);
    }
  });

  out.balance = out.cashIncome - out.cashExpense;
  out.receivable = out.dueIncome;
  out.payable = out.dueExpense;

  return out;
}

/* =========================
   FILTERS
========================= */
function getFilteredEntries() {
  let entries = [...state.entries];

  const search = getVal("searchInput").trim().toLowerCase();
  if (search) {
    entries = entries.filter((entry) => {
      const hay = [
        entry.module,
        entry.type,
        entry.party,
        entry.category,
        entry.refNo,
        entry.note,
        entry.method
      ].join(" ").toLowerCase();
      return hay.includes(search);
    });
  }

  const moduleFilter = getVal("moduleFilter", "all");
  if (moduleFilter !== "all") {
    entries = entries.filter((entry) => entry.module === moduleFilter);
  }

  const typeFilter = getVal("typeFilter", "all");
  if (typeFilter !== "all") {
    entries = entries.filter((entry) => entry.type === typeFilter);
  }

  const sort = getVal("sortFilter", "latest");
  entries.sort((a, b) => {
    if (sort === "oldest") return String(a.date).localeCompare(String(b.date));
    if (sort === "high") return safeNumber(b.totalAmount) - safeNumber(a.totalAmount);
    if (sort === "low") return safeNumber(a.totalAmount) - safeNumber(b.totalAmount);
    return (
      String(b.date).localeCompare(String(a.date)) ||
      String(b.updatedAt).localeCompare(String(a.updatedAt))
    );
  });

  return entries;
}

/* =========================
   HEADER / WARNING
========================= */
function updateHeaderSummary() {
  const totals = sumAmounts(state.entries);

  setText("ledgerCountText", state.entries.length);

  setText("headerTotalIncome", formatMoney(totals.totalIncome));
  setText("headerCashIncome", formatMoney(totals.cashIncome));
  setText("headerDueIncome", formatMoney(totals.dueIncome));
  setText("headerTotalExpense", formatMoney(totals.totalExpense));
  setText("headerBalance", formatMoney(Math.abs(totals.balance)));
  setText("headerReceivable", formatMoney(totals.receivable));

  const incomeEl = el("headerTotalIncome");
  const cashEl = el("headerCashIncome");
  const dueEl = el("headerDueIncome");
  const expenseEl = el("headerTotalExpense");
  const balanceEl = el("headerBalance");
  const receivableEl = el("headerReceivable");

  if (incomeEl) incomeEl.className = "income-color";
  if (cashEl) cashEl.className = "income-color";
  if (dueEl) dueEl.className = "due-color";
  if (expenseEl) expenseEl.className = "expense-color";
  if (balanceEl) balanceEl.className = totals.balance >= 0 ? "balance-positive" : "balance-negative";
  if (receivableEl) receivableEl.className = "due-color";
}

function renderWarningCard() {
  const receivableRows = state.entries.filter((e) => e.type === "income" && safeNumber(e.dueAmount) > 0);
  const payableRows = state.entries.filter((e) => e.type === "expense" && safeNumber(e.dueAmount) > 0);

  const warnings = [];
  if (receivableRows.length) warnings.push(`পাওনা আছে: ${receivableRows.length} টি এন্ট্রি`);
  if (payableRows.length) warnings.push(`পরিশোধ বাকি আছে: ${payableRows.length} টি এন্ট্রি`);

  if (!warnings.length) {
    hide("warningCard");
    return;
  }

  setHtml("warningList", warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join(""));
  show("warningCard");
}

/* =========================
   SUMMARY
========================= */
function renderTodaySummaryGrid() {
  const todayRows = state.entries.filter((e) => isToday(e.date));
  const totals = sumAmounts(todayRows);
  setHtml("todaySummaryGrid", buildSummarySection(totals, "today"));
}

function renderMonthSummaryGrid() {
  const now = new Date();
  const monthRows = state.entries.filter((e) =>
    inMonth(e.date, now.getFullYear(), now.getMonth() + 1)
  );
  const totals = sumAmounts(monthRows);
  setHtml("monthSummaryGrid", buildSummarySection(totals, "month"));
}

function renderOverallSummaryGrid() {
  const totals = sumAmounts(state.entries);
  setHtml("overallSummaryGrid", buildSummarySection(totals, "overall"));
}

function renderModuleSummaryList() {
  const modules = ["garage", "store", "bus", "truck", "manual"];

  const html = modules.map((module) => {
    const rows = state.entries.filter((e) => e.module === module);
    const totals = sumAmounts(rows);

    return `
      <div class="transaction-card module-card module-${module}">
        <div class="tx-main">
          <div class="tx-title">${escapeHtml(moduleLabel(module))}</div>
          <div class="tx-meta">Entries: ${rows.length}</div>

          <div class="amount-grid">
            <div class="amount-box">
              <span>মোট আয়</span>
              <strong class="income-color">${formatMoney(totals.totalIncome)}</strong>
            </div>
            <div class="amount-box">
              <span>নগদ আয়</span>
              <strong class="income-color">${formatMoney(totals.cashIncome)}</strong>
            </div>
            <div class="amount-box">
              <span>বাকি আয়</span>
              <strong class="due-color">${formatMoney(totals.dueIncome)}</strong>
            </div>
            <div class="amount-box">
              <span>মোট ব্যয়</span>
              <strong class="expense-color">${formatMoney(totals.totalExpense)}</strong>
            </div>
            <div class="amount-box">
              <span>পাওনা</span>
              <strong class="due-color">${formatMoney(totals.receivable)}</strong>
            </div>
            <div class="amount-box">
              <span>ব্যালেন্স</span>
              <strong class="${totals.balance >= 0 ? "balance-positive" : "balance-negative"}">${formatMoney(Math.abs(totals.balance))}</strong>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  setHtml("moduleSummaryList", html || `<div class="transaction-card">কোনো ডাটা নেই</div>`);
}

/* =========================
   TRANSACTIONS
========================= */
function transactionCard(entry) {
  return `
    <div class="transaction-card ${entry.type}" onclick="openDetailModal('${entry.id}')">
      <div class="tx-top">
        <div class="tx-main">
          <div class="tx-mini">${escapeHtml(moduleLabel(entry.module))} • ${escapeHtml(entry.date)} • ${escapeHtml(entry.refNo || "-")}</div>
          <div class="tx-title">${escapeHtml(entryTitle(entry))}</div>
          <div class="tx-desc">${escapeHtml(entry.category || "-")}${entry.note ? " • " + escapeHtml(entry.note) : ""}</div>

          <div class="badge-row">
            <span class="badge module">${escapeHtml(moduleLabel(entry.module))}</span>
            <span class="badge ${entry.type}">${escapeHtml(entryTypeLabel(entry.type))}</span>
            <span class="badge cash">নগদ ${formatMoney(entry.cashAmount)}</span>
            <span class="badge due">বাকি ${formatMoney(entry.dueAmount)}</span>
          </div>

          <div class="tx-meta">
            Party: ${escapeHtml(entry.party || "-")}<br>
            Method: ${escapeHtml(entry.method || "-")}<br>
            Source: ${escapeHtml(entry.source === "manual" ? "Manual" : "Auto Sync")}
          </div>

          <div class="amount-grid">
            <div class="amount-box">
              <span>মোট</span>
              <strong class="${entry.type === "income" ? "income-color" : "expense-color"}">${formatMoney(entry.totalAmount)}</strong>
            </div>
            <div class="amount-box">
              <span>নগদ</span>
              <strong class="${entry.type === "income" ? "income-color" : "expense-color"}">${formatMoney(entry.cashAmount)}</strong>
            </div>
            <div class="amount-box">
              <span>বাকি</span>
              <strong class="due-color">${formatMoney(entry.dueAmount)}</strong>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTransactionList() {
  const rows = getFilteredEntries();
  if (!rows.length) {
    setHtml("transactionList", `<div class="transaction-card">কোনো ট্রানজেকশন পাওয়া যায়নি</div>`);
    return;
  }
  setHtml("transactionList", rows.map(transactionCard).join(""));
}

/* =========================
   DUE
========================= */
function renderDueCenter() {
  let rows = state.entries.filter((e) => safeNumber(e.dueAmount) > 0);

  const moduleFilter = getVal("dueViewFilter", "all");
  if (moduleFilter !== "all") {
    rows = rows.filter((e) => e.module === moduleFilter);
  }

  const totals = sumAmounts(rows);

  setHtml(
    "dueSummaryGrid",
    `
      <div class="report-box"><span>পাওনা আয়</span><strong class="due-color">${formatMoney(totals.dueIncome)}</strong></div>
      <div class="report-box"><span>বাকি ব্যয়</span><strong class="expense-color">${formatMoney(totals.dueExpense)}</strong></div>
      <div class="report-box"><span>নেট পাওনা</span><strong class="${(totals.dueIncome - totals.dueExpense) >= 0 ? "income-color" : "expense-color"}">${formatMoney(Math.abs(totals.dueIncome - totals.dueExpense))}</strong></div>
      <div class="report-box"><span>Due Entries</span><strong>${rows.length}</strong></div>
    `
  );

  if (!rows.length) {
    setHtml("dueList", `<div class="due-card">কোনো due এন্ট্রি নেই</div>`);
    return;
  }

  const html = rows
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((entry) => `
      <div class="due-card" onclick="openDetailModal('${entry.id}')">
        <div class="due-title">${escapeHtml(entryTitle(entry))}</div>
        <div class="due-meta">
          Module: ${escapeHtml(moduleLabel(entry.module))}<br>
          Type: ${escapeHtml(entryTypeLabel(entry.type))}<br>
          Party: ${escapeHtml(entry.party || "-")}<br>
          Date: ${escapeHtml(entry.date || "-")}<br>
          Total: ${formatMoney(entry.totalAmount)}<br>
          Cash: ${formatMoney(entry.cashAmount)}<br>
          Due: ${formatMoney(entry.dueAmount)}
        </div>

        <div class="badge-row">
          <span class="badge module">${escapeHtml(moduleLabel(entry.module))}</span>
          <span class="badge ${entry.type}">${escapeHtml(entryTypeLabel(entry.type))}</span>
          <span class="badge due">Due ${formatMoney(entry.dueAmount)}</span>
        </div>
      </div>
    `)
    .join("");

  setHtml("dueList", html);
}

/* =========================
   REPORTS
========================= */
function renderReportModeFields() {
  const wrap = el("reportDynamicFields");
  if (!wrap) return;

  const mode = getVal("reportMode", "dateRange");
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
  const mode = getVal("reportMode", "dateRange");

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

  const rows = state.entries.filter((entry) => {
    if (from && entry.date < from) return false;
    if (to && entry.date > to) return false;
    return true;
  });

  const totals = sumAmounts(rows);

  setHtml(
    "reportGrid",
    `
      <div class="report-box"><span>মোট আয়</span><strong class="income-color">${formatMoney(totals.totalIncome)}</strong></div>
      <div class="report-box"><span>নগদ আয়</span><strong class="income-color">${formatMoney(totals.cashIncome)}</strong></div>
      <div class="report-box"><span>বাকি আয়</span><strong class="due-color">${formatMoney(totals.dueIncome)}</strong></div>
      <div class="report-box"><span>মোট ব্যয়</span><strong class="expense-color">${formatMoney(totals.totalExpense)}</strong></div>
      <div class="report-box"><span>নগদ ব্যয়</span><strong class="expense-color">${formatMoney(totals.cashExpense)}</strong></div>
      <div class="report-box"><span>বাকি ব্যয়</span><strong class="expense-color">${formatMoney(totals.dueExpense)}</strong></div>
      <div class="report-box"><span>ব্যালেন্স</span><strong class="${totals.balance >= 0 ? "balance-positive" : "balance-negative"}">${formatMoney(Math.abs(totals.balance))}</strong></div>
      <div class="report-box"><span>লেনদেন সংখ্যা</span><strong>${rows.length}</strong></div>
    `
  );

  const recent = rows
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 20);

  if (!recent.length) {
    setHtml("recentLedgerList", `<div class="transaction-card">এই range-এ কোনো লেনদেন নেই</div>`);
    return;
  }

  setHtml("recentLedgerList", recent.map(transactionCard).join(""));
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
}

/* =========================
   ENTRY FORM
========================= */
function updateEntryModeLabels() {
  const type = getVal("entryType", "income");
  setText("entryTotalLabel", type === "income" ? "মোট আয়" : "মোট ব্যয়");
  setText("entryCashLabel", type === "income" ? "নগদ আয়" : "নগদ ব্যয়");
  setText("entryDueLabel", type === "income" ? "বাকি আয়" : "বাকি ব্যয়");
}

function updateEntryAmounts() {
  const activeId = document.activeElement ? document.activeElement.id : "";
  let total = safeNumber(getVal("entryTotalAmount"));
  let cash = safeNumber(getVal("entryCashAmount"));
  let due = safeNumber(getVal("entryDueAmount"));

  if (activeId === "entryDueAmount") {
    if (total > 0) {
      due = Math.min(due, total);
      cash = Math.max(0, total - due);
    } else {
      total = cash + due;
    }
  } else if (activeId === "entryCashAmount") {
    if (total > 0) {
      cash = Math.min(cash, total);
      due = Math.max(0, total - cash);
    } else {
      total = cash + due;
    }
  } else {
    if (cash > 0) due = Math.max(0, total - cash);
    else if (due > 0) cash = Math.max(0, total - due);
  }

  setVal("entryTotalAmount", total || "");
  setVal("entryCashAmount", cash || 0);
  setVal("entryDueAmount", due || 0);

  setText("entryTotalShow", formatMoney(total));
  setText("entryCashShow", formatMoney(cash));
  setText("entryDueShow", formatMoney(due));

  el("entryTotalShow")?.classList.add("income-color");
  el("entryCashShow")?.classList.add("income-color");
  el("entryDueShow")?.classList.add("due-color");
}

function resetEntryForm() {
  setVal("entryModule", "manual");
  setVal("entryType", "income");
  setVal("entryDate", todayStr());
  setVal("entryRefNo", generateRefNo("ACC"));
  setVal("entryParty", "");
  setVal("entryCategory", "");
  setVal("entryTotalAmount", "");
  setVal("entryCashAmount", 0);
  setVal("entryDueAmount", 0);
  setVal("entryMethod", "Cash");
  setVal("entryNote", "");

  setText("entryModalTitle", "নতুন হিসাব এন্ট্রি");
  updateEntryModeLabels();
  updateEntryAmounts();
}

function openEntryForm() {
  resetEntryForm();
  el("entryModal")?.classList.add("show");
}

function closeEntryForm() {
  el("entryModal")?.classList.remove("show");
}

async function saveEntry() {
  const type = getVal("entryType", "income");
  const totalAmount = safeNumber(getVal("entryTotalAmount"));
  const cashAmount = safeNumber(getVal("entryCashAmount"));
  const dueAmount = safeNumber(getVal("entryDueAmount"));

  if (totalAmount <= 0) {
    alert("সঠিক amount দিন");
    return;
  }

  if (cashAmount + dueAmount > totalAmount + 0.001) {
    alert("নগদ + বাকি amount মোট amount-এর বেশি হয়েছে");
    return;
  }

  const payload = normalizeEntry({
    id: uid("acc"),
    sourceTable: "manual",
    sourceId: getVal("entryRefNo").trim() || generateRefNo(type === "income" ? "INC" : "EXP"),
    source: "manual",
    module: getVal("entryModule", "manual"),
    type,
    date: getVal("entryDate") || todayStr(),
    refNo: getVal("entryRefNo").trim() || generateRefNo(type === "income" ? "INC" : "EXP"),
    party: getVal("entryParty").trim(),
    category: getVal("entryCategory").trim(),
    totalAmount,
    cashAmount,
    dueAmount,
    method: getVal("entryMethod", "Cash"),
    note: getVal("entryNote").trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  try {
    if (navigator.onLine) {
      const inserted = await insertCloudEntry(payload);
      state.entries.unshift(inserted);
      state.lastSyncAt = new Date().toISOString();
    } else {
      state.entries.unshift(payload);
      state.lastSyncAt = new Date().toISOString();
      addHishabSyncTask({
        action: "insert",
        payload: entryToRow(payload)
      });
    }

    saveLocal();
    renderAllAccounts();
    closeEntryForm();
  } catch (err) {
    console.error(err);
    alert("Save failed");
  }
}

/* =========================
   DETAIL MODAL
========================= */
function openDetailModal(entryId) {
  const entry = getEntry(entryId);
  if (!entry) return;

  state.detailEntryId = entryId;

  setHtml(
    "detailContent",
    `
      <div class="detail-title">${escapeHtml(entryTitle(entry))}</div>

      <div class="badge-row">
        <span class="badge module">${escapeHtml(moduleLabel(entry.module))}</span>
        <span class="badge ${entry.type}">${escapeHtml(entryTypeLabel(entry.type))}</span>
        <span class="badge cash">Cash ${formatMoney(entry.cashAmount)}</span>
        <span class="badge due">Due ${formatMoney(entry.dueAmount)}</span>
      </div>

      <div class="detail-box">
        <div class="detail-meta">
          Module: ${escapeHtml(moduleLabel(entry.module))}<br>
          Type: ${escapeHtml(entryTypeLabel(entry.type))}<br>
          Date: ${escapeHtml(entry.date || "-")}<br>
          Reference: ${escapeHtml(entry.refNo || "-")}<br>
          Party: ${escapeHtml(entry.party || "-")}<br>
          Category: ${escapeHtml(entry.category || "-")}<br>
          Method: ${escapeHtml(entry.method || "-")}<br>
          Source: ${escapeHtml(entry.source === "manual" ? "Manual" : "Auto Sync")}<br>
          Source Table: ${escapeHtml(entry.sourceTable || "-")}<br>
          Source ID: ${escapeHtml(entry.sourceId || "-")}<br>
          Updated: ${escapeHtml(formatDateTime(entry.updatedAt))}
        </div>
      </div>

      <div class="detail-box">
        <div class="amount-grid">
          <div class="amount-box">
            <span>মোট</span>
            <strong class="${entry.type === "income" ? "income-color" : "expense-color"}">${formatMoney(entry.totalAmount)}</strong>
          </div>
          <div class="amount-box">
            <span>নগদ</span>
            <strong class="${entry.type === "income" ? "income-color" : "expense-color"}">${formatMoney(entry.cashAmount)}</strong>
          </div>
          <div class="amount-box">
            <span>বাকি</span>
            <strong class="due-color">${formatMoney(entry.dueAmount)}</strong>
          </div>
        </div>
      </div>

      <div class="detail-box">
        <div class="detail-body">${escapeHtml(entry.note || "No note")}</div>
      </div>
    `
  );

  el("detailModal")?.classList.add("show");
}

function closeDetailModal() {
  el("detailModal")?.classList.remove("show");
  state.detailEntryId = null;
}

/* =========================
   PDF
========================= */
async function ensureJsPdf() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;

  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-jspdf="1"]');
    if (existing) {
      existing.addEventListener("load", resolve);
      existing.addEventListener("error", reject);
      return;
    }

    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.async = true;
    s.dataset.jspdf = "1";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  if (!window.jspdf?.jsPDF) throw new Error("jsPDF failed");
  return window.jspdf.jsPDF;
}

async function exportAccountsPdf() {
  const rows = getFilteredEntries();
  if (!rows.length) return alert("কোনো ডাটা নেই");

  try {
    const JsPdf = await ensureJsPdf();
    const pdf = new JsPdf();

    const totals = sumAmounts(rows);
    let y = 12;

    pdf.setFontSize(16);
    pdf.text("Accounts Report", 10, y);
    y += 8;

    pdf.setFontSize(11);
    pdf.text(`Total Income: ${totals.totalIncome}`, 10, y); y += 6;
    pdf.text(`Cash Income: ${totals.cashIncome}`, 10, y); y += 6;
    pdf.text(`Due Income: ${totals.dueIncome}`, 10, y); y += 6;
    pdf.text(`Total Expense: ${totals.totalExpense}`, 10, y); y += 6;
    pdf.text(`Balance: ${totals.balance}`, 10, y); y += 10;

    rows.slice(0, 35).forEach((entry) => {
      const lines = [
        `${moduleLabel(entry.module)} | ${entryTypeLabel(entry.type)} | ${entry.date}`,
        `${entryTitle(entry)} | Total: ${entry.totalAmount} | Cash: ${entry.cashAmount} | Due: ${entry.dueAmount}`,
        `${entry.category || "-"} | ${entry.party || "-"} | ${entry.note || "-"}`
      ];

      lines.forEach((line) => {
        const split = pdf.splitTextToSize(line, 180);
        if (y > 275) {
          pdf.addPage();
          y = 12;
        }
        pdf.text(split, 10, y);
        y += split.length * 5 + 2;
      });

      y += 2;
    });

    pdf.save(`accounts-report-${todayStr()}.pdf`);
  } catch (err) {
    console.error(err);
    alert("PDF export করতে সমস্যা হয়েছে");
  }
}

/* =========================
   BACKUP / RESTORE
========================= */
function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    entries: state.entries
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `accounts-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function restoreBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (!navigator.onLine) {
    alert("Backup restore করতে internet on করতে হবে");
    event.target.value = "";
    return;
  }

  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const parsed = JSON.parse(fr.result);
      if (!Array.isArray(parsed.entries)) {
        alert("Invalid backup file");
        return;
      }

      if (!confirm("Backup restore করলে বর্তমান ডাটা replace হবে। চালাবেন?")) return;

      const userId = await getUserId();

      const { error: deleteError } = await supabase
        .from("hisab_entries")
        .delete()
        .eq("user_id", userId);

      if (deleteError) throw deleteError;

      const rows = parsed.entries.map((entry) => {
        const normalized = normalizeEntry(entry);
        return {
          user_id: userId,
          ...entryToRow(normalized)
        };
      });

      if (rows.length) {
        const { error: insertError } = await supabase
          .from("hisab_entries")
          .insert(rows);

        if (insertError) throw insertError;
      }

      await loadCloudEntries();
      renderAllAccounts();
      alert("Backup restore হয়েছে");
    } catch (err) {
      console.error(err);
      alert("Backup restore failed");
    } finally {
      event.target.value = "";
    }
  };

  fr.readAsText(file);
}

/* =========================
   NOTIFICATION
========================= */
function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("এই browser-এ notification support নেই");
    return;
  }

  Notification.requestPermission().then((permission) => {
    if (permission === "granted") {
      alert("Notification চালু হয়েছে");
      checkDueNotifications();
    } else {
      alert("Notification permission দেওয়া হয়নি");
    }
  });
}

function checkDueNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const totals = sumAmounts(state.entries);
  const stamp = `${todayStr()}_${totals.receivable}_${totals.payable}`;

  if (sessionStorage.getItem("accounts_notify_stamp") === stamp) return;

  if (totals.receivable > 0 || totals.payable > 0) {
    new Notification("হিসাব অ্যালার্ট", {
      body: `পাওনা: ${formatMoney(totals.receivable)} | বাকি ব্যয়: ${formatMoney(totals.payable)}`
    });

    sessionStorage.setItem("accounts_notify_stamp", stamp);
  }
}

/* =========================
   SYNC
========================= */
function updateLastSyncText() {
  setText("lastSyncTextSmall", formatSyncClock(state.lastSyncAt));
}

async function syncModuleData(options = {}) {
  try {
    if (navigator.onLine) {
      await flushHishabQueue();
      await loadCloudEntries();
    } else {
      loadLocal();
    }

    updateLastSyncText();
    renderAllAccounts();

    if (!options.silent) {
      alert(navigator.onLine ? "Refresh completed" : "Offline cache loaded");
    }
  } catch (err) {
    console.error(err);
    loadLocal();
    updateLastSyncText();
    renderAllAccounts();

    if (!options.silent) {
      alert("Offline cache loaded");
    }
  }
}

window.addEventListener("online", async () => {
  try {
    await flushHishabQueue();
    await syncModuleData({ silent: true });
  } catch (err) {
    console.error("Hishab online sync failed:", err);
  }
});

/* =========================
   MAIN RENDER
========================= */
function renderAllAccounts() {
  updateHeaderSummary();
  renderWarningCard();
  renderTodaySummaryGrid();
  renderMonthSummaryGrid();
  renderOverallSummaryGrid();
  renderModuleSummaryList();
  renderTransactionList();
  renderDueCenter();
  renderReports();
  updateLastSyncText();
  checkDueNotifications();
}

/* =========================
   MODAL BACKDROP
========================= */
function handleModalBackdrop(e) {
  ["entryModal", "detailModal"].forEach((id) => {
    const modal = el(id);
    if (modal && e.target === modal) {
      modal.classList.remove("show");
    }
  });
}

/* =========================
   INIT
========================= */
async function init() {
  loadLocal();
  renderReportModeFields();
  resetEntryForm();
  renderAllAccounts();

  try {
    await flushHishabQueue();
  } catch (err) {
    console.error("Initial hishab queue flush failed:", err);
  }

  await syncModuleData({ silent: true });
}

window.addEventListener("DOMContentLoaded", init);
document.addEventListener("click", handleModalBackdrop);

/* =========================
   EXPOSE
========================= */
Object.assign(window, {
  switchTab,
  renderAllAccounts,

  openEntryForm,
  closeEntryForm,
  saveEntry,
  updateEntryModeLabels,
  updateEntryAmounts,

  openDetailModal,
  closeDetailModal,

  renderDueCenter,
  renderReportModeFields,
  renderReports,

  exportAccountsPdf,
  exportBackup,
  restoreBackup,

  syncModuleData,
  requestNotificationPermission
});