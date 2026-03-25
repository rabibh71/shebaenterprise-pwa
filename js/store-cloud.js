import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

function emptyStoreData() {
  return {
    products: [],
    salesDocs: [],
    purchaseDocs: [],
    stockMoves: [],
    activities: [],
    returns: []
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

export function getEmptyStoreData() {
  return emptyStoreData();
}

export async function loadStoreCloudData() {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("store_module_data")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return emptyStoreData();
  }

  return {
    products: Array.isArray(data.products) ? data.products : [],
    salesDocs: Array.isArray(data.sales_docs) ? data.sales_docs : [],
    purchaseDocs: Array.isArray(data.purchase_docs) ? data.purchase_docs : [],
    stockMoves: Array.isArray(data.stock_moves) ? data.stock_moves : [],
    activities: Array.isArray(data.activities) ? data.activities : [],
    returns: Array.isArray(data.returns_data) ? data.returns_data : []
  };
}

export async function saveStoreCloudData(payload) {
  const userId = await getUserId();

  const row = {
    user_id: userId,
    products: Array.isArray(payload.products) ? payload.products : [],
    sales_docs: Array.isArray(payload.salesDocs) ? payload.salesDocs : [],
    purchase_docs: Array.isArray(payload.purchaseDocs) ? payload.purchaseDocs : [],
    stock_moves: Array.isArray(payload.stockMoves) ? payload.stockMoves : [],
    activities: Array.isArray(payload.activities) ? payload.activities : [],
    returns_data: Array.isArray(payload.returns) ? payload.returns : [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("store_module_data")
    .upsert(row, { onConflict: "user_id" });

  if (error) throw error;

  return true;
}