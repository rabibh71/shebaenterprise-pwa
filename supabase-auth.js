import { supabase } from "./supabase-client.js";

export async function signUpUser(email, password) {
  return await supabase.auth.signUp({
    email,
    password
  });
}

export async function signInUser(email, password) {
  return await supabase.auth.signInWithPassword({
    email,
    password
  });
}

export async function signOutUser() {
  return await supabase.auth.signOut();
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  return { user: data?.user || null, error };
}

export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  return { session: data?.session || null, error };
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
}