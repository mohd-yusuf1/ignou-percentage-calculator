const API = window.API_BASE_URL;

/* ---------------- results rendering (shared by all flows) ---------------- */

// function computeDivision(pct) {
//   if (pct >= 60) return { label: 'First Division', class: 'good' };
//   if (pct >= 50) return { label: 'Second Division', class: 'mid' };
//   if (pct >= 40) return { label: 'Third Division', class: 'low' };
//   return { label: 'Below Pass Mark', class: 'low' };
// }

function renderResults(data) {
  const section = document.getElementById('results');
  section.hidden = false;

  document.getElementById('resultPercent').textContent = data.overallPercentage.toFixed(2);

  // const division = computeDivision(data.overallPercentage);
  // document.getElementById('divisionBadge').textContent = division.label;

  document.getElementById('resultName').textContent = data.name || 'Your result';
  document.getElementById('resultProgramme').textContent = [data.programCode, data.enrollment]
    .filter(Boolean)
    .join(' · ');
  document.getElementById('resultFormula').textContent = `${data.formula}`;

  const statRow = document.getElementById('statRow');
  statRow.innerHTML = `
    <div class="stat-box"><span class="stat-value">${data.totalCourses}</span><span class="stat-label">total courses</span></div>
    <div class="stat-box"><span class="stat-value">${data.completedCount}</span><span class="stat-label">completed</span></div>
    <div class="stat-box"><span class="stat-value">${data.pendingCount}</span><span class="stat-label">pending</span></div>
  `;

  const tbody = document.getElementById('resultTableBody');
  tbody.innerHTML = '';
  data.courses.forEach((c) => {
    const tr = document.createElement('tr');
    const pctCell =
      c.percentage !== null
        ? `${c.percentage.toFixed(2)}%`
        : `<span class="status-pending">${c.status || 'pending'}</span>`;
    tr.innerHTML = `
      <td>${c.code}</td>
      <td><span class="type-badge type-${c.type}">${c.type}</span></td>
      <td>${c.continuousMark}</td>
      <td>${c.termEndMark}</td>
      <td>${pctCell}</td>
    `;
    tbody.appendChild(tr);
  });

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('printBtn').addEventListener('click', () => window.print());

function showError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.hidden = false;
  el.style.color = '';
  el.style.background = '';
  el.style.borderColor = '';
}
function hideError(id) {
  document.getElementById(id).hidden = true;
}

// Same element, but for the "this isn't an error, just nothing to show yet"
// case (e.g. a valid enrollment number with an empty grade card). Uses
// inline styles so it visually reads as a neutral notice rather than a
// red error message, without needing any changes to style.css.
function showInfo(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.hidden = false;
  el.style.color = '#1a4fa0';
  el.style.background = '#eaf1fd';
  el.style.border = '1px solid #b9d3f5';
  el.style.borderRadius = '8px';
  el.style.padding = '10px 12px';
}

/* ---------------- 1) scrape flow ---------------- */

document.getElementById('scrapeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('scrapeError');
  const category = document.getElementById('scrapeCategory').value;
  const programCode = document.getElementById('scrapeProgramCode').value.trim();
  const enrollment = document.getElementById('scrapeEnrollment').value.trim();
  const btn = e.target.querySelector('button[type="submit"]');

  btn.disabled = true;
  btn.textContent = 'Fetching from IGNOU…';
  try {
    const res = await fetch(`${API}/api/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, programCode, enrollment }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');

    if (data.empty) {
      // Valid enrollment number, but no grade card data yet — not an error.
      document.getElementById('results').hidden = true;
      showInfo('scrapeError', data.message);
      return;
    }

    renderResults(data);
  } catch (err) {
    showError('scrapeError', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch & calculate';
  }
});

/* ---------------- 2) PDF upload flow ---------------- */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const dropzone = document.getElementById('dropzone');
const pdfInput = document.getElementById('pdfInput');
const dropzoneLabel = document.getElementById('dropzoneLabel');
let selectedFile = null;

dropzone.addEventListener('click', () => pdfInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files[0]) {
    selectedFile = e.dataTransfer.files[0];
    dropzoneLabel.textContent = selectedFile.name;
  }
});
pdfInput.addEventListener('change', () => {
  if (pdfInput.files[0]) {
    selectedFile = pdfInput.files[0];
    dropzoneLabel.textContent = selectedFile.name;
  }
});

async function extractTextFromPdf(file) {
  const buffer = await file.arrayBuffer();
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

// Matches rows like: BCS011 79 0 0 - - 61 0 COMPLETED
// groups: code, asgn1, lab1, lab2, lab3, lab4, teeTheory, teePractical, status
const COURSE_ROW_RE =
  /([A-Z]{2,8}\d{2,4}[A-Z]?)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d-]+)\s+([\d-]+)\s+(\d+)\s+(\d+)\s+(COMPLETED|NOT\s*COMPLETED|INCOMPLETE)/g;

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

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('uploadError');
  const category = document.getElementById('uploadCategory').value;

  if (!selectedFile) {
    showError('uploadError', 'Choose a PDF file first.');
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Reading PDF…';

  try {
    const text = await extractTextFromPdf(selectedFile);
    const courses = parseCoursesFromText(text);

    if (!courses.length) {
      throw new Error(
        "Couldn't find a course table in this PDF. Try the manual entry option instead, or double-check it's an IGNOU grade card export."
      );
    }

    const res = await fetch(`${API}/api/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, courses }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    renderResults(data);
  } catch (err) {
    showError('uploadError', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Read PDF & calculate';
  }
});
