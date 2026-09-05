// server.js
// Backend for the IGNOU Percentage Calculator.
//
// CONFIRMED from real portal screenshots (thank you for these — much better
// than my earlier guess):
//   1. Login/search form:  https://gradecard.ignou.ac.in/login.aspx
//      Fields: Category dropdown, Programme Code dropdown, Enrolment No.
//   2. Submitting takes you to a plain GET URL with query params:
//      https://gradecard.ignou.ac.in/view_gradecard.aspx?eno=<enrollment>&prog=<programCode>&type=<categoryType>
//      confirmed example: view_gradecard.aspx?eno=2251067639&prog=BCA&type=1
//
// That's actually simpler than a WebForms postback — no __VIEWSTATE needed
// for the result page. The 403 you hit was from using plain axios, which
// doesn't execute JS, hold a real browser session, or send the same
// fingerprint as Chrome — IGNOU's server (or a WAF in front of it) rejected
// it as a bot. This version uses Puppeteer (a real headless Chrome) instead,
// which should get past that.
//
// Still worth verifying yourself, since I still can't load the live site:
//  - `type=1` for the BCA/MCA/MP/MPB/PGDCA/MBA category is confirmed by your
//    screenshot. VERIFY the other 3 categories' `type` values by picking
//    each one on https://gradecard.ignou.ac.in/login.aspx and reading the
//    resulting URL — much easier now that it's a visible query param.
//  - `prog` is the exact Programme Code as the portal's own dropdown lists
//    it (e.g. "BCA") — pass it through as typed.

const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { calculatePercentage, CATEGORY_CONFIG } = require('./calc');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const LOGIN_URL = 'https://gradecard.ignou.ac.in/login.aspx';
const GRADECARD_BASE = 'https://gradecard.ignou.ac.in/view_gradecard.aspx';

// VERIFY the 3 values below (not "1") by checking the URL after picking each
// category on the login page — "1" is confirmed correct from your screenshot.
const CATEGORY_TYPE = {
  bca_mca_mp_mpb_pgdca_mba: '1', // confirmed: "For BCA/MCA/MCA_NEW/MP/MPB/PGDCA/..."
  bdp_ba_bcom_bsc_asso: '2', // VERIFY
  cbcs: '3', // VERIFY
  other: '4', // VERIFY
};

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Visit the login page first (to pick up any session cookie / pass any JS
 * challenge), then navigate directly to the known view_gradecard.aspx URL
 * pattern with a real Referer header, using a real headless browser.
 */
async function scrapeGradeCard({ categoryType, programCode, enrollment }) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 20000 });

    const targetUrl = `${GRADECARD_BASE}?eno=${encodeURIComponent(enrollment)}&prog=${encodeURIComponent(
      programCode
    )}&type=${encodeURIComponent(categoryType)}`;

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 20000,
      referer: LOGIN_URL,
    });

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

/**
 * Parse the result HTML into { name, enrollment, programCode, courses }.
 * Confirmed against a real screenshot of view_gradecard.aspx: the header row
 * reads "Enrolment No: ...   Name: ...   Programme Code: ..." as plain text,
 * and the table columns are exactly Course, Asgn1, LAB1, LAB2, LAB3, LAB4,
 * TERM END THEORY, TERM END PRACTICAL, STATUS — matching the sample PDF, so
 * the column-index parsing below should already be correct.
 */
function parseGradeCardHtml(html) {
  const $ = cheerio.load(html);
  const pageText = $('body').text().replace(/\s+/g, ' ');

  const nameMatch = pageText.match(/Name:\s*([A-Za-z .]+?)(?:\s+Programme Code:|\s+Enrolment|$)/);
  const enrolMatch = pageText.match(/Enrolment No:?\s*([0-9A-Za-z]+)/);
  const progMatch = pageText.match(/Programme Code:?\s*([A-Z0-9._]+)/);

  const name = nameMatch ? nameMatch[1].trim() : null;
  const enrollment = enrolMatch ? enrolMatch[1].trim() : null;
  const programCode = progMatch ? progMatch[1].trim() : null;

  const courses = [];
  $('table tr').each((i, row) => {
    const cells = $(row)
      .find('td')
      .map((_, td) => $(td).text().trim())
      .get();

    // Skip header rows / rows that don't look like course data
    if (cells.length < 7) return;
    const code = cells[0];
    if (!code || !/^[A-Z]{2,6}[0-9A-Z]{2,4}$/.test(code)) return;

    courses.push({
      code,
      asgn1: parseFloat(cells[1]) || 0,
      lab1: parseFloat(cells[2]) || 0,
      teeTheory: parseFloat(cells[6]) || 0,
      teePractical: parseFloat(cells[7]) || 0,
      status: cells[cells.length - 1],
    });
  });

  return { name, enrollment, programCode, courses };
}

app.get('/api/categories', (req, res) => {
  const categories = Object.entries(CATEGORY_CONFIG).map(([id, cfg]) => ({
    id,
    label: cfg.label,
  }));
  res.json({ categories });
});

app.post('/api/scrape', async (req, res) => {
  const { category, programCode, enrollment } = req.body || {};

  if (!category || !CATEGORY_TYPE[category]) {
    return res.status(400).json({ error: 'Unknown or missing category.' });
  }
  if (!programCode || !programCode.trim()) {
    return res.status(400).json({ error: 'Programme code is required (e.g. BCA).' });
  }
  if (!enrollment || !/^\d{9,10}$/.test(enrollment)) {
    return res.status(400).json({ error: 'Enrollment number must be 9-10 digits.' });
  }

  try {
    const resultHtml = await scrapeGradeCard({
      categoryType: CATEGORY_TYPE[category],
      programCode: programCode.trim().toUpperCase(),
      enrollment,
    });

    const parsed = parseGradeCardHtml(resultHtml);

    if (!parsed.courses.length) {
      // The portal recognised this enrolment number (it returned a name/
      // enrolment/programme code) but has no course rows for it yet — this
      // is a *valid* student who simply hasn't appeared for/been awarded any
      // exam result yet. That's a normal, expected state, not an error.
      const studentFound = Boolean(parsed.name || parsed.enrollment || parsed.programCode);

      if (studentFound) {
        return res.status(200).json({
          empty: true,
          name: parsed.name,
          enrollment: parsed.enrollment || enrollment,
          programCode: parsed.programCode || programCode,
          message:
            "We found this enrollment number, but there's no grade card data for it yet. This usually means the exam results haven't been declared yet, or you haven't appeared for any exam so far. Please check back later, or upload your grade card PDF once it's available.",
        });
      }

      // Nothing at all came back — this really does look like a wrong
      // category, programme code, or enrollment number.
      return res.status(404).json({
        error:
          "We couldn't find any student record for this enrollment number, programme code, and category combination. Please double-check your details and try again.",
      });
    }

    const result = calculatePercentage(category, parsed.courses);

    res.json({
      name: parsed.name,
      enrollment: parsed.enrollment || enrollment,
      programCode: parsed.programCode || programCode,
      ...result,
    });
  } catch (err) {
    console.error('Scrape failed:', err.message);
    res.status(502).json({
      error:
        'Could not fetch or parse the IGNOU grade card. This may be due to a temporary issue with the IGNOU portal or an invalid input. Please verify your inputs and try again later.',
      detail: err.message,
    });
  }
});

// Manual entry / PDF-parsed entry — same calculation engine, no scraping.
app.post('/api/calculate', (req, res) => {
  const { category, courses } = req.body || {};
  if (!category || !CATEGORY_CONFIG[category]) {
    return res.status(400).json({ error: 'Unknown or missing category.' });
  }
  if (!Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: 'courses must be a non-empty array.' });
  }
  const result = calculatePercentage(category, courses);
  res.json(result);
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`IGNOU Percentage Calculator backend running on port ${PORT}`);
});
