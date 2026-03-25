import { getCurrentUser } from "./supabase-auth.js";

export async function requireLogin() {
  const { user } = await getCurrentUser();

  if (!user) {
    window.location.href = "index.html";
    return null;
  }

  return user;
}