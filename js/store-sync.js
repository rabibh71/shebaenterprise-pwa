import { getSyncQueue, removeSyncTask, isAppOnline } from "./offline-queue.js";
import { saveStoreCloudData } from "./store-cloud.js";

export async function flushStoreQueue() {
  if (!isAppOnline()) return;

  const queue = getSyncQueue();
  const storeTasks = queue.filter(
    (item) => item.module === "store" && item.action === "save_full_state"
  );

  for (const task of storeTasks) {
    try {
      await saveStoreCloudData(task.payload);
      removeSyncTask(task.id);
    } catch (err) {
      console.error("Store sync failed:", err);
      break;
    }
  }
}