import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

function emptyBusData() {
  return {
    buses: []
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

export function getEmptyBusData() {
  return emptyBusData();
}

export async function loadBusCloudData() {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("bus_module_data")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return emptyBusData();
  }

  return {
    buses: Array.isArray(data.buses) ? data.buses : []
  };
}

export async function saveBusCloudData(payload) {
  const userId = await getUserId();

  const row = {
    user_id: userId,
    buses: Array.isArray(payload.buses) ? payload.buses : [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("bus_module_data")
    .upsert(row, { onConflict: "user_id" });

  if (error) throw error;

  return true;
}