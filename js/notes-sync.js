import { saveNotesCloudData } from "./notes-cloud.js";

const loggedInUser = JSON.parse(localStorage.getItem("loggedInUser") || "null");
const NOTES_NS = String(
  loggedInUser?.username || loggedInUser?.email || "default_user"
).replace(/[.#$/\[\]]/g, "_");

const NOTES_QUEUE_KEY = `sheba_notes_sync_queue_${NOTES_NS}`;

function readQueue() {
  try {
    const raw = localStorage.getItem(NOTES_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  localStorage.setItem(NOTES_QUEUE_KEY, JSON.stringify(Array.isArray(queue) ? queue : []));
}

export function addNotesSyncTask(payload) {
  const queue = readQueue();

  queue.push({
    id: `notes_sync_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    payload,
    created_at: new Date().toISOString()
  });

  writeQueue(queue);
}

export function getNotesQueueCount() {
  return readQueue().length;
}

export async function flushNotesQueue() {
  if (!navigator.onLine) return false;

  const queue = readQueue();
  if (!queue.length) return true;

  const latestTask = queue[queue.length - 1];

  await saveNotesCloudData(latestTask.payload);
  writeQueue([]);

  return true;
}