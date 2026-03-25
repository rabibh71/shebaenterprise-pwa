import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

import {
  loadNotesCloudData,
  saveNotesCloudData,
  getEmptyNotesData
} from "./notes-cloud.js";

import {
  addNotesSyncTask,
  flushNotesQueue
} from "./notes-sync.js";

/* =========================
   LOGIN / CONFIG
========================= */
const loggedInUser = JSON.parse(localStorage.getItem("loggedInUser"));
if (!loggedInUser) {
  alert("প্রথমে Login করুন");
  window.location.href = "index.html";
}

const NOTES_NS = String(
  loggedInUser?.username || loggedInUser?.email || "default_user"
).replace(/[.#$/\[\]]/g, "_");

const LOCAL_KEY = `sheba_notes_simple_v2_${NOTES_NS}`;
const DRAFT_KEY = `sheba_notes_draft_simple_v2_${NOTES_NS}`;
const NOTES_BUCKET = "notes_module_media";

/* =========================
   STATE
========================= */
const state = {
  notes: [],
  activeTab: "notes",
  editingNoteId: null,

  draftImages: [],
  draftDocs: [],
  draftAudios: [],
  removedStoragePaths: [],

  speechRecognition: null,
  mediaRecorder: null,
  mediaChunks: [],
  cameraStream: null,

  viewerImages: [],
  viewerIndex: 0
};

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

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(text, len = 140) {
  const t = String(text || "");
  return t.length > len ? t.slice(0, len) + "..." : t;
}

function formatDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function parseTags(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
  )];
}

function renderMarkdownToHtml(text) {
  let t = escapeHtml(text || "");
  t = t.replace(/^### (.*)$/gm, "<h4>$1</h4>");
  t = t.replace(/^## (.*)$/gm, "<h3>$1</h3>");
  t = t.replace(/^# (.*)$/gm, "<h2>$1</h2>");
  t = t.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*(.*?)\*/g, "<em>$1</em>");
  t = t.replace(/^\- (.*)$/gm, "• $1");
  t = t.replace(/^\[x\] (.*)$/gim, "☑ $1");
  t = t.replace(/^\[ \] (.*)$/gim, "☐ $1");
  return t.replace(/\n/g, "<br>");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl || "").split(",");
  const header = parts[0] || "";
  const body = parts[1] || "";
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(body);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

function sanitizeFileName(name = "file") {
  return String(name || "file")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_");
}

function guessExtFromDataUrl(dataUrl, fallbackName = "file") {
  const lower = String(dataUrl || "").slice(0, 80).toLowerCase();
  if (lower.includes("image/png")) return "png";
  if (lower.includes("image/webp")) return "webp";
  if (lower.includes("image/jpeg") || lower.includes("image/jpg")) return "jpg";
  if (lower.includes("audio/webm")) return "webm";
  if (lower.includes("audio/mp4")) return "m4a";
  if (lower.includes("application/pdf")) return "pdf";
  const parts = String(fallbackName).split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "bin";
}

async function getUserId() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }

  return user.id;
}

function buildStoragePath(userId, folder = "notes", fileName = "file") {
  const cleanName = sanitizeFileName(fileName);
  return `${userId}/${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${cleanName}`;
}

async function createSignedMediaUrl(path) {
  if (!path) return "";

  try {
    const { data, error } = await supabase
      .storage
      .from(NOTES_BUCKET)
      .createSignedUrl(path, 60 * 60 * 24 * 7);

    if (error) throw error;
    return data?.signedUrl || "";
  } catch (err) {
    console.error("Signed URL failed:", err);
    return "";
  }
}

async function uploadDataUrl(dataUrl, folder = "notes", fileName = "file") {
  const userId = await getUserId();
  const ext = guessExtFromDataUrl(dataUrl, fileName);
  const safeName = sanitizeFileName(fileName);
  const finalName = safeName.includes(".") ? safeName : `${safeName}.${ext}`;
  const path = buildStoragePath(userId, folder, finalName);
  const blob = dataUrlToBlob(dataUrl);

  const { error } = await supabase
    .storage
    .from(NOTES_BUCKET)
    .upload(path, blob, {
      upsert: false,
      contentType: blob.type || "application/octet-stream"
    });

  if (error) throw error;

  const url = await createSignedMediaUrl(path);
  return { url, path };
}

async function deleteStoragePath(path) {
  if (!path) return;

  try {
    const { error } = await supabase
      .storage
      .from(NOTES_BUCKET)
      .remove([path]);

    if (error) throw error;
  } catch (err) {
    console.warn("deleteStoragePath skipped:", err);
  }
}

function getNote(noteId) {
  return state.notes.find((n) => n.id === noteId);
}

function normalizeNote(note) {
  return {
    id: note.id || uid("note"),
    title: note.title || "Untitled",
    body: note.body || "",
    category: note.category || "General",
    tags: Array.isArray(note.tags) ? note.tags : [],
    color: note.color || "default",

    favorite: !!note.favorite,
    locked: !!note.locked,
    hidden: !!note.hidden,
    isChecklist: !!note.isChecklist,
    lockPin: note.lockPin || "",

    checklist: Array.isArray(note.checklist) ? note.checklist : [],
    images: Array.isArray(note.images) ? note.images : [],
    docs: Array.isArray(note.docs) ? note.docs : [],
    audios: Array.isArray(note.audios) ? note.audios : [],

    reminderDate: note.reminderDate || "",
    reminderTime: note.reminderTime || "",
    reminderRepeat: note.reminderRepeat || "none",
    reminderLastTriggered: note.reminderLastTriggered || "",

    linkedNoteId: note.linkedNoteId || "",

    createdAt: note.createdAt || new Date().toISOString(),
    updatedAt: note.updatedAt || new Date().toISOString(),
    lastEditedAt: note.lastEditedAt || new Date().toISOString()
  };
}

function serializeMediaArray(arr, type = "file") {
  return (Array.isArray(arr) ? arr : []).map((item) => {
    const base = {
      id: item.id || uid(type),
      name: item.name || type,
      path: item.path || ""
    };

    if (type === "doc") {
      base.mimeType = item.mimeType || "";
    }

    if (!item.path && item.url) {
      base.url = item.url;
    }

    return base;
  });
}

function serializeNoteForStorage(note) {
  return {
    ...note,
    images: serializeMediaArray(note.images, "img"),
    docs: serializeMediaArray(note.docs, "doc"),
    audios: serializeMediaArray(note.audios, "aud")
  };
}

async function hydrateMediaArray(arr) {
  const rows = Array.isArray(arr) ? arr : [];
  return Promise.all(rows.map(async (item) => {
    if (item.path) {
      const signedUrl = await createSignedMediaUrl(item.path);
      return {
        ...item,
        url: signedUrl || item.url || ""
      };
    }

    return {
      ...item,
      url: item.url || ""
    };
  }));
}

