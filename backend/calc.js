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

module.exports = { calculatePercentage, classifyCourse, scoreCourse, CATEGORY_CONFIG };
