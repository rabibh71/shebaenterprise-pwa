const QUEUE_KEY = "sheba_sync_queue_v1";

function makeId() {
  return "q_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function isAppOnline() {
  return navigator.onLine;
}

export function getSyncQueue() {
  return readQueue();
}

export function addSyncTask(task) {
  const queue = readQueue();

  queue.push({
    id: makeId(),
    createdAt: new Date().toISOString(),
    ...task
  });

  writeQueue(queue);
  return queue;
}

export function removeSyncTask(taskId) {
  const queue = readQueue().filter((item) => item.id !== taskId);
  writeQueue(queue);
  return queue;
}

export function clearSyncQueue() {
  writeQueue([]);
}

export function replaceSyncQueue(queue) {
  writeQueue(Array.isArray(queue) ? queue : []);
}