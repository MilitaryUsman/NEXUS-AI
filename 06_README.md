# NEXUS Advanced — Complete Setup Guide
## AI-Powered E-Commerce Recommender with Supabase

---

## FILE STRUCTURE
```
nexus-advanced/
├── 01_schema.sql          ← Run this in Supabase SQL Editor FIRST
├── 02_supabase.js         ← Supabase client, auth, tracking helpers
├── 03_recommender.js      ← A/B testing + Claude + collaborative filtering
├── 04_analytics_dashboard.html  ← Live analytics dashboard
├── 05_nexus_app.html      ← Main app (all features wired)
└── 06_README.md           ← This file
```

---

## STEP 1 — Create Supabase Project
1. Go to https://app.supabase.com → New Project
2. Choose a region close to your users (e.g., ap-south-1 for India)
3. Save your **Project URL** and **anon public key**

---

## STEP 2 — Run the Schema
1. Supabase Dashboard → **SQL Editor** → New Query
2. Paste the entire contents of `01_schema.sql`
3. Click **Run** — all tables, indexes, RLS policies, and functions are created

---

## STEP 3 — Add Your Keys
Replace `YOUR_PROJECT` and `YOUR_ANON_KEY` in:
- `04_analytics_dashboard.html` (lines 7-8 in the script block)
- `05_nexus_app.html` (lines 6-7 in the script block)
- `02_supabase.js` (lines 11-12)

```js
const SUPABASE_URL  = 'https://xyzabcdef.supabase.co';   // ← your URL
const SUPABASE_ANON = 'eyJhbGci...';                      // ← your anon key
```

---

## STEP 4 — Enable Auth
1. Supabase Dashboard → **Authentication** → **Providers**
2. Enable **Email** provider (already on by default)
3. Optional: enable Google, GitHub OAuth for social login

---

## STEP 5 — Deploy the App
### Option A — Netlify (Recommended, Free)
1. Go to https://app.netlify.com/drop
2. Drag the entire `nexus-advanced/` folder
3. Done — live URL in 30 seconds

### Option B — Vercel
```bash
npm install -g vercel
cd nexus-advanced
vercel deploy
```

### Option C — Local development
```bash
# Any static server works
npx serve .
# OR
python3 -m http.server 3000
```

---

## STEP 6 — Add Product Embeddings (Vector Search)
To enable semantic vector search in `03_recommender.js`:

```bash
# Install OpenAI SDK
npm install openai
```

```js
// In 03_recommender.js, replace getEmbedding():
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: 'sk-...' });

async function getEmbedding(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}
```

Then seed embeddings for all products:
```js
// Run once to generate and store embeddings
for (const product of PRODS) {
  const embedding = await getEmbedding(
    `${product.name} ${product.description} ${product.tags.join(' ')}`
  );
  await supabase.from('products').update({ embedding }).eq('id', product.id);
}
```

---

## FEATURE SUMMARY

| Feature | File | Status |
|---|---|---|
| Supabase Schema (all tables) | 01_schema.sql | ✅ Complete |
| Auth (sign up / sign in) | 05_nexus_app.html | ✅ Complete |
| Behavioural Signal Tracking | 02_supabase.js | ✅ Complete |
| Collaborative Filtering (A/B control) | 03_recommender.js | ✅ Complete |
| Claude AI Recommendations (A/B treatment) | 03_recommender.js | ✅ Complete |
| A/B Test Logging | 02_supabase.js | ✅ Complete |
| Analytics Dashboard | 04_analytics_dashboard.html | ✅ Complete |
| Multi-modal Image Search (Claude Vision) | 05_nexus_app.html | ✅ Complete |
| Cart + Wishlist persistence | 05_nexus_app.html | ✅ Complete |
| Order tracking | 02_supabase.js | ✅ Complete |
| Vector Search | 03_recommender.js | ⚙️ Add your embedding API key |
| Mobile App (React Native) | — | Future scope |
| Payment Gateway | — | Add Razorpay/Stripe |

---

## HOW A/B TESTING WORKS
- Every new user is **deterministically assigned** control or treatment on signup
- **Control** → Collaborative filtering (co-view/co-purchase matrix from DB)
- **Treatment** → Claude semantic AI recommendation
- Every recommendation is logged in `recommendation_logs` with CTR
- Analytics dashboard shows live comparison of both variants

---

## HOW MULTI-MODAL IMAGE SEARCH WORKS
1. User clicks "Upload image" on any product detail page
2. Image is sent to Claude API with vision capability enabled
3. Claude identifies the product and matches it against the catalogue
4. Returns similar product IDs + explanation, rendered as product cards

---

## ENVIRONMENT VARIABLES (for production)
```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...  (only needed for vector search)
```

---

## QUICK START CHECKLIST
- [ ] Created Supabase project
- [ ] Ran 01_schema.sql in SQL Editor
- [ ] Added Supabase URL + anon key to HTML files
- [ ] Deployed to Netlify/Vercel
- [ ] Opened analytics dashboard (04_analytics_dashboard.html)
- [ ] Signed up as a user and browsed products
- [ ] Checked recommendation_logs table in Supabase

---

Built with Claude AI ✦ | Military Mohammad Usman E Gani | 3VC22CD032 | SuprMentr Technologies
