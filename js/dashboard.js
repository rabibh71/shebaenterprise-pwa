import { getCurrentUser } from "./supabase-auth.js";

/* =========================
   USER STATE
========================= */
let currentUserState = null;

/* =========================
   HELPERS
========================= */
function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getProfiles() {
  return safeJsonParse(localStorage.getItem("signupProfiles"), {});
}

function saveLoggedInUser(userData) {
  localStorage.setItem("loggedInUser", JSON.stringify(userData));
  currentUserState = userData;
}

function toSafeKey(value) {
  return String(value || "default_user")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]@]/g, "_");
}

function toLegacyKey(value) {
  return String(value || "default_user")
    .replace(/[.#$/\[\]]/g, "_");
}

function getUserCacheKey(name) {
  const base =
    currentUserState?.email ||
    currentUserState?.username ||
    "default_user";

  return `${name}_${toSafeKey(base)}`;
}

function buildCurrentUser(authUser) {
  const currentEmail = String(authUser?.email || "").toLowerCase();
  const profiles = getProfiles();
  const savedProfile = profiles[currentEmail] || null;

  const rawLocalUser = safeJsonParse(localStorage.getItem("loggedInUser"), null);
  const matchedLocalUser =
    rawLocalUser && String(rawLocalUser.email || "").toLowerCase() === currentEmail
      ? rawLocalUser
      : null;

  const finalUser = {
    email: authUser?.email || "",
    fullName: savedProfile?.fullName || matchedLocalUser?.fullName || "",
    firstname: savedProfile?.firstname || matchedLocalUser?.firstname || "",
    lastname: savedProfile?.lastname || matchedLocalUser?.lastname || "",
    username: savedProfile?.username || matchedLocalUser?.username || "",
    profileImage: savedProfile?.profileImage || matchedLocalUser?.profileImage || "",
    createdAt:
      savedProfile?.createdAt ||
      matchedLocalUser?.createdAt ||
      new Date().toISOString()
  };

  saveLoggedInUser(finalUser);
  return finalUser;
}

function getIdentityCandidates() {
  const localUser = safeJsonParse(localStorage.getItem("loggedInUser"), null);

  const values = [
    currentUserState?.email,
    currentUserState?.username,
    localUser?.email,
    localUser?.username,
    "default_user"
  ].filter(Boolean);

  return [...new Set(values)];
}

function getExactCountFromCandidates(candidates, nestedArrayKey = "") {
  for (const key of candidates) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    const parsed = safeJsonParse(raw, null);

    if (Array.isArray(parsed)) {
      return parsed.length;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      nestedArrayKey &&
      Array.isArray(parsed[nestedArrayKey])
    ) {
      return parsed[nestedArrayKey].length;
    }
  }

  return 0;
}

/* =========================
   USER LOAD
========================= */
async function loadUserName() {
  const { user, error } = await getCurrentUser();

  if (error || !user) {
    localStorage.removeItem("loggedInUser");
    window.location.replace("login.html");
    return false;
  }

  const finalUser = buildCurrentUser(user);

  const displayName =
    finalUser.fullName ||
    ((finalUser.firstname || "") + " " + (finalUser.lastname || "")).trim() ||
    finalUser.username ||
    user.email ||
    "User";

  const usernameEl = document.getElementById("username");
  if (usernameEl) {
    usernameEl.innerText = displayName.toUpperCase();
  }

  return true;
}

/* =========================
   DATE
========================= */
function loadDate() {
  const today = new Date();
  const dateEl = document.getElementById("date");

  if (dateEl) {
    dateEl.innerText = today.toLocaleDateString("bn-BD", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }
}

/* =========================
   COUNTER ANIMATION
========================= */
function animateCounter(id, target) {
  const el = document.getElementById(id);
  if (!el) return;

  target = Number(target) || 0;

  if (el._counterTimer) {
    clearInterval(el._counterTimer);
    el._counterTimer = null;
  }

  if (target <= 0) {
    el.innerText = "0";
    return;
  }

  let count = 0;
  const step = Math.max(1, Math.ceil(target / 40));

  el._counterTimer = setInterval(() => {
    count += step;

    if (count >= target) {
      el.innerText = String(target);
      clearInterval(el._counterTimer);
      el._counterTimer = null;
      return;
    }

    el.innerText = String(count);
  }, 20);
}

/* =========================
   COUNTS FROM REAL MODULE DATA
========================= */
function getGarageCount() {
  const candidates = [];

  getIdentityCandidates().forEach((id) => {
    candidates.push(`shebaGarageCars_${toSafeKey(id)}`);
    candidates.push(`shebaGarageCars_${toLegacyKey(id)}`);
  });

  return getExactCountFromCandidates([...new Set(candidates)]);
}

function getStoreCount() {
  const candidates = [];

  getIdentityCandidates().forEach((id) => {
    candidates.push(`sheba_store_v_supabase_v1_${toSafeKey(id)}`);
  });

  return getExactCountFromCandidates([...new Set(candidates)], "products");
}

function getBusCount() {
  const candidates = [];

  getIdentityCandidates().forEach((id) => {
    candidates.push(`shebaBus_${toSafeKey(id)}`);
    candidates.push(`shebaBus_${toLegacyKey(id)}`);
  });

  candidates.push("shebaBus");
  candidates.push("shebaBusData");
  candidates.push("busData");

  return getExactCountFromCandidates([...new Set(candidates)], "buses");
}

function getTruckCount() {
  const candidates = [];

  getIdentityCandidates().forEach((id) => {
    candidates.push(`shebaTruck_${toSafeKey(id)}`);
    candidates.push(`shebaTruck_${toLegacyKey(id)}`);
  });

  return getExactCountFromCandidates([...new Set(candidates)], "trucks");
}

function loadCounts() {
  const garage = getGarageCount();
  const store = getStoreCount();
  const bus = getBusCount();
  const truck = getTruckCount();

  localStorage.setItem(getUserCacheKey("garageCountCache"), String(garage));
  localStorage.setItem(getUserCacheKey("storeCountCache"), String(store));
  localStorage.setItem(getUserCacheKey("busCountCache"), String(bus));
  localStorage.setItem(getUserCacheKey("truckCountCache"), String(truck));

  animateCounter("garageCount", garage);
  animateCounter("storeCount", store);
  animateCounter("busCount", bus);
  animateCounter("truckCount", truck);
}

/* =========================
   NAVIGATION
========================= */
window.openPage = function (page) {
  window.location.href = page;
};

window.openSettings = function () {
  window.location.href = "settings.html";
};

/* =========================
   SCROLL FIX
========================= */
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

function forceDashboardTop() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

/* =========================
   AUTO REFRESH COUNTS
========================= */
function refreshDashboardCounts() {
  setTimeout(loadCounts, 100);
}

window.addEventListener("pageshow", function () {
  forceDashboardTop();
  refreshDashboardCounts();
});

window.addEventListener("focus", refreshDashboardCounts);
window.addEventListener("storage", refreshDashboardCounts);
window.addEventListener("online", function () {
  setTimeout(loadCounts, 300);
});

document.addEventListener("DOMContentLoaded", forceDashboardTop);
window.addEventListener("load", forceDashboardTop);

/* =========================
   INIT
========================= */
(async function initDashboard() {
  const ok = await loadUserName();
  if (!ok) return;

  forceDashboardTop();
  loadDate();
  loadCounts();
})();