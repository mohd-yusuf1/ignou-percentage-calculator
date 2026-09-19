const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const multer = require('multer'); // For handling file uploads in mobile app
// const pdfParse = require('pdf-parse'); // For parsing PDF files in mobile app
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { calculatePercentage, calculateCGPA, CATEGORY_CONFIG } = require('./calc');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

const PORT = process.env.PORT || 3001;

const LOGIN_URL = 'https://gradecard.ignou.ac.in/login.aspx';
const GRADECARD_BASE = 'https://gradecard.ignou.ac.in/view_gradecard.aspx';

const CATEGORY_TYPE = {
  bca_mca_mp_mpb_pgdca_mba: '1',
  bdp_ba_bcom_bsc_asso: '2',
  cbcs: '3',
  other: '4',
};

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// For mobile app PDF parsing: regex to extract course rows from the text dump of a grade card PDF.
const COURSE_ROW_RE =
  /([A-Z]{2,8}\d{2,4}[A-Z]?)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d-]+)\s+([\d-]+)\s+(\d+)\s+(\d+)\s+(COMPLETED|NOT\s*COMPLETED|INCOMPLETE)/g;
/* --------------------------------------------------------------------
   PERSISTENT BROWSER INSTANCE
   Launching Chromium is the single most expensive part of the old flow
   (several seconds on Render's free CPU, on top of cold starts). Instead
   of launch()/close() on every request, we keep one browser process
   alive for the life of the server and just open/close pages per
   request. If the browser process dies or disconnects, we relaunch it
   lazily on the next request.
-------------------------------------------------------------------- */
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const existing = await browserPromise;
    if (existing.isConnected()) return existing;
    browserPromise = null; // fall through and relaunch
  }

  browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // avoids /dev/shm OOM issues on small containers
      '--disable-gpu',
      '--single-process', // trims memory footprint on 512MB Render free tier
    ],
  });

  const browser = await browserPromise;

  browser.on('disconnected', () => {
    // Ensures the next getBrowser() call relaunches instead of reusing a dead ref.
    browserPromise = null;
  });

  return browser;
}

// Launch eagerly on boot so the first real request doesn't pay Chromium's
// startup cost on top of everything else. If it fails, getBrowser() will
// retry on demand.
getBrowser().catch((err) => console.error('Initial browser launch failed:', err.message));

/**
 * Visit the login page first, then navigate to the gradecard URL with a
 * real Referer, using a persistent browser but a fresh page/tab per
 * request (so requests can't see each other's state).
 *
 * Wait strategy: 'networkidle2' waited for network silence, which is
 * often the slowest possible condition on pages with analytics/trackers.
 * We now wait for 'domcontentloaded' (DOM is parsed, fast) and then poll
 * for either the results table or a recognizable "not found" marker to
 * actually appear, with a hard timeout as a safety net.
 */
async function scrapeGradeCard({ categoryType, programCode, enrollment }) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Block images/fonts/stylesheets — we only need the HTML/text content,
    // and this cuts real network time on the ASP.NET pages noticeably.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'stylesheet' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const targetUrl = `${GRADECARD_BASE}?eno=${encodeURIComponent(enrollment)}&prog=${encodeURIComponent(
      programCode
    )}&type=${encodeURIComponent(categoryType)}`;

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
      referer: LOGIN_URL,
    });

    // Give the page a short, bounded window to finish any client-side
    // rendering (e.g. postback/AJAX) rather than waiting on network idle.
    // If a course table or the "Name:" text shows up sooner, we don't wait
    // the full timeout.
    try {
      await page.waitForFunction(
        () => {
          const text = document.body.innerText || '';
          return document.querySelectorAll('table tr').length > 1 || /Name:/i.test(text);
        },
        { timeout: 8000 }
      );
    } catch {
      // Timed out waiting for the expected content — proceed anyway and
      // let parseGradeCardHtml / the empty-result path handle it below.
    }

    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

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

// For mobile app PDF parsing: extract course rows from the text dump of a grade card PDF.
function parseCoursesFromText(text) {
  const courses = [];
  let match;
  while ((match = COURSE_ROW_RE.exec(text)) !== null) {
    const [, code, asgn1, lab1, , , , teeTheory, teePractical, status] = match;
    courses.push({
      code,
      asgn1: Number(asgn1),
      lab1: Number(lab1),
      teeTheory: Number(teeTheory),
      teePractical: Number(teePractical),
      status: status.replace(/\s+/g, ' '),
    });
  }
  return courses;
}

async function extractTextFromPdfBuffer(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(' ');
    fullText += pageText + ' ';
  }
  return fullText.replace(/\s+/g, ' ');
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

// For mobile app: parse a PDF grade card file uploaded by the user, extract course data, and return it.
app.post('/api/parse-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file received.' });
  }

  try {
    const cleanedText = await extractTextFromPdfBuffer(req.file.buffer);
    console.log('parse-pdf extracted text (first 500 chars):', cleanedText.slice(0, 500));

    const courses = parseCoursesFromText(cleanedText);
    console.log('parse-pdf matched courses:', courses.length);

    if (!courses.length) {
      return res.status(422).json({
        error: "Couldn't find a course table in this PDF. Double-check it's an IGNOU grade card export.",
      });
    }

    res.json({ courses });
  } catch (err) {
    console.error('PDF parse failed:', err.message);
    res.status(500).json({ error: 'Could not read this PDF. Please try a different file.' });
  }
});

// CGPA is computed from courses that have ALREADY been scored (i.e. the
// `courses` array returned by /api/scrape or /api/calculate, each with a
// `percentage` on it) plus a student-supplied credit per course code —
// see the note in calc.js on why credits can't be looked up automatically.
app.post('/api/cgpa', (req, res) => {
  const { courses, credits } = req.body || {};

  if (!Array.isArray(courses) || courses.length === 0) {
    return res.status(400).json({ error: 'courses must be a non-empty array.' });
  }
  if (!credits || typeof credits !== 'object' || Array.isArray(credits)) {
    return res
      .status(400)
      .json({ error: 'credits must be an object mapping course code to credit value.' });
  }

  const result = calculateCGPA(courses, credits);
  res.json(result);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`IGNOU Percentage Calculator backend running on port ${PORT}`);
});

// Clean shutdown: close the persistent browser too, so Render doesn't
// leave a zombie Chromium process hanging around on redeploy/restart.
async function shutdown() {
  console.log('Shutting down...');
  try {
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
  } catch (err) {
    console.error('Error closing browser during shutdown:', err.message);
  }
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);