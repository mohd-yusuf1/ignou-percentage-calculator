# IGNOU Percentage Calculator

A small full-stack tool: fetch an IGNOU grade card by enrollment number (scraped
from the official portal), or enter marks manually, or upload the grade card
PDF — and get a weighted overall percentage using IGNOU's real 30% Continuous
Assessment + 70% Term-End formula.

```
ignou-calc/
├── backend/       Node/Express API: scraping + calculation
│   ├── server.js
│   ├── calc.js
│   └── package.json
└── frontend/      Static site: index.html, style.css, script.js
```

---

## ⚠️ Before you deploy: one thing still needs verification

Confirmed against real screenshots of the portal:
- Search form: `https://gradecard.ignou.ac.in/login.aspx` (Category,
  Programme Code, Enrolment No.)
- Result page is a plain GET:
  `https://gradecard.ignou.ac.in/view_gradecard.aspx?eno=<enrollment>&prog=<programCode>&type=<categoryType>`
- The BCA/MCA/MP/MPB/PGDCA/MBA category is confirmed `type=1`.
- The result table's columns (Course, Asgn1, LAB1–4, Term End Theory, Term
  End Practical, Status) match exactly what the calculator expects.

**What's still unverified:** the `type=` value for the other 3 categories
(BDP/BA/BCom/BSc/ASSO, CBCS, Other). To fill these in:

1. Open `https://gradecard.ignou.ac.in/login.aspx`.
2. Pick each category in turn, fill in any programme code + enrollment
   number, click Search.
3. Read the `type=` number in the resulting URL's address bar.
4. Put it in `CATEGORY_TYPE` in `backend/server.js` (marked `// VERIFY`).

That's it — no DevTools/Network tab needed this time, it's just visible in
the URL bar.

**About the 403 you hit:** that was from the first version using plain
`axios`, which doesn't run JavaScript or present a real browser fingerprint —
IGNOU's server (or a WAF in front of it) rejected it as a bot. This version
uses **Puppeteer** (a real headless Chrome browser) instead, which should get
past that. If you still get blocked after this change, it likely means
IGNOU is blocking your *hosting provider's* IP range specifically (common
for Indian government sites, which often blacklist AWS/GCP/Render/Railway
datacenter IPs wholesale) — in that case, try running the backend on a home
or campus network instead of a cloud host, since those IPs usually aren't on
any blocklist.

If the portal ever shows a CAPTCHA, server-side scraping isn't possible for
that form at all — you'd fall back to the PDF upload or manual entry paths,
both of which are already built and don't depend on this.

---

## Running locally

**Backend**
```bash
cd backend
npm install         # this also downloads a bundled Chromium for Puppeteer,
                     # so it's a bigger install (~300MB) and takes a minute
npm start           # runs on http://localhost:3001
```

**Frontend**
Just open `frontend/index.html` in a browser (or serve it with any static
server, e.g. `npx serve frontend`). It's already pointed at
`http://localhost:3001` in `frontend/config.js`.

Test the manual-entry and PDF-upload flows first — they don't depend on the
scraper at all, and you can sanity-check them against your own grade card
immediately. The scrape flow needs step "Before you deploy" done first.

---

## Deploying

**Backend** (needs a real server, not static hosting, since it makes outbound
requests to IGNOU):
- [Render](https://render.com), [Railway](https://railway.app), or
  [Fly.io](https://fly.io) all have free/cheap tiers that work well for a
  small Express app. Connect your repo, set the root directory to `backend/`,
  build command `npm install`, start command `npm start`.

**Frontend** (static hosting):
- [Netlify](https://netlify.com), [Vercel](https://vercel.com), or GitHub
  Pages. Point it at the `frontend/` folder.
- After deploying the backend, update `frontend/config.js` with your real
  backend URL, e.g.:
  ```js
  window.API_BASE_URL = "https://your-backend.onrender.com";
  ```

**CORS**: the backend already has `cors()` enabled for all origins to keep
setup simple. If you want to lock it down to just your deployed frontend
domain, change `app.use(cors())` in `server.js` to
`app.use(cors({ origin: "https://your-frontend-domain.com" }))`.

---

## How the percentage is calculated

Every course is classified as **theory**, **practical**, or **project** based
on which marks are populated (mirrors your actual grade card's columns), then
scored as:

```
Course % = (Continuous Assessment × 0.30) + (Term-End × 0.70)
```

- Theory courses: Continuous = Assignment 1, Term-End = Term-End Theory
- Lab/practical courses: Continuous = Assignment 1 (lab record), Term-End = Term-End Practical
- Project courses (e.g. BCSP064): Continuous = Lab1, Term-End = Term-End Practical

The overall percentage is the simple average of all completed courses' weighted
percentages (each course counted equally out of 100). This matches IGNOU's
published university-wide rule — see `backend/calc.js` for the full logic and
comments, including where to adjust if a specific program's rule differs.

This is an **unofficial, estimate tool** — it is not affiliated with IGNOU,
and results should always be checked against the official grade card / final
marksheet.