async function hydrateAllNotesMedia() {
  state.notes = await Promise.all(
    state.notes.map(async (note) => ({
      ...note,
      images: await hydrateMediaArray(note.images),
      docs: await hydrateMediaArray(note.docs),
      audios: await hydrateMediaArray(note.audios)
    }))
  );
}

function hasNewDraftMedia() {
  return (
    state.draftImages.some((x) => x.isNew && x.dataUrl) ||
    state.draftDocs.some((x) => x.isNew && x.dataUrl) ||
    state.draftAudios.some((x) => x.isNew && x.dataUrl)
  );
}

/* =========================
   STORAGE
========================= */
function saveLocal() {
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({
      notes: state.notes.map(serializeNoteForStorage)
    })
  );
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.notes = Array.isArray(parsed.notes)
      ? parsed.notes.map(normalizeNote)
      : [];
  } catch (err) {
    console.error(err);
  }
}

/* =========================
   CLOUD SYNC
========================= */
function getNotesPayload() {
  return {
    notes: state.notes.map(serializeNoteForStorage)
  };
}

function queueNotesSave() {
  addNotesSyncTask(getNotesPayload());
}

async function saveCloud() {
  if (!navigator.onLine) {
    queueNotesSave();
    return;
  }

  try {
    await saveNotesCloudData(getNotesPayload());
  } catch (err) {
    console.error("Notes cloud save failed:", err);
    queueNotesSave();
  }
}

function saveAll() {
  saveLocal();
  saveCloud().catch((err) => console.error("Cloud save failed:", err));
}

async function loadCloud() {
  try {
    const data = await loadNotesCloudData();
    const finalData = data || getEmptyNotesData();
    const cloudNotes = Array.isArray(finalData.notes)
      ? finalData.notes.map(normalizeNote)
      : [];

    if (cloudNotes.length || !state.notes.length) {
      state.notes = cloudNotes;
    }
  } catch (err) {
    console.error("Notes cloud load failed:", err);
  }
}

window.addEventListener("online", async () => {
  try {
    await flushNotesQueue();
    await loadCloud();
    await hydrateAllNotesMedia();
    renderAllNotes();
  } catch (err) {
    console.error("Notes online sync failed:", err);
  }
});

/* =========================
   DRAFT
========================= */
function getDraftData() {
  return {
    title: getVal("noteTitle"),
    category: getVal("noteCategory"),
    tags: getVal("noteTags"),
    body: getVal("noteBody"),
    color: getVal("noteColor", "default"),
    reminderDate: getVal("noteReminderDate"),
    reminderTime: getVal("noteReminderTime"),
    reminderRepeat: getVal("noteReminderRepeat", "none"),
    linkedNoteId: getVal("linkedNoteId"),
    favorite: hasEl("noteFavorite") ? el("noteFavorite").checked : false,
    locked: hasEl("noteLocked") ? el("noteLocked").checked : false,
    hidden: hasEl("noteHidden") ? el("noteHidden").checked : false,
    isChecklist: hasEl("noteIsChecklist") ? el("noteIsChecklist").checked : false,
    lockPin: getVal("noteLockPin"),
    checklist: collectChecklistBuilder(),
    images: state.draftImages,
    docs: state.draftDocs,
    audios: state.draftAudios
  };
}

function saveDraftLocally() {
  if (state.editingNoteId) return;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(getDraftData()));
}

function loadDraftLocally() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearDraftLocally() {
  localStorage.removeItem(DRAFT_KEY);
}

/* =========================
   FILTER / SORT
========================= */
function getViewNotes() {
  const view = getVal("viewFilter", "active");
  let notes = [...state.notes];

  if (view === "hidden") {
    notes = notes.filter((n) => n.hidden);
  } else if (view === "active") {
    notes = notes.filter((n) => !n.hidden);
  }

  const search = getVal("searchInput").trim().toLowerCase();
  if (search) {
    notes = notes.filter((n) => {
      const hay = [
        n.title,
        n.body,
        n.category,
        ...(n.tags || []),
        ...((n.checklist || []).map((c) => c.text))
      ].join(" ").toLowerCase();
      return hay.includes(search);
    });
  }

  const cat = getVal("categoryFilter").trim().toLowerCase();
  if (cat) {
    notes = notes.filter((n) => String(n.category || "").trim().toLowerCase() === cat);
  }

  const sort = getVal("sortFilter", "latest");
  notes.sort((a, b) => {
    if (sort === "oldest") return String(a.createdAt).localeCompare(String(b.createdAt));
    if (sort === "favorite") {
      return Number(b.favorite) - Number(a.favorite) ||
        String(b.updatedAt).localeCompare(String(a.updatedAt));
    }
    if (sort === "titleAsc") return String(a.title).localeCompare(String(b.title));
    if (sort === "titleDesc") return String(b.title).localeCompare(String(a.title));
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });

  return notes;
}

/* =========================
   SUMMARY / REPORT
========================= */
function updateSummary() {
  const total = state.notes.length;
  const favorite = state.notes.filter((n) => n.favorite).length;
  const reminder = state.notes.filter((n) => n.reminderDate).length;
  const locked = state.notes.filter((n) => n.locked).length;
  const hidden = state.notes.filter((n) => n.hidden).length;
  const checklist = state.notes.filter((n) => n.isChecklist).length;

  setText("sumNotes", total);
  setText("sumFavorite", favorite);
  setText("sumReminder", reminder);
  setText("sumLocked", locked);
  setText("sumHidden", hidden);
  setText("sumChecklist", checklist);
  setText("noteCountText", total);
}

function renderWarningCard() {
  const warnings = [];
  const overdue = state.notes.filter((n) => isReminderOverdue(n));
  const today = state.notes.filter((n) => isReminderToday(n));

  if (overdue.length) warnings.push(`Overdue reminder: ${overdue.length} টি`);
  if (today.length) warnings.push(`আজ reminder আছে: ${today.length} টি`);

  if (!warnings.length) {
    hide("warningCard");
    return;
  }

  setHtml("warningList", warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join(""));
  show("warningCard");
}

function renderCategoryFilter() {
  const select = el("categoryFilter");
  if (!select) return;

  const current = select.value;
  const cats = [...new Set(state.notes.map((n) => n.category).filter(Boolean))].sort();

  select.innerHTML =
    `<option value="">সব ক্যাটাগরি</option>` +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  if (cats.includes(current)) select.value = current;
}

function renderLinkedNoteOptions(selected = "") {
  const select = el("linkedNoteId");
  if (!select) return;

  const currentId = state.editingNoteId;
  const rows = state.notes
    .filter((n) => n.id !== currentId)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  select.innerHTML =
    `<option value="">No link</option>` +
    rows.map((n) => `<option value="${n.id}">${escapeHtml(n.title)}</option>`).join("");

  if (selected && rows.some((n) => n.id === selected)) select.value = selected;
}

