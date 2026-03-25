import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

function emptyHishabData() {
  return {
    entries: []
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

export function getEmptyHishabData() {
  return emptyHishabData();
}

export async function loadHishabCloudData() {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("hisab_entries")
    .select("*")
    .eq("user_id", userId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw error;

  return {
    entries: Array.isArray(data) ? data : []
  };
}

export async function insertHishabCloudEntry(row) {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("hisab_entries")
    .insert([
      {
        user_id: userId,
        ...row
      }
    ])
    .select()
    .single();

  if (error) throw error;

  return data;
}

export async function updateHishabCloudEntry(entryId, row) {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("hisab_entries")
    .update(row)
    .eq("id", entryId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw error;

  return data;
}

export async function deleteHishabCloudEntry(entryId) {
  const userId = await getUserId();

  const { error } = await supabase
    .from("hisab_entries")
    .delete()
    .eq("id", entryId)
    .eq("user_id", userId);

  if (error) throw error;

  return true;
}