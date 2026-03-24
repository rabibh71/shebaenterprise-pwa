import { getSyncQueue, removeSyncTask, isAppOnline } from "./offline-queue.js";
import { saveGarageCloudData } from "./garage-cloud.js";

export async function flushGarageQueue() {
  if (!isAppOnline()) return;

  const queue = getSyncQueue();
  const garageTasks = queue.filter(
    (item) => item.module === "garage" && item.action === "save_full_state"
  );

  for (const task of garageTasks) {
    try {
      await saveGarageCloudData(task.payload);
      removeSyncTask(task.id);
    } catch (err) {
      console.error("Garage sync failed:", err);
      break;
    }
  }
}