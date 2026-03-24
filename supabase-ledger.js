import { supabase } from "./supabase-client.js";

async function getUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    throw new Error("User not logged in");
  }
  return data.user.id;
}

export async function addHisabEntry({
  moduleName = "manual",
  entryType = "income",
  sourceTable = "",
  sourceId = "",
  entryDate = new Date().toISOString().slice(0, 10),
  partyName = "",
  category = "",
  totalAmount = 0,
  paidAmount = 0,
  dueAmount = 0,
  note = ""
}) {
  const userId = await getUserId();

  return await supabase
    .from("hisab_entries")
    .insert([
      {
        user_id: userId,
        module_name: moduleName,
        entry_type: entryType,
        source_table: sourceTable,
        source_id: sourceId,
        entry_date: entryDate,
        party_name: partyName,
        category,
        total_amount: Number(totalAmount || 0),
        paid_amount: Number(paidAmount || 0),
        due_amount: Number(dueAmount || 0),
        note
      }
    ])
    .select()
    .single();
}

export async function getHisabEntries() {
  const userId = await getUserId();

  return await supabase
    .from("hisab_entries")
    .select("*")
    .eq("user_id", userId)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });
}

export async function updateHisabEntryBySource(sourceTable, sourceId, payload = {}) {
  const userId = await getUserId();

  return await supabase
    .from("hisab_entries")
    .update({
      ...payload,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", userId)
    .eq("source_table", sourceTable)
    .eq("source_id", sourceId)
    .select();
}

export async function deleteHisabEntryBySource(sourceTable, sourceId) {
  const userId = await getUserId();

  return await supabase
    .from("hisab_entries")
    .delete()
    .eq("user_id", userId)
    .eq("source_table", sourceTable)
    .eq("source_id", sourceId);
}