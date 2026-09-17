// calc.js
// Core IGNOU percentage calculation logic.
// Formula (per IGNOU's published, university-wide rule): 30% continuous
// assessment (Assignment, or Lab marks for lab/project courses) + 70% Term-End
// component (Theory or Practical, whichever the course actually has).
//
// This is intentionally the SAME formula for every category. IGNOU does not
// publish a different ratio per category (BCA vs BDP vs CBCS vs Other) — the
// category dropdown on the official portal only changes *which database* your
// enrollment number is looked up in, not the marks formula. We keep a
// per-category config object anyway so it's a one-line change if IGNOU ever
// updates a specific program's weightage.

const CONTINUOUS_WEIGHT = 0.30;
const TERM_END_WEIGHT = 0.70;

const CATEGORY_CONFIG = {
  bca_mca_mp_mpb_pgdca_mba: {
    label: 'BCA / MCA / MCA_NEW / MP / MPB / PGDCA / PGDCA_NEW / New Programme MBA / MBF',
    continuousWeight: CONTINUOUS_WEIGHT,
    termEndWeight: TERM_END_WEIGHT,
  },
  bdp_ba_bcom_bsc_asso: {
    label: 'BDP / BA / B.Com / B.Sc / ASSO Programmes',
    continuousWeight: CONTINUOUS_WEIGHT,
    termEndWeight: TERM_END_WEIGHT,
  },
  cbcs: {
    label: 'CBCS Programmes',
    continuousWeight: CONTINUOUS_WEIGHT,
    termEndWeight: TERM_END_WEIGHT,
  },
  other: {
    label: 'Other Programmes',
    continuousWeight: CONTINUOUS_WEIGHT,
    termEndWeight: TERM_END_WEIGHT,
  },
};

/**
 * Classify a single course row into 'theory' | 'practical' | 'project'
 * based on which marks are populated, mirroring the columns IGNOU's own
 * grade card uses (Asgn1/Lab, Term End Theory, Term End Practical).
 */
function classifyCourse(course) {
  const asgn1 = Number(course.asgn1) || 0;
  const lab1 = Number(course.lab1) || 0;
  const teeTheory = Number(course.teeTheory) || 0;
  const teePractical = Number(course.teePractical) || 0;

  // Project-style course: no assignment, continuous assessment lives in LAB1
  if (asgn1 === 0 && lab1 > 0) return 'project';
  // Lab/practical course: has a term-end PRACTICAL mark instead of theory
  if (teePractical > 0 && teeTheory === 0) return 'practical';
  return 'theory';
}

/**
 * Compute the weighted percentage for a single course.
 * Returns { percentage, continuousMark, termEndMark, type } or null if the
 * course doesn't have enough data to score (e.g. still pending).
 */
function scoreCourse(course, weightage) {
  const type = course.type || classifyCourse(course);

  let continuousMark;
  let termEndMark;

  if (type === 'project') {
    continuousMark = Number(course.lab1) || 0;
    termEndMark = Number(course.teePractical) || 0;
  } else if (type === 'practical') {
    continuousMark = Number(course.asgn1) || 0;
    termEndMark = Number(course.teePractical) || 0;
  } else {
    continuousMark = Number(course.asgn1) || 0;
    termEndMark = Number(course.teeTheory) || 0;
  }

  if (course.status && /not\s*completed|incomplete|pending/i.test(course.status)) {
    return { type, continuousMark, termEndMark, percentage: null, status: course.status };
  }

  const percentage =
    continuousMark * weightage.continuousWeight + termEndMark * weightage.termEndWeight;

  return { type, continuousMark, termEndMark, percentage, status: course.status || 'COMPLETED' };
}

/**
 * Compute the full result set for a course list.
 * courses: [{ code, asgn1, lab1, teeTheory, teePractical, status, type? }]
 */
function calculatePercentage(category, courses) {
  const weightage = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.other;

  const scored = courses.map((c) => ({
    code: c.code,
    ...scoreCourse(c, weightage),
  }));

  const completed = scored.filter((c) => c.percentage !== null);
  const pending = scored.filter((c) => c.percentage === null);

  const totalMarks = completed.reduce((sum, c) => sum + c.percentage, 0);
  const maxMarks = completed.length * 100;
  const overallPercentage = maxMarks > 0 ? (totalMarks / maxMarks) * 100 : 0;

  return {
    category,
    categoryLabel: weightage.label,
    formula: `${weightage.continuousWeight * 100}% Continuous Assessment + ${
      weightage.termEndWeight * 100
    }% Term-End`,
    courses: scored,
    completedCount: completed.length,
    pendingCount: pending.length,
    totalCourses: scored.length,
    overallPercentage: Math.round(overallPercentage * 100) / 100,
  };
}

// ---------------------------------------------------------------------
// CGPA / Grade Point calculation
// ---------------------------------------------------------------------
// IGNOU's grade card never exposes course credits on the page we scrape —
// there is also no single official, machine-readable source listing the
// credit value of every course code across every programme. So credits
// are collected directly from the student (see /api/cgpa in server.js)
// rather than looked up automatically here.
//
// The percentage -> letter grade -> grade point table below is NOT an
// officially published IGNOU document we were able to verify — it's the
// 10-point scale (A=10 down to F=5) used consistently across third-party
// IGNOU CGPA guides and calculators. Some older / non-CBCS programmes are
// reported to use a different (5-point) scale, so treat this as a
// best-effort default rather than a guarantee. It's a one-line edit here
// if a student's official grade card shows different grade points for the
// same percentage on their programme.
const GRADE_SCALE = [
  { min: 80, grade: 'A', gradePoint: 10, label: 'Excellent' },
  { min: 70, grade: 'B', gradePoint: 9, label: 'Very Good' },
  { min: 60, grade: 'C', gradePoint: 8, label: 'Good' },
  { min: 50, grade: 'D', gradePoint: 7, label: 'Average' },
  { min: 40, grade: 'E', gradePoint: 6, label: 'Below Average' },
  { min: 0, grade: 'F', gradePoint: 5, label: 'Fail' },
];

function percentageToGrade(percentage) {
  const band =
    GRADE_SCALE.find((b) => percentage >= b.min) || GRADE_SCALE[GRADE_SCALE.length - 1];
  return { grade: band.grade, gradePoint: band.gradePoint, label: band.label };
}

/**
 * courses: the `courses` array as returned by calculatePercentage() — each
 * item already has { code, percentage, status, ... }. Percentage is used
 * (not raw marks) so the grade is always consistent with the number
 * already shown to the student in the breakdown table.
 *
 * credits: a map of courseCode -> credit value (number), supplied by the
 * student since we have no reliable way to look this up automatically.
 * Courses missing a credit value are excluded from the CGPA total (rather
 * than assumed to be some default), and reported back in `missingCredits`
 * so the UI can prompt for them.
 */
function calculateCGPA(courses, credits) {
  const rows = courses.map((c) => {
    const rawCredit = credits ? credits[c.code] : undefined;
    const credit = Number(rawCredit);
    const hasCredit = Number.isFinite(credit) && credit > 0;
    const isScored = c.percentage !== null && c.percentage !== undefined;

    if (!isScored) {
      return {
        code: c.code,
        credit: hasCredit ? credit : null,
        grade: null,
        gradePoint: null,
        points: null,
        status: c.status || 'PENDING',
        included: false,
      };
    }

    const { grade, gradePoint } = percentageToGrade(c.percentage);

    if (!hasCredit) {
      return {
        code: c.code,
        credit: null,
        grade,
        gradePoint,
        points: null,
        status: c.status,
        included: false,
      };
    }

    return {
      code: c.code,
      credit,
      grade,
      gradePoint,
      points: gradePoint * credit,
      status: c.status,
      included: true,
    };
  });

  const included = rows.filter((r) => r.included);
  const totalCredits = included.reduce((sum, r) => sum + r.credit, 0);
  const totalPoints = included.reduce((sum, r) => sum + r.points, 0);
  const cgpa = totalCredits > 0 ? totalPoints / totalCredits : 0;

  const missingCredits = rows
    .filter((r) => r.grade !== null && r.credit === null)
    .map((r) => r.code);

  return {
    courses: rows,
    totalCredits,
    totalPoints,
    cgpa: Math.round(cgpa * 100) / 100,
    missingCredits,
    note:
      'Grade points use a standard 10-point IGNOU scale that could not be officially verified for every programme — cross-check against your grade card if it looks off. Credits are entered by the student, not fetched from IGNOU.',
  };
}

module.exports = {
  calculatePercentage,
  classifyCourse,
  scoreCourse,
  calculateCGPA,
  percentageToGrade,
  GRADE_SCALE,
  CATEGORY_CONFIG,
};