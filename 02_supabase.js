// ── 02_supabase.js ────────────────────────────────────────
// Drop this file into your project root.
// Import it everywhere: import { supabase, getProfile, trackEvent } from './02_supabase.js'
// ─────────────────────────────────────────────────────────

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// ── FILL THESE IN FROM: Supabase Dashboard → Settings → API ──
const SUPABASE_URL  = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON = 'YOUR_ANON_KEY';
// ─────────────────────────────────────────────────────────────

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── SESSION ID (persists per tab) ─────────────────────────
export function getSessionId() {
  if (!sessionStorage.getItem('nexus_sid')) {
    sessionStorage.setItem('nexus_sid', crypto.randomUUID());
  }
  return sessionStorage.getItem('nexus_sid');
}

// ── AUTH HELPERS ──────────────────────────────────────────
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// ── USER PROFILE ──────────────────────────────────────────
export async function getProfile() {
  const user = await getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  return data;
}

export async function updateProfile(updates) {
  const user = await getUser();
  if (!user) return;
  await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, ...updates, updated_at: new Date().toISOString() });
}

// ── BEHAVIOURAL EVENT TRACKING ────────────────────────────
// weights map
const WEIGHTS = {
  view: 1.0, dwell_30s: 2.0, scroll_reviews: 1.5,
  add_cart: 4.0, add_wish: 3.0, search: 1.0,
  filter_use: 1.5, purchase: 10.0, quick_exit: -0.5
};

export async function trackEvent(productId, eventType, meta = {}) {
  const user   = await getUser();
  const sid    = getSessionId();
  const row = {
    session_id: sid,
    product_id: productId || null,
    event_type: eventType,
    metadata:   meta,
    ab_variant: meta.ab_variant || null,
  };
  if (user) row.user_id = user.id;
  await supabase.from('user_events').insert(row);
}

// ── PROFILE AGGREGATION (run after each session) ──────────
export async function aggregateProfile() {
  const user = await getUser();
  if (!user) return;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: events } = await supabase
    .from('user_events')
    .select('event_type, product_id, products(category, brand, price)')
    .eq('user_id', user.id)
    .gte('created_at', since);

  if (!events?.length) return;

  const catW = {}, brandW = [], prices = [];
  for (const e of events) {
    const w = WEIGHTS[e.event_type] ?? 0;
    const p = e.products;
    if (!p) continue;
    catW[p.category] = (catW[p.category] ?? 0) + w;
    if (w > 0) { brandW.push({ brand: p.brand, w }); prices.push(p.price); }
  }

  const preferred_categories = Object.entries(catW)
    .sort(([,a],[,b]) => b - a).slice(0, 3).map(([c]) => c);
  const preferred_brands = [...new Map(brandW.map(x => [x.brand, x]))
    .values()].sort((a,b) => b.w - a.w).slice(0, 3).map(x => x.brand);

  const avg = prices.length ? prices.reduce((a,b) => a+b, 0) / prices.length : 0;
  const price_sensitivity = avg < 100 ? 'budget' : avg < 400 ? 'mid' : 'premium';

  await updateProfile({ preferred_categories, preferred_brands, price_sensitivity });
}

// ── WISHLIST ──────────────────────────────────────────────
export async function addWishlist(productId) {
  const user = await getUser();
  if (!user) return;
  await supabase.from('wishlists').upsert({ user_id: user.id, product_id: productId });
}
export async function removeWishlist(productId) {
  const user = await getUser();
  if (!user) return;
  await supabase.from('wishlists').delete()
    .eq('user_id', user.id).eq('product_id', productId);
}
export async function getWishlist() {
  const user = await getUser();
  if (!user) return [];
  const { data } = await supabase.from('wishlists')
    .select('product_id').eq('user_id', user.id);
  return data?.map(r => r.product_id) ?? [];
}

// ── CART ──────────────────────────────────────────────────
export async function syncCart(cartItems) {
  // cartItems = [{id, qty}]
  const user = await getUser();
  if (!user) return;
  await supabase.from('carts').delete().eq('user_id', user.id);
  if (cartItems.length) {
    await supabase.from('carts').insert(
      cartItems.map(i => ({ user_id: user.id, product_id: i.id, qty: i.qty }))
    );
  }
}
export async function loadCart() {
  const user = await getUser();
  if (!user) return [];
  const { data } = await supabase.from('carts')
    .select('product_id, qty').eq('user_id', user.id);
  return data ?? [];
}

// ── PLACE ORDER ───────────────────────────────────────────
export async function placeOrder(cartItems, total, abVariant) {
  const user = await getUser();
  if (!user) return;
  await supabase.from('orders').insert({
    user_id:    user.id,
    session_id: getSessionId(),
    ab_variant: abVariant,
    items:      cartItems,
    total,
  });
  await supabase.from('carts').delete().eq('user_id', user.id);
  for (const item of cartItems) {
    await trackEvent(item.id, 'purchase', { ab_variant: abVariant });
  }
  await aggregateProfile();
}