function renderReportGrid() {
  const total = state.notes.length;
  const checklist = state.notes.filter((n) => n.isChecklist).length;
  const media = state.notes.filter((n) => (n.images.length + n.docs.length + n.audios.length) > 0).length;
  const favorite = state.notes.filter((n) => n.favorite).length;
  const hidden = state.notes.filter((n) => n.hidden).length;
  const locked = state.notes.filter((n) => n.locked).length;

  setHtml(
    "reportGrid",
    `
      <div class="report-box"><span>মোট নোট</span><strong>${total}</strong></div>
      <div class="report-box"><span>Favorite</span><strong>${favorite}</strong></div>
      <div class="report-box"><span>Checklist</span><strong>${checklist}</strong></div>
      <div class="report-box"><span>Media Notes</span><strong>${media}</strong></div>
      <div class="report-box"><span>Locked</span><strong>${locked}</strong></div>
      <div class="report-box"><span>Hidden</span><strong>${hidden}</strong></div>
    `
  );
}

/* =========================
   RENDER LISTS
========================= */
function badgeHtml(note) {
  const out = [];
  if (note.favorite) out.push(`<span class="badge favorite">FAVORITE</span>`);
  if (note.locked) out.push(`<span class="badge lock">LOCK</span>`);
  if (note.hidden) out.push(`<span class="badge hidden-note">HIDDEN</span>`);
  if (note.reminderDate) out.push(`<span class="badge reminder">REMINDER</span>`);
  if (note.isChecklist) out.push(`<span class="badge checklist">CHECKLIST</span>`);
  if (note.linkedNoteId) out.push(`<span class="badge linked">LINKED</span>`);
  return out.join("");
}

function noteColorClass(color) {
  const c = String(color || "default");
  if (["orange", "yellow", "green", "blue", "red"].includes(c)) return `color-${c}`;
  return "";
}

function checklistPreviewHtml(note) {
  if (!note.isChecklist || !note.checklist.length) return "";
  return `
    <div class="checklist-preview">
      ${note.checklist.slice(0, 4).map((item) => `
        <div class="checklist-item ${item.done ? "done" : ""}">
          <input type="checkbox" ${item.done ? "checked" : ""} onclick="event.stopPropagation();toggleChecklistDone('${note.id}','${item.id}')" />
          <div class="check-text">${escapeHtml(item.text)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function mediaPreviewHtml(note) {
  const imgHtml = note.images.length ? `
    <div class="note-preview-grid">
      ${note.images.slice(0, 3).map((img, index) => `
        <img
          src="${img.url || ""}"
          class="note-preview-thumb"
          alt="${escapeHtml(img.name || "image")}"
          onclick="event.stopPropagation();openImageViewer('${note.id}', ${index})"
        />
      `).join("")}
    </div>
  ` : "";

  const docHtml = note.docs.length ? `
    <div class="note-doc-list">
      ${note.docs.slice(0, 2).map((d) => `<div class="doc-chip">📄 ${escapeHtml(d.name || "Document")}</div>`).join("")}
    </div>
  ` : "";

  const audioHtml = note.audios.length ? `
    <div class="note-audio-list">
      ${note.audios.slice(0, 1).map((a) => `<div class="audio-chip">🎤 ${escapeHtml(a.name || "Audio")}</div>`).join("")}
    </div>
  ` : "";

  return imgHtml + docHtml + audioHtml;
}

function createNoteCard(note) {
  return `
    <div class="note-card ${noteColorClass(note.color)}" onclick="openNoteDetail('${note.id}')">
      <div class="note-top">
        <div class="note-main">
          <div class="note-mini">${escapeHtml(note.category || "General")} • ${escapeHtml(formatDateTime(note.updatedAt))}</div>
          <div class="note-title">${escapeHtml(note.title)}</div>
          <div class="note-desc">${escapeHtml(truncate(note.body, 170))}</div>

          <div class="badge-row">
            ${badgeHtml(note)}
          </div>

          <div class="note-meta">
            Tags: ${(note.tags || []).length ? note.tags.map((t) => `#${escapeHtml(t)}`).join(" ") : "-"}<br>
            Reminder: ${escapeHtml(formatReminder(note))}
          </div>

          ${checklistPreviewHtml(note)}
          ${mediaPreviewHtml(note)}
        </div>

        <div class="note-actions" onclick="event.stopPropagation()">
          <button class="note-icon" type="button" onclick="toggleFavorite('${note.id}')">${note.favorite ? "⭐" : "☆"}</button>
          <button class="note-icon" type="button" onclick="openNoteForm('${note.id}')">✎</button>
        </div>
      </div>
    </div>
  `;
}

function renderNotesList() {
  const notes = getViewNotes();
  if (!notes.length) {
    setHtml("notesList", `<div class="panel-card">কোনো নোট পাওয়া যায়নি</div>`);
    return;
  }
  setHtml("notesList", notes.map(createNoteCard).join(""));
}

function renderChecklistList() {
  const notes = getViewNotes().filter((n) => n.isChecklist);
  if (!notes.length) {
    setHtml("checklistList", `<div class="panel-card">কোনো checklist note নেই</div>`);
    return;
  }
  setHtml("checklistList", notes.map(createNoteCard).join(""));
}

function renderReminderList() {
  const notes = getViewNotes()
    .filter((n) => n.reminderDate)
    .sort((a, b) => `${a.reminderDate} ${a.reminderTime || ""}`.localeCompare(`${b.reminderDate} ${b.reminderTime || ""}`));

  if (!notes.length) {
    setHtml("reminderList", `<div class="panel-card">কোনো reminder note নেই</div>`);
    return;
  }
  setHtml("reminderList", notes.map(createNoteCard).join(""));
}

function renderMediaList() {
  const notes = getViewNotes().filter((n) => (n.images.length + n.docs.length + n.audios.length) > 0);
  if (!notes.length) {
    setHtml("mediaList", `<div class="panel-card">কোনো media note নেই</div>`);
    return;
  }
  setHtml("mediaList", notes.map(createNoteCard).join(""));
}

function renderAllNotes() {
  updateSummary();
  renderWarningCard();
  renderCategoryFilter();
  renderLinkedNoteOptions();
  renderNotesList();
  renderChecklistList();
  renderReminderList();
  renderMediaList();
  renderReportGrid();
  checkDueNotifications();
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
   FORM
========================= */
function clearEditorMedia() {
  state.draftImages = [];
  state.draftDocs = [];
  state.draftAudios = [];
  state.removedStoragePaths = [];
  renderImagePreviewList();
  renderDocPreviewList();
  renderAudioPreviewList();
}

function resetNoteForm() {
  [
    "noteTitle",
    "noteCategory",
    "noteTags",
    "noteBody",
    "noteReminderDate",
    "noteReminderTime",
    "noteLockPin"
  ].forEach((id) => setVal(id, ""));

  setVal("noteColor", "default");
  setVal("noteVoiceLang", "bn-BD");
  setVal("noteReminderRepeat", "none");
  setVal("linkedNoteId", "");

  if (hasEl("noteFavorite")) el("noteFavorite").checked = false;
  if (hasEl("noteLocked")) el("noteLocked").checked = false;
  if (hasEl("noteHidden")) el("noteHidden").checked = false;
  if (hasEl("noteIsChecklist")) el("noteIsChecklist").checked = false;

  clearEditorMedia();
  setHtml("checklistBuilder", "");
  addChecklistItem();
  updateWordCharCount();
  toggleLockPinField();
}

function applyFormData(note) {
  setVal("noteTitle", note.title || "");
  setVal("noteCategory", note.category || "");
  setVal("noteTags", (note.tags || []).join(", "));
  setVal("noteBody", note.body || "");
  setVal("noteColor", note.color || "default");
  setVal("noteReminderDate", note.reminderDate || "");
  setVal("noteReminderTime", note.reminderTime || "");
  setVal("noteReminderRepeat", note.reminderRepeat || "none");
  renderLinkedNoteOptions(note.linkedNoteId || "");
  if (note.linkedNoteId) setVal("linkedNoteId", note.linkedNoteId);

  if (hasEl("noteFavorite")) el("noteFavorite").checked = !!note.favorite;
  if (hasEl("noteLocked")) el("noteLocked").checked = !!note.locked;
  if (hasEl("noteHidden")) el("noteHidden").checked = !!note.hidden;
  if (hasEl("noteIsChecklist")) el("noteIsChecklist").checked = !!note.isChecklist;

  setVal("noteLockPin", note.lockPin || "");
  setHtml("checklistBuilder", "");
  (note.checklist || []).forEach((item) => addChecklistItem(item.text, item.done));

  updateWordCharCount();
  toggleLockPinField();
}

function openNoteForm(noteId = null) {
  state.editingNoteId = noteId;
  resetNoteForm();
  el("noteModal")?.classList.add("show");
  setText("noteModalTitle", noteId ? "নোট এডিট" : "নতুন নোট");

  if (noteId) {
    const note = getNote(noteId);
    if (!note) return;
    if (!canOpenLockedNote(note)) return closeNoteForm();

    applyFormData(note);
    state.draftImages = note.images.map((x) => ({ ...x, isNew: false }));
    state.draftDocs = note.docs.map((x) => ({ ...x, isNew: false }));
    state.draftAudios = note.audios.map((x) => ({ ...x, isNew: false }));
    renderImagePreviewList();
    renderDocPreviewList();
    renderAudioPreviewList();
    return;
  }

  const draft = loadDraftLocally();
  if (draft) {
    applyFormData(draft);
    state.draftImages = Array.isArray(draft.images) ? draft.images : [];
    state.draftDocs = Array.isArray(draft.docs) ? draft.docs : [];
    state.draftAudios = Array.isArray(draft.audios) ? draft.audios : [];
    renderImagePreviewList();
    renderDocPreviewList();
    renderAudioPreviewList();
  }
}

function closeNoteForm() {
  el("noteModal")?.classList.remove("show");
  stopSpeechRecognition();
  stopAudioRecording();
  stopCameraCapture();
  state.editingNoteId = null;
}

function toggleLockPinField() {
  const locked = hasEl("noteLocked") ? el("noteLocked").checked : false;
  if (locked) show("lockPinWrap");
  else hide("lockPinWrap");
}

function updateWordCharCount() {
  const text = getVal("noteBody", "");
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  setText("charCount", chars);
  setText("wordCount", words);
}

function wireFormWatchers() {
  ["noteTitle", "noteCategory", "noteTags", "noteBody", "noteColor", "noteReminderDate", "noteReminderTime", "noteReminderRepeat", "linkedNoteId", "noteLockPin"]
    .forEach((id) => {
      const node = el(id);
      if (!node) return;
      node.addEventListener("input", () => {
        updateWordCharCount();
        saveDraftLocally();
      });
      node.addEventListener("change", () => {
        updateWordCharCount();
        saveDraftLocally();
      });
    });

  ["noteFavorite", "noteLocked", "noteHidden", "noteIsChecklist"].forEach((id) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener("change", () => {
      if (id === "noteLocked") toggleLockPinField();
      saveDraftLocally();
    });
  });
}

/* =========================
   CHECKLIST BUILDER
========================= */
function addChecklistItem(value = "", done = false) {
  const wrap = el("checklistBuilder");
  if (!wrap) return;

  const row = document.createElement("div");
  row.className = "checkline";
  row.innerHTML = `
    <input type="checkbox" class="checkline-done" ${done ? "checked" : ""} />
    <input type="text" class="input checkline-input" placeholder="Checklist item" value="${escapeHtml(value)}" />
    <button class="note-icon" type="button" onclick="removeChecklistItem(this)">✕</button>
  `;
  wrap.appendChild(row);
}

function removeChecklistItem(btn) {
  btn.closest(".checkline")?.remove();
  saveDraftLocally();
}

function collectChecklistBuilder() {
  return [...document.querySelectorAll("#checklistBuilder .checkline")]
    .map((row) => {
      const text = row.querySelector(".checkline-input")?.value?.trim() || "";
      const done = !!row.querySelector(".checkline-done")?.checked;
      if (!text) return null;
      return { id: uid("chk"), text, done };
    })
    .filter(Boolean);
}

/* =========================
   MARKDOWN / TEMPLATE
========================= */
function insertMarkdown(type) {
  const textarea = el("noteBody");
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);

  let insert = "";
  if (type === "bold") insert = `**${selected || "text"}**`;
  else if (type === "italic") insert = `*${selected || "text"}*`;
  else if (type === "list") insert = `\n- ${selected || "item"}`;
  else if (type === "heading") insert = `\n# ${selected || "Heading"}`;
  else if (type === "check") insert = `\n[ ] ${selected || "task"}`;

  textarea.value = value.slice(0, start) + insert + value.slice(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + insert.length;
  updateWordCharCount();
  saveDraftLocally();
}

function openTemplate(type) {
  openNoteForm();

  if (type === "general") {
    setVal("noteTitle", "");
    setVal("noteCategory", "General");
    setVal("noteBody", "");
  }

  if (type === "todo") {
    setVal("noteTitle", "Todo List");
    setVal("noteCategory", "Work");
    if (hasEl("noteIsChecklist")) el("noteIsChecklist").checked = true;
    setHtml("checklistBuilder", "");
    addChecklistItem("প্রথম কাজ");
    addChecklistItem("দ্বিতীয় কাজ");
    addChecklistItem("তৃতীয় কাজ");
  }

  if (type === "meeting") {
    setVal("noteTitle", "Meeting Note");
    setVal("noteCategory", "Work");
    setVal("noteBody", "সভা বিষয়:\nউপস্থিতি:\nমূল আলোচনা:\nসিদ্ধান্ত:\nপরবর্তী কাজ:");
  }

  if (type === "client") {
    setVal("noteTitle", "Client Note");
    setVal("noteCategory", "Client");
    setVal("noteBody", "Client Name:\nPhone:\nNeed:\nFollow-up:");
  }

  if (type === "idea") {
    setVal("noteTitle", "New Idea");
    setVal("noteCategory", "Personal");
    setVal("noteBody", "আইডিয়ার বিবরণ:\nসম্ভাবনা:\nপরবর্তী ধাপ:");
  }

  if (type === "payment") {
    setVal("noteTitle", "Payment Note");
    setVal("noteCategory", "Accounts");
    setVal("noteBody", "কার কাছ থেকে / কাকে:\nপরিমাণ:\nতারিখ:\nনোট:");
  }

  updateWordCharCount();
  saveDraftLocally();
}

/* =========================
   IMAGES / DOCS / AUDIOS
========================= */
async function handleNoteImages(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;

  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    state.draftImages.push({
      id: uid("img"),
      name: file.name,
      url: dataUrl,
      path: "",
      dataUrl,
      isNew: true
    });
  }

  renderImagePreviewList();
  saveDraftLocally();
  event.target.value = "";
}

function renderImagePreviewList() {
  if (!hasEl("imagePreviewList")) return;
  if (!state.draftImages.length) {
    setHtml("imagePreviewList", "");
    return;
  }

  setHtml(
    "imagePreviewList",
    state.draftImages
      .map(
        (img, index) => `
        <div class="preview-item">
          <img src="${img.url}" alt="${escapeHtml(img.name || "image")}" onclick="openDraftImagePreview(${index})" />
          <button class="preview-remove" type="button" onclick="removeDraftImage('${img.id}')">✕</button>
          <div class="preview-name">${escapeHtml(img.name || "Image")}</div>
        </div>
      `
      )
      .join("")
  );
}

function removeDraftImage(imageId) {
  const item = state.draftImages.find((x) => x.id === imageId);
  if (item?.path) state.removedStoragePaths.push(item.path);
  state.draftImages = state.draftImages.filter((x) => x.id !== imageId);
  renderImagePreviewList();
  saveDraftLocally();
}

function clearAllImages() {
  state.draftImages.forEach((img) => {
    if (img.path) state.removedStoragePaths.push(img.path);
  });
  state.draftImages = [];
  renderImagePreviewList();
  saveDraftLocally();
}

async function handleNoteDocs(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) return;

  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    state.draftDocs.push({
      id: uid("doc"),
      name: file.name,
      url: "",
      path: "",
      mimeType: file.type || "",
      dataUrl,
      isNew: true
    });
  }

  renderDocPreviewList();
  saveDraftLocally();
  event.target.value = "";
}

function renderDocPreviewList() {
  if (!hasEl("docPreviewList")) return;
  if (!state.draftDocs.length) {
    setHtml("docPreviewList", "");
    return;
  }

  setHtml(
    "docPreviewList",
    state.draftDocs
      .map(
        (docItem) => `
        <div class="doc-item">
          <div><strong>📄 ${escapeHtml(docItem.name || "Document")}</strong></div>
          <div class="inline-actions mt-8">
            <button class="tiny-action tiny-red" type="button" onclick="removeDraftDoc('${docItem.id}')">Remove</button>
          </div>
        </div>
      `
      )
      .join("")
  );
}

function removeDraftDoc(docId) {
  const item = state.draftDocs.find((x) => x.id === docId);
  if (item?.path) state.removedStoragePaths.push(item.path);
  state.draftDocs = state.draftDocs.filter((x) => x.id !== docId);
  renderDocPreviewList();
  saveDraftLocally();
}

function clearAllDocs() {
  state.draftDocs.forEach((d) => {
    if (d.path) state.removedStoragePaths.push(d.path);
  });
  state.draftDocs = [];
  renderDocPreviewList();
  saveDraftLocally();
}

function renderAudioPreviewList() {
  if (!hasEl("audioPreviewList")) return;
  if (!state.draftAudios.length) {
    setHtml("audioPreviewList", "");
    return;
  }

  setHtml(
    "audioPreviewList",
    state.draftAudios
      .map(
        (a) => `
        <div class="audio-item">
          <div><strong>🎤 ${escapeHtml(a.name || "Audio")}</strong></div>
          <audio controls src="${a.url}"></audio>
          <div class="inline-actions mt-8">
            <button class="tiny-action tiny-red" type="button" onclick="removeDraftAudio('${a.id}')">Remove</button>
          </div>
        </div>
      `
      )
      .join("")
  );
}

function removeDraftAudio(audioId) {
  const item = state.draftAudios.find((x) => x.id === audioId);
  if (item?.path) state.removedStoragePaths.push(item.path);
  state.draftAudios = state.draftAudios.filter((x) => x.id !== audioId);
  renderAudioPreviewList();
  saveDraftLocally();
}

/* =========================
   CAMERA
========================= */
async function startCameraCapture() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    state.cameraStream = stream;
    const video = el("noteCamera");
    if (video) {
      video.srcObject = stream;
      video.classList.remove("hidden");
    }
    show("cameraCaptureRow");
  } catch {
    alert("Camera permission denied বা support নেই");
  }
}

function stopCameraCapture() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  const video = el("noteCamera");
  if (video) {
    video.srcObject = null;
    video.classList.add("hidden");
  }
  hide("cameraCaptureRow");
}

function captureCameraPhoto() {
  const video = el("noteCamera");
  const canvas = el("noteCanvas");
  if (!video || !canvas || !state.cameraStream) return;

  canvas.width = video.videoWidth || 800;
  canvas.height = video.videoHeight || 600;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  state.draftImages.push({
    id: uid("img"),
    name: `camera_${Date.now()}.jpg`,
    url: dataUrl,
    path: "",
    dataUrl,
    isNew: true
  });

  renderImagePreviewList();
  saveDraftLocally();
  stopCameraCapture();
}

/* =========================
   SPEECH / AUDIO
========================= */
function startSpeechToText() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("Speech recognition support নেই");
    return;
  }

  stopSpeechRecognition();

  const recog = new SR();
  recog.lang = getVal("noteVoiceLang", "bn-BD");
  recog.continuous = true;
  recog.interimResults = true;

  recog.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    const body = el("noteBody");
    if (body) {
      body.value = body.value ? `${body.value} ${transcript}` : transcript;
      updateWordCharCount();
      saveDraftLocally();
    }
  };

  recog.onend = () => {
    state.speechRecognition = null;
  };

  state.speechRecognition = recog;
  recog.start();
}

function stopSpeechRecognition() {
  try {
    state.speechRecognition?.stop();
  } catch {}
  state.speechRecognition = null;
}

async function startAudioRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.mediaChunks = [];
    state.mediaRecorder = new MediaRecorder(stream);

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.mediaChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      const blob = new Blob(state.mediaChunks, { type: "audio/webm" });
      const dataUrl = await blobToDataUrl(blob);

      state.draftAudios.push({
        id: uid("aud"),
        name: `audio_${Date.now()}.webm`,
        url: dataUrl,
        path: "",
        dataUrl,
        isNew: true
      });

      renderAudioPreviewList();
      saveDraftLocally();

      stream.getTracks().forEach((t) => t.stop());
      state.mediaRecorder = null;
      state.mediaChunks = [];
    };

    state.mediaRecorder.start();
    alert("Audio recording started");
  } catch {
    alert("Microphone permission denied বা support নেই");
  }
}

