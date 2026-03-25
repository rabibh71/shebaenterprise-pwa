import {
  insertHishabCloudEntry,
  updateHishabCloudEntry,
  deleteHishabCloudEntry
} from "./hishab-cloud.js";

const loggedInUser = JSON.parse(localStorage.getItem("loggedInUser") || "null");
const HISHAB_NS = String(
  loggedInUser?.username || loggedInUser?.email || "default_user"
).replace(/[.#$/\[\]]/g, "_");

const HISHAB_QUEUE_KEY = `sheba_hishab_sync_queue_${HISHAB_NS}`;

function readQueue() {
  try {
    const raw = localStorage.getItem(HISHAB_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  localStorage.setItem(
    HISHAB_QUEUE_KEY,
    JSON.stringify(Array.isArray(queue) ? queue : [])
  );
}

export function addHishabSyncTask(task) {
  const queue = readQueue();

  queue.push({
    id: `hishab_sync_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    ...task,
    created_at: new Date().toISOString()
  });

  writeQueue(queue);
}

export function getHishabQueueCount() {
  return readQueue().length;
}

export async function flushHishabQueue() {
  if (!navigator.onLine) return false;

  const queue = readQueue();
  if (!queue.length) return true;

  for (const task of queue) {
    if (task.action === "insert") {
      await insertHishabCloudEntry(task.payload);
    } else if (task.action === "update") {
      await updateHishabCloudEntry(task.entryId, task.payload);
    } else if (task.action === "delete") {
      await deleteHishabCloudEntry(task.entryId);
    }
  }

  writeQueue([]);
  return true;
}