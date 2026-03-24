import { supabase } from "./supabase-client.js";

async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    throw new Error("User not logged in");
  }
  return data.user.id;
}

export async function insertUserRow(tableName, payload) {
  const userId = await getUserId();

  return await supabase
    .from(tableName)
    .insert([
      {
        ...payload,
        user_id: userId
      }
    ])
    .select()
    .single();
}

export async function getUserRows(tableName) {
  const userId = await getUserId();

  return await supabase
    .from(tableName)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
}

export async function updateUserRow(tableName, rowId, payload) {
  const userId = await getUserId();

  return await supabase
    .from(tableName)
    .update({
      ...payload,
      updated_at: new Date().toISOString()
    })
    .eq("id", rowId)
    .eq("user_id", userId)
    .select()
    .single();
}

export async function deleteUserRow(tableName, rowId) {
  const userId = await getUserId();

  return await supabase
    .from(tableName)
    .delete()
    .eq("id", rowId)
    .eq("user_id", userId);
}