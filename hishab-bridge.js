import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

async function getUserId() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    throw new Error("User not logged in");
  }

  return user.id;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizePayload(payload = {}) {
  return {
    module_name: String(payload.module_name || "").trim(),
    entry_type: payload.entry_type === "expense" ? "expense" : "income",
    source_table: String(payload.source_table || "").trim(),
    source_id: String(payload.source_id || "").trim(),
    entry_date: payload.entry_date || new Date().toISOString().slice(0, 10),
    party_name: String(payload.party_name || "").trim(),
    category: String(payload.category || "").trim(),
    total_amount: num(payload.total_amount),
    paid_amount: num(payload.paid_amount),
    due_amount: num(payload.due_amount),
    payment_method: String(payload.payment_method || "Cash").trim(),
    note: String(payload.note || "").trim(),
    updated_at: new Date().toISOString()
  };
}

export async function upsertHishabSyncEntry(payload) {
  const userId = await getUserId();
  const row = normalizePayload(payload);

  if (!row.source_table || !row.source_id) {
    throw new Error("source_table and source_id are required");
  }

  const { error } = await supabase
    .from("hisab_entries")
    .upsert(
      {
        user_id: userId,
        ...row
      },
      {
        onConflict: "user_id,source_table,source_id"
      }
    );

  if (error) {
    console.error("upsertHishabSyncEntry failed:", error);
    throw error;
  }

  return true;
}

export async function deleteHishabSyncEntry(sourceTable, sourceId) {
  const userId = await getUserId();

  const { error } = await supabase
    .from("hisab_entries")
    .delete()
    .eq("user_id", userId)
    .eq("source_table", String(sourceTable || "").trim())
    .eq("source_id", String(sourceId || "").trim());

  if (error) {
    console.error("deleteHishabSyncEntry failed:", error);
    throw error;
  }

  return true;
}