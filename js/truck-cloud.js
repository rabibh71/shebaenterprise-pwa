import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

function emptyTruckData() {
  return {
    trucks: []
  };
}

async function getUserId() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }

  return user.id;
}

export function getEmptyTruckData() {
  return emptyTruckData();
}

export async function loadTruckCloudData() {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("truck_module_data")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return emptyTruckData();
  }

  return {
    trucks: Array.isArray(data.trucks) ? data.trucks : []
  };
}

export async function saveTruckCloudData(payload) {
  const userId = await getUserId();

  const row = {
    user_id: userId,
    trucks: Array.isArray(payload.trucks) ? payload.trucks : [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("truck_module_data")
    .upsert(row, { onConflict: "user_id" });

  if (error) throw error;

  return true;
}