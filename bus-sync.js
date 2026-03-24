import { getSyncQueue, removeSyncTask, isAppOnline } from "./offline-queue.js";
import { saveBusCloudData } from "./bus-cloud.js";

export async function flushBusQueue() {
  if (!isAppOnline()) return;

  const queue = getSyncQueue();
  const busTasks = queue.filter(
    (item) => item.module === "bus" && item.action === "save_full_state"
  );

  for (const task of busTasks) {
    try {
      await saveBusCloudData(task.payload);
      removeSyncTask(task.id);
    } catch (err) {
      console.error("Bus sync failed:", err);
      break;
    }
  }
}