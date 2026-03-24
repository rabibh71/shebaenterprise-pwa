import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

function emptyNotesData() {
  return {
    notes: []
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

export function getEmptyNotesData() {
  return emptyNotesData();
}

export async function loadNotesCloudData() {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("notes_module_data")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return emptyNotesData();
  }

  return {
    notes: Array.isArray(data.notes) ? data.notes : []
  };
}

export async function saveNotesCloudData(payload) {
  const userId = await getUserId();

  const row = {
    user_id: userId,
    notes: Array.isArray(payload.notes) ? payload.notes : [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("notes_module_data")
    .upsert(row, { onConflict: "user_id" });

  if (error) throw error;

  return true;
}