function stopAudioRecording() {
  try {
    if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
      state.mediaRecorder.stop();
    }
  } catch {}
}

/* =========================
   SAVE NOTE
========================= */
async function uploadDraftMedia() {
  const finalImages = [];
  const finalDocs = [];
  const finalAudios = [];

  for (const img of state.draftImages) {
    if (img.isNew && img.dataUrl) {
      const uploaded = await uploadDataUrl(img.dataUrl, "images", img.name || "image.jpg");
      finalImages.push({
        id: img.id || uid("img"),
        name: img.name || "Image",
        url: uploaded.url,
        path: uploaded.path
      });
    } else {
      finalImages.push({
        id: img.id || uid("img"),
        name: img.name || "Image",
        url: img.url || "",
        path: img.path || ""
      });
    }
  }

  for (const d of state.draftDocs) {
    if (d.isNew && d.dataUrl) {
      const uploaded = await uploadDataUrl(d.dataUrl, "docs", d.name || "doc.bin");
      finalDocs.push({
        id: d.id || uid("doc"),
        name: d.name || "Document",
        url: uploaded.url,
        path: uploaded.path,
        mimeType: d.mimeType || ""
      });
    } else {
      finalDocs.push({
        id: d.id || uid("doc"),
        name: d.name || "Document",
        url: d.url || "",
        path: d.path || "",
        mimeType: d.mimeType || ""
      });
    }
  }

  for (const a of state.draftAudios) {
    if (a.isNew && a.dataUrl) {
      const uploaded = await uploadDataUrl(a.dataUrl, "audios", a.name || "audio.webm");
      finalAudios.push({
        id: a.id || uid("aud"),
        name: a.name || "Audio",
        url: uploaded.url,
        path: uploaded.path
      });
    } else {
      finalAudios.push({
        id: a.id || uid("aud"),
        name: a.name || "Audio",
        url: a.url || "",
        path: a.path || ""
      });
    }
  }

  return { finalImages, finalDocs, finalAudios };
}

async function removeDeletedMediaFromStorage() {
  if (!navigator.onLine) return;

  for (const path of [...new Set(state.removedStoragePaths.filter(Boolean))]) {
    await deleteStoragePath(path);
  }
  state.removedStoragePaths = [];
}

async function saveNote() {
  const title = getVal("noteTitle").trim();
  if (!title) return alert("নোটের শিরোনাম দিন");

  const locked = hasEl("noteLocked") ? el("noteLocked").checked : false;
  const lockPin = getVal("noteLockPin").trim();
  if (locked && !lockPin) return alert("Lock note-এর জন্য PIN দিন");

  if (!navigator.onLine && hasNewDraftMedia()) {
    alert("নতুন image / doc / audio save করতে internet on করতে হবে");
    return;
  }

  try {
    const checklist = collectChecklistBuilder();
    const { finalImages, finalDocs, finalAudios } = await uploadDraftMedia();
    await removeDeletedMediaFromStorage();

    const payload = {
      title,
      category: getVal("noteCategory").trim() || "General",
      tags: parseTags(getVal("noteTags")),
      body: getVal("noteBody").trim(),
      color: getVal("noteColor", "default"),

      favorite: hasEl("noteFavorite") ? el("noteFavorite").checked : false,
      locked,
      hidden: hasEl("noteHidden") ? el("noteHidden").checked : false,
      isChecklist: hasEl("noteIsChecklist") ? el("noteIsChecklist").checked : false,
      lockPin: locked ? lockPin : "",

      checklist,
      images: finalImages,
      docs: finalDocs,
      audios: finalAudios,

      reminderDate: getVal("noteReminderDate"),
      reminderTime: getVal("noteReminderTime"),
      reminderRepeat: getVal("noteReminderRepeat", "none"),
      linkedNoteId: getVal("linkedNoteId"),

      updatedAt: new Date().toISOString(),
      lastEditedAt: new Date().toISOString()
    };

    if (state.editingNoteId) {
      const note = getNote(state.editingNoteId);
      if (!note) return;
      Object.assign(note, payload);
    } else {
      state.notes.unshift(
        normalizeNote({
          id: uid("note"),
          createdAt: new Date().toISOString(),
          reminderLastTriggered: "",
          ...payload
        })
      );
    }

    clearDraftLocally();
    saveAll();
    renderAllNotes();
    closeNoteForm();
  } catch (err) {
    console.error(err);
    alert("নোট save করতে সমস্যা হয়েছে");
  }
}

/* =========================
   NOTE ACTIONS
========================= */
function canOpenLockedNote(note) {
  if (!note.locked) return true;
  const pin = prompt("এই নোট লক করা আছে। PIN দিন");
  if (!pin) return false;
  if (pin !== note.lockPin) {
    alert("ভুল PIN");
    return false;
  }
  return true;
}

function formatReminder(note) {
  if (!note.reminderDate) return "-";
  return `${note.reminderDate}${note.reminderTime ? " " + note.reminderTime : ""}`;
}

function openNoteDetail(noteId) {
  const note = getNote(noteId);
  if (!note) return;
  if (!canOpenLockedNote(note)) return;

  const linkedNote = note.linkedNoteId ? getNote(note.linkedNoteId) : null;

  setHtml(
    "noteDetailContent",
    `
      <div class="detail-title">${escapeHtml(note.title)}</div>

      <div class="badge-row">
        ${badgeHtml(note)}
      </div>

      <div class="detail-meta">
        Category: ${escapeHtml(note.category || "-")}<br>
        Tags: ${(note.tags || []).length ? note.tags.map((t) => `#${escapeHtml(t)}`).join(" ") : "-"}<br>
        Created: ${escapeHtml(formatDateTime(note.createdAt))}<br>
        Updated: ${escapeHtml(formatDateTime(note.updatedAt))}<br>
        Reminder: ${escapeHtml(formatReminder(note))}<br>
        Repeat: ${escapeHtml(note.reminderRepeat || "none")}
      </div>

      <div class="detail-body mt-12">${renderMarkdownToHtml(note.body)}</div>

      ${
        note.isChecklist && note.checklist.length
          ? `
        <div class="panel-card mt-12">
          <div class="panel-title">Checklist</div>
          <div class="checklist-preview mt-8">
            ${note.checklist.map((item) => `
              <div class="checklist-item ${item.done ? "done" : ""}">
                <input type="checkbox" ${item.done ? "checked" : ""} onclick="toggleChecklistDone('${note.id}','${item.id}')" />
                <div class="check-text">${escapeHtml(item.text)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      `
          : ""
      }

      ${
        note.images.length
          ? `
        <div class="panel-card mt-12">
          <div class="panel-title">Images</div>
          <div class="detail-image-grid mt-8">
            ${note.images.map((img, index) => `
              <img src="${img.url || ""}" alt="${escapeHtml(img.name || "image")}" onclick="openImageViewer('${note.id}', ${index})" />
            `).join("")}
          </div>
        </div>
      `
          : ""
      }

      ${
        note.docs.length
          ? `
        <div class="panel-card mt-12">
          <div class="panel-title">Documents</div>
          <div class="doc-list mt-8">
            ${note.docs.map((d, index) => `
              <div class="doc-item">
                <div><strong>📄 ${escapeHtml(d.name || "Document")}</strong></div>
                <div class="inline-actions mt-8">
                  <button class="tiny-action tiny-blue" type="button" onclick="openNoteDoc('${note.id}', ${index})">Open</button>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      `
          : ""
      }

      ${
        note.audios.length
          ? `
        <div class="panel-card mt-12">
          <div class="panel-title">Audios</div>
          <div class="audio-list mt-8">
            ${note.audios.map((a) => `
              <div class="audio-item">
                <div><strong>🎤 ${escapeHtml(a.name || "Audio")}</strong></div>
                <audio controls src="${a.url || ""}"></audio>
              </div>
            `).join("")}
          </div>
        </div>
      `
          : ""
      }

      ${
        linkedNote
          ? `
        <div class="panel-card mt-12">
          <div class="panel-title">Linked Note</div>
          <div class="doc-item mt-8">
            <div><strong>${escapeHtml(linkedNote.title)}</strong></div>
            <div>${escapeHtml(truncate(linkedNote.body, 100))}</div>
            <div class="inline-actions mt-8">
              <button class="tiny-action tiny-blue" type="button" onclick="jumpToLinkedNote('${linkedNote.id}')">Open Linked Note</button>
            </div>
          </div>
        </div>
      `
          : ""
      }

      <div class="detail-action-grid">
        <button class="action-btn primary" type="button" onclick="openNoteForm('${note.id}')">Edit</button>
        <button class="action-btn yellow" type="button" onclick="downloadSinglePdf('${note.id}')">PDF</button>
        <button class="action-btn green" type="button" onclick="shareNote('${note.id}')">Share</button>
        <button class="action-btn primary" type="button" onclick="duplicateNote('${note.id}')">Duplicate</button>
        <button class="action-btn orange-solid" type="button" onclick="toggleFavorite('${note.id}')">${note.favorite ? "Unfavorite" : "Favorite"}</button>
        <button class="action-btn red" type="button" onclick="deleteNote('${note.id}')">Delete</button>
      </div>
    `
  );

  el("noteDetailModal")?.classList.add("show");
}

function closeNoteDetail() {
  el("noteDetailModal")?.classList.remove("show");
}

function toggleFavorite(noteId) {
  const note = getNote(noteId);
  if (!note) return;
  note.favorite = !note.favorite;
  note.updatedAt = new Date().toISOString();
  note.lastEditedAt = new Date().toISOString();
  saveAll();
  renderAllNotes();
  if (el("noteDetailModal")?.classList.contains("show")) openNoteDetail(noteId);
}

async function deleteNote(noteId) {
  const note = getNote(noteId);
  if (!note) return;
  if (!confirm("এই নোট delete করবেন?")) return;

  if (navigator.onLine) {
    const paths = [
      ...note.images.map((x) => x.path || ""),
      ...note.docs.map((x) => x.path || ""),
      ...note.audios.map((x) => x.path || "")
    ].filter(Boolean);

    for (const p of paths) {
      await deleteStoragePath(p);
    }
  }

  state.notes = state.notes.filter((n) => n.id !== noteId);
  saveAll();
  renderAllNotes();
  closeNoteDetail();
}

function duplicateNote(noteId) {
  const note = getNote(noteId);
  if (!note) return;

  const copy = normalizeNote({
    ...JSON.parse(JSON.stringify(serializeNoteForStorage(note))),
    id: uid("note"),
    title: `${note.title} (Copy)`,
    favorite: false,
    hidden: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEditedAt: new Date().toISOString()
  });

  state.notes.unshift(copy);
  saveAll();
  renderAllNotes();
}

function jumpToLinkedNote(noteId) {
  closeNoteDetail();
  openNoteDetail(noteId);
}

async function openNoteDoc(noteId, docIndex) {
  const note = getNote(noteId);
  if (!note) return;

  const docItem = note.docs?.[docIndex];
  if (!docItem) return;

  if (docItem.path) {
    const url = await createSignedMediaUrl(docItem.path);
    if (url) {
      docItem.url = url;
      window.open(url, "_blank");
      return;
    }
  }

  if (docItem.url) {
    window.open(docItem.url, "_blank");
  }
}

function toggleChecklistDone(noteId, itemId) {
  const note = getNote(noteId);
  if (!note) return;
  const item = note.checklist.find((x) => x.id === itemId);
  if (!item) return;

  item.done = !item.done;
  note.updatedAt = new Date().toISOString();
  note.lastEditedAt = new Date().toISOString();

  saveAll();
  renderAllNotes();
  if (el("noteDetailModal")?.classList.contains("show")) openNoteDetail(noteId);
}

/* =========================
   IMAGE VIEWER
========================= */
function openImageViewer(noteId, index = 0) {
  const note = getNote(noteId);
  if (!note || !note.images.length) return;

  state.viewerImages = note.images.map((x) => x.url).filter(Boolean);
  state.viewerIndex = index;
  setViewerImage();
  el("imageViewerModal")?.classList.add("show");
}

function openDraftImagePreview(index = 0) {
  if (!state.draftImages.length) return;
  state.viewerImages = state.draftImages.map((x) => x.url).filter(Boolean);
  state.viewerIndex = index;
  setViewerImage();
  el("imageViewerModal")?.classList.add("show");
}

function setViewerImage() {
  const node = el("viewerImage");
  if (node) node.src = state.viewerImages[state.viewerIndex] || "";
}

function closeImageViewer() {
  el("imageViewerModal")?.classList.remove("show");
}

function prevImage() {
  if (!state.viewerImages.length) return;
  state.viewerIndex = (state.viewerIndex - 1 + state.viewerImages.length) % state.viewerImages.length;
  setViewerImage();
}

function nextImage() {
  if (!state.viewerImages.length) return;
  state.viewerIndex = (state.viewerIndex + 1) % state.viewerImages.length;
  setViewerImage();
}

/* =========================
   PDF / BACKUP / SHARE
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

async function exportNotesToPdf(notes, fileName = "notes_export") {
  if (!notes.length) return alert("কোনো note নেই");

  try {
    const JsPdf = await ensureJsPdf();
    const pdf = new JsPdf();

    let y = 14;

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (i > 0) {
        pdf.addPage();
        y = 14;
      }

      pdf.setFontSize(16);
      pdf.text(String(n.title || "Untitled"), 10, y);
      y += 8;

      pdf.setFontSize(11);
      pdf.text(`Category: ${String(n.category || "-")}`, 10, y);
      y += 6;
      pdf.text(`Updated: ${formatDateTime(n.updatedAt)}`, 10, y);
      y += 6;
      pdf.text(`Tags: ${(n.tags || []).join(", ") || "-"}`, 10, y);
      y += 8;

      const bodyLines = pdf.splitTextToSize(String(n.body || ""), 180);
      pdf.text(bodyLines, 10, y);
      y += bodyLines.length * 6 + 6;

      if (n.checklist.length) {
        pdf.text("Checklist:", 10, y);
        y += 6;
        n.checklist.forEach((item) => {
          const line = `${item.done ? "[x]" : "[ ]"} ${item.text}`;
          const lines = pdf.splitTextToSize(line, 180);
          pdf.text(lines, 12, y);
          y += lines.length * 6;
        });
      }
    }

    pdf.save(`${fileName}.pdf`);
  } catch (err) {
    console.error(err);
    alert("PDF export করতে সমস্যা হয়েছে");
  }
}

async function exportSelectedOrAllPdf() {
  await exportNotesToPdf(getViewNotes(), "notes_export");
}

async function downloadSinglePdf(noteId) {
  const note = getNote(noteId);
  if (!note) return;
  await exportNotesToPdf([note], note.title.replace(/[^\w\-]+/g, "_").slice(0, 40) || "note");
}

async function shareNote(noteId) {
  const note = getNote(noteId);
  if (!note) return;

  const text = [
    note.title,
    `Category: ${note.category || "-"}`,
    `Tags: ${(note.tags || []).join(", ") || "-"}`,
    note.body || ""
  ].join("\n\n");

  if (navigator.share) {
    try {
      await navigator.share({ title: note.title, text });
      return;
    } catch {}
  }

  try {
    await navigator.clipboard.writeText(text);
    alert("নোট copy হয়েছে");
  } catch {
    alert(text);
  }
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    notes: state.notes.map(serializeNoteForStorage)
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `notes-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function restoreBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const fr = new FileReader();
  fr.onload = async () => {
    try {
      const parsed = JSON.parse(fr.result);
      if (!Array.isArray(parsed.notes)) {
        alert("Invalid backup file");
        return;
      }

      if (!confirm("Backup restore করলে বর্তমান note replace হবে। চালাবেন?")) return;

      state.notes = parsed.notes.map(normalizeNote);
      await hydrateAllNotesMedia();
      saveAll();
      renderAllNotes();
      alert("Backup restore হয়েছে");
    } catch (err) {
      console.error(err);
      alert("Backup file পড়া যায়নি");
    } finally {
      event.target.value = "";
    }
  };
  fr.readAsText(file);
}

/* =========================
   REMINDER
========================= */
function combineReminderDateTime(note) {
  if (!note.reminderDate) return null;
  const time = note.reminderTime || "09:00";
  const dt = new Date(`${note.reminderDate}T${time}:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isReminderToday(note) {
  if (!note.reminderDate) return false;
  return note.reminderDate === todayStr();
}

function isReminderOverdue(note) {
  const dt = combineReminderDateTime(note);
  if (!dt) return false;
  return dt.getTime() < Date.now() && !note.reminderLastTriggered;
}

function isRepeatDue(note) {
  if (!note.reminderDate || !note.reminderRepeat || note.reminderRepeat === "none") return false;

  const time = note.reminderTime || "09:00";
  const now = new Date();
  const [hh, mm] = time.split(":").map((x) => safeNumber(x));
  const original = new Date(`${note.reminderDate}T${time}:00`);
  if (Number.isNaN(original.getTime())) return false;

  if (now.getHours() < hh || (now.getHours() === hh && now.getMinutes() < mm)) return false;

  const last = note.reminderLastTriggered ? new Date(note.reminderLastTriggered) : null;

  if (note.reminderRepeat === "daily") {
    return !last || last.toDateString() !== now.toDateString();
  }

  if (note.reminderRepeat === "weekly") {
    if (now.getDay() !== original.getDay()) return false;
    if (!last) return true;
    return Math.floor((now - last) / 86400000) >= 6;
  }

  if (note.reminderRepeat === "monthly") {
    if (now.getDate() !== original.getDate()) return false;
    if (!last) return true;
    return last.getMonth() !== now.getMonth() || last.getFullYear() !== now.getFullYear();
  }

  return false;
}

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
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const now = new Date();

  state.notes.forEach((note) => {
    if (note.hidden) return;
    if (!note.reminderDate) return;

    let due = false;
    const dt = combineReminderDateTime(note);

    if (dt && dt.getTime() <= now.getTime() && !note.reminderLastTriggered) {
      due = true;
    }

    if (!due && isRepeatDue(note)) {
      due = true;
    }

    if (!due) return;

    new Notification(note.title || "Reminder", {
      body: truncate(note.body || "Note reminder", 120)
    });

    note.reminderLastTriggered = new Date().toISOString();
  });

  saveAll();
}

/* =========================
   OCR
========================= */
function handleOcrImage(event) {
  event.target.value = "";
  alert("OCR এখন এই version-এ রাখা হয়নি");
}

/* =========================
   MODAL / CLOSE
========================= */
function handleModalBackdrop(e) {
  ["noteModal", "noteDetailModal", "imageViewerModal"].forEach((id) => {
    const modal = el(id);
    if (modal && e.target === modal) modal.classList.remove("show");
  });
}

/* =========================
   INIT
========================= */
async function init() {
  loadLocal();
  await hydrateAllNotesMedia();
  renderAllNotes();
  renderLinkedNoteOptions();
  wireFormWatchers();

  try {
    await flushNotesQueue();
  } catch (err) {
    console.error("Initial notes queue flush failed:", err);
  }

  await loadCloud();
  await hydrateAllNotesMedia();
  renderAllNotes();

  setInterval(checkDueNotifications, 60000);
}

window.addEventListener("DOMContentLoaded", init);
document.addEventListener("click", handleModalBackdrop);

/* =========================
   EXPOSE
========================= */
Object.assign(window, {
  switchTab,
  renderAllNotes,

  openNoteForm,
  closeNoteForm,
  saveNote,

  addChecklistItem,
  removeChecklistItem,
  toggleChecklistDone,

  insertMarkdown,
  openTemplate,

  handleNoteImages,
  removeDraftImage,
  clearAllImages,
  handleNoteDocs,
  clearAllDocs,
  removeDraftDoc,

  startCameraCapture,
  captureCameraPhoto,
  stopCameraCapture,

  startSpeechToText,
  stopSpeechRecognition,
  startAudioRecording,
  stopAudioRecording,
  removeDraftAudio,

  openNoteDetail,
  closeNoteDetail,
  toggleFavorite,
  deleteNote,
  duplicateNote,
  shareNote,
  downloadSinglePdf,
  jumpToLinkedNote,

  openImageViewer,
  openDraftImagePreview,
  closeImageViewer,
  prevImage,
  nextImage,

  exportSelectedOrAllPdf,
  exportBackup,
  restoreBackup,
  requestNotificationPermission,
  handleOcrImage,
  openNoteDoc
});