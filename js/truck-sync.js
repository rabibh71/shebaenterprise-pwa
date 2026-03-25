import { getSyncQueue, removeSyncTask, isAppOnline } from "./offline-queue.js";
import { saveTruckCloudData } from "./truck-cloud.js";

export async function flushTruckQueue() {
  if (!isAppOnline()) return;

  const queue = getSyncQueue();
  const truckTasks = queue.filter(
    (item) => item.module === "truck" && item.action === "save_full_state"
  );

  if (!truckTasks.length) return;

  const latestTask = truckTasks[truckTasks.length - 1];

  try {
    await saveTruckCloudData(latestTask.payload);

    for (const task of truckTasks) {
      removeSyncTask(task.id);
    }
  } catch (err) {
    console.error("Truck sync failed:", err);
  }
}