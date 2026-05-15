// ── 03_recommender.js ─────────────────────────────────────
// Hybrid recommendation engine:
//   control   → collaborative filtering (co-purchase matrix)
//   treatment → Claude API semantic recommendation
// Import: import { getRecommendations, logRecommendation } from './03_recommender.js'
// ─────────────────────────────────────────────────────────

import { supabase, getUser, getSessionId, getProfile } from './02_supabase.js';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ── A/B VARIANT ───────────────────────────────────────────
// Deterministic: same user always gets same variant
export function getABVariant(userId) {
  if (!userId) return 'control';
  const hash = userId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return hash % 2 === 0 ? 'control' : 'treatment';
}

// ── COLLABORATIVE FILTERING (control group) ───────────────
// Builds a simple co-purchase/co-view matrix from DB events
export async function getCollaborativeRecs(viewedIds, allProducts, limit = 6) {
  if (!viewedIds.length) return [];

  // Fetch sessions that viewed the same products
  const { data: coSessions } = await supabase
    .from('user_events')
    .select('session_id')
    .in('product_id', viewedIds)
    .in('event_type', ['view', 'add_cart', 'purchase']);

  if (!coSessions?.length) return fallbackRecs(allProducts, viewedIds, limit);

  const sessionIds = [...new Set(coSessions.map(r => r.session_id))];

  // Fetch what else those sessions viewed
  const { data: coViews } = await supabase
    .from('user_events')
    .select('product_id, event_type')
    .in('session_id', sessionIds)
    .not('product_id', 'in', `(${viewedIds.join(',')})`)
    .limit(200);

  if (!coViews?.length) return fallbackRecs(allProducts, viewedIds, limit);

  // Score by event type weight
  const WEIGHTS = { view: 1, add_cart: 4, purchase: 10 };
  const scores = {};
  for (const r of coViews) {
    scores[r.product_id] = (scores[r.product_id] ?? 0) + (WEIGHTS[r.event_type] ?? 0);
  }

  const topIds = Object.entries(scores)
    .sort(([,a],[,b]) => b - a)
    .slice(0, limit)
    .map(([id]) => id);

  return allProducts
    .filter(p => topIds.includes(p.id))
    .map(p => ({ ...p, reason: 'Popular with similar shoppers' }));
}

// ── CLAUDE SEMANTIC RECOMMENDATION (treatment group) ──────
export async function getClaudeRecs(viewedProducts, allProducts, profile, limit = 6) {
  const context = profile
    ? `User prefers: ${profile.preferred_categories?.join(', ')}. Price sensitivity: ${profile.price_sensitivity}.`
    : '';

  const prompt = `${context}
User viewed: ${viewedProducts.map(p => `${p.name} (${p.category})`).join(', ')}.
Catalogue: ${allProducts.map(p => `ID:${p.id} "${p.name}" by ${p.brand} Rs.${p.price} ${p.category} tags:${p.tags?.join(',')}`).join(' | ')}
Return ONLY valid JSON array of ${limit} objects. Format: [{"id":"uuid","reason":"8-10 word personalised reason"}]
Never recommend already-viewed products. Prioritise by intent match then price range.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 800,
        system: 'You are a recommendation engine. Return ONLY valid JSON array, nothing else.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    const picks = JSON.parse(data.content?.[0]?.text ?? '[]');
    return picks
      .map(pick => {
        const prod = allProducts.find(p => p.id === pick.id);
        return prod ? { ...prod, reason: pick.reason } : null;
      })
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return fallbackRecs(allProducts, viewedProducts.map(p => p.id), limit);
  }
}

// ── VECTOR SEMANTIC SEARCH (requires embeddings in DB) ────
export async function vectorSearch(queryText, limit = 8) {
  // Step 1: get embedding for query from your embedding API
  // (Using OpenAI text-embedding-3-small or Cohere)
  // For demo, fall back to keyword search if no embedding API
  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: await getEmbedding(queryText),
    match_threshold: 0.65,
    match_count: limit
  });
  if (error || !data?.length) return null;
  return data;
}

async function getEmbedding(text) {
  // Replace with your embedding API call
  // Example using OpenAI:
  // const res = await fetch('https://api.openai.com/v1/embeddings', {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  // });
  // const d = await res.json();
  // return d.data[0].embedding;
  throw new Error('Configure your embedding API in 03_recommender.js → getEmbedding()');
}

// ── MAIN ENTRY POINT ──────────────────────────────────────
export async function getRecommendations(viewedProducts, allProducts) {
  const user    = await getUser();
  const profile = await getProfile();
  const variant = user ? getABVariant(user.id) : 'control';
  const viewedIds = viewedProducts.map(p => p.id);

  let recs;
  if (variant === 'treatment') {
    recs = await getClaudeRecs(viewedProducts, allProducts, profile);
  } else {
    recs = await getCollaborativeRecs(viewedIds, allProducts);
  }

  // Log for A/B analysis
  await logRecommendation(recs.map(r => r.id), variant, variant === 'treatment' ? 'claude' : 'collaborative');

  return { recs, variant };
}

// ── RECOMMENDATION LOG ────────────────────────────────────
export async function logRecommendation(recommendedIds, variant, strategy) {
  const user = await getUser();
  if (!user) return;
  await supabase.from('recommendation_logs').insert({
    user_id: user.id,
    session_id: getSessionId(),
    ab_variant: variant,
    strategy,
    recommended_ids: recommendedIds,
    clicked_ids: [],
    purchased_ids: []
  });
}

export async function logRecommendationClick(productId) {
  const user = await getUser();
  if (!user) return;
  // Append clicked product to most recent log for this session
  const { data } = await supabase
    .from('recommendation_logs')
    .select('id, clicked_ids')
    .eq('user_id', user.id)
    .eq('session_id', getSessionId())
    .order('shown_at', { ascending: false })
    .limit(1)
    .single();
  if (!data) return;
  const clicked = [...(data.clicked_ids ?? []), productId];
  const total   = data.clicked_ids?.length + 1 || 1;
  await supabase.from('recommendation_logs').update({
    clicked_ids: clicked,
    ctr: total / (data.recommended_ids?.length ?? 6)
  }).eq('id', data.id);
}

// ── FALLBACK ──────────────────────────────────────────────
function fallbackRecs(allProducts, excludeIds, limit) {
  return allProducts
    .filter(p => !excludeIds.includes(p.id) && p.rating >= 4.5)
    .sort(() => Math.random() - 0.5)
    .slice(0, limit)
    .map(p => ({ ...p, reason: 'Top rated in this category' }));
}
