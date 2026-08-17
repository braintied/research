/**
 * Decision-brief support — deterministic helpers for multi-question research
 * briefs.
 *
 * A decision brief carries several numbered decision-grade questions under one
 * markdown heading. Planned as a single blob, the planner holds no per-question
 * budget: measured 2026-08-15, an 8-question brief planned at standard depth
 * yielded subqueries for the first few questions only, and every later section
 * assembled as an evidence gap. These helpers split such a brief so the caller
 * can plan each question with its own share of the subquery band, and map the
 * resulting `q{n}.*` section paths back to human-readable headings.
 *
 * Both functions are pure and deterministic — no model calls, no I/O.
 */

export interface DecisionBriefSplit {
  /**
   * Everything in the brief BEFORE the questions heading (stance, context,
   * constraints), truncated to {@link SHARED_CONTEXT_MAX_CHARS}. Prepended to
   * every per-question planning brief so each plan sees the shared framing.
   */
  sharedContext: string;
  /** Question texts in brief order. Index 0 is question 1 (`q1`). */
  questions: string[];
}

/**
 * The shared header must stay small: it is re-sent once per question to the
 * planner model, so an unbounded header multiplies planner spend by the
 * question count.
 */
export const SHARED_CONTEXT_MAX_CHARS = 2500;

const QUESTIONS_HEADING_PATTERN = /^#{1,6}\s+.*(decision[- ]grade questions|questions\b)/i;
const HEADING_PATTERN = /^#{1,6}\s+/;
const NUMBERED_ITEM_PATTERN = /^\s*\d+\.\s+/;

/**
 * Detect and split a decision brief's numbered questions.
 *
 * Returns null when the brief has no questions heading, or the section holds
 * fewer than two numbered items — in both cases the caller should plan the
 * whole brief in one pass, exactly as before this module existed.
 */
export function splitDecisionBriefQuestions(brief: string): DecisionBriefSplit | null {
  const lines = brief.split('\n');
  let headingIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (QUESTIONS_HEADING_PATTERN.test(lines[i])) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) {
    return null;
  }

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (HEADING_PATTERN.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const questions: string[] = [];
  let current: string[] | null = null;
  for (let i = headingIndex + 1; i < sectionEnd; i += 1) {
    const line = lines[i];
    if (NUMBERED_ITEM_PATTERN.test(line)) {
      if (current !== null) {
        questions.push(current.join(' ').trim());
      }
      current = [line.replace(NUMBERED_ITEM_PATTERN, '').trim()];
    } else if (current !== null && line.trim() !== '') {
      current.push(line.trim());
    }
  }
  if (current !== null) {
    questions.push(current.join(' ').trim());
  }

  const nonEmpty = questions.filter((q) => q !== '');
  if (nonEmpty.length < 2) {
    return null;
  }

  const sharedContext = lines
    .slice(0, headingIndex)
    .join('\n')
    .trim()
    .slice(0, SHARED_CONTEXT_MAX_CHARS);

  return { sharedContext, questions: nonEmpty };
}

const QUESTION_SECTION_PATH_PATTERN = /^q(\d+)\./;
const QUESTION_HEADING_MAX_WORDS = 12;

/**
 * Resolve a `q{n}.*` section path to a question-derived heading, e.g.
 * `Q3: Can each option compose vector-kNN seeding + graph traversal`.
 *
 * Returns undefined for non-question section paths or when the titles map
 * carries no entry for the question — callers fall back to the code-owned
 * ordinal heading. The heading remains code-owned: the question text was
 * captured at plan time from the caller's own brief, never from model output.
 */
export function questionHeadingFor(
  sectionPath: string,
  sectionTitles: Record<string, string> | undefined,
): string | undefined {
  if (sectionTitles === undefined) {
    return undefined;
  }
  const match = QUESTION_SECTION_PATH_PATTERN.exec(sectionPath);
  if (match === null) {
    return undefined;
  }
  const key = `q${match[1]}`;
  const question = sectionTitles[key];
  if (question === undefined || question.trim() === '') {
    return undefined;
  }
  const words = question.trim().split(/\s+/);
  const clipped = words.slice(0, QUESTION_HEADING_MAX_WORDS).join(' ');
  const suffix = words.length > QUESTION_HEADING_MAX_WORDS ? '…' : '';
  return `Q${match[1]}: ${clipped}${suffix}`;
}
