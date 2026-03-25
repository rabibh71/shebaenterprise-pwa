import { supabase } from "./supabase-client.js";
import { getCurrentUser } from "./supabase-auth.js";

function emptyGarageData() {
  return {
    cars: [],
    income: [],
    expense: [],
    employees: [],
    attendance: []
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

export function getEmptyGarageData() {
  return emptyGarageData();
}

export async function loadGarageCloudData() {
  const userId = await getUserId();

  const { data, error } = await supabase
    .from("garage_module_data")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return emptyGarageData();
  }

  return {
    cars: Array.isArray(data.cars) ? data.cars : [],
    income: Array.isArray(data.income) ? data.income : [],
    expense: Array.isArray(data.expense) ? data.expense : [],
    employees: Array.isArray(data.employees) ? data.employees : [],
    attendance: Array.isArray(data.attendance) ? data.attendance : []
  };
}

export async function saveGarageCloudData(payload) {
  const userId = await getUserId();

  const row = {
    user_id: userId,
    cars: Array.isArray(payload.cars) ? payload.cars : [],
    income: Array.isArray(payload.income) ? payload.income : [],
    expense: Array.isArray(payload.expense) ? payload.expense : [],
    employees: Array.isArray(payload.employees) ? payload.employees : [],
    attendance: Array.isArray(payload.attendance) ? payload.attendance : [],
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("garage_module_data")
    .upsert(row, { onConflict: "user_id" });

  if (error) throw error;

  return true;
}