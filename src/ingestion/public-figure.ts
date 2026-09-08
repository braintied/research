/**
 * PUBLIC_FIGURE_TAXONOMY — the categorizer taxonomy for a corpus that is ONE
 * PERSON'S published output, rather than a subject-matter feed.
 *
 * Why this exists as a second taxonomy instead of a widened first one: the
 * contractor taxonomy classifies an item by what it is ABOUT. A person corpus
 * has to classify by what the item DOES for that person's audience, because
 * the consumer is a repurposing engine deciding what to cut, quote, or post.
 * "A success story" and "a formative event he retells in every interview" are
 * the same row under `win` and different jobs on a content calendar.
 *
 * The category that earns its place is `guest_subject`. A person corpus built
 * from an interview show is mostly other people talking, and an engine that
 * cannot separate the host's material from a guest's will publish a guest's
 * sentence under the host's name. That failure has a rule of its own
 * (`~/.agents/rules/claims-about-people.md`) and this category is the cheapest
 * place to catch it. It is a WEAK signal, derived from an 800-character head
 * of the item — it narrows what a human or an utterance-level speaker check
 * has to look at. It never establishes who spoke, and nothing downstream may
 * treat it as though it did.
 */

import type { CategorizeTaxonomy } from './categorize.js';

/**
 * Categories for one person's published output.
 *
 * Ordered from the subject's own argument outward to material that is merely
 * about him, because that is the order a repurposing engine wants them in.
 */
export const PUBLIC_FIGURE_CATEGORIES = [
  'thesis',
  'origin_story',
  'doctrine',
  'craft',
  'promotion',
  'tribute',
  'guest_subject',
  'press',
  'other',
] as const;

export type PublicFigureCategory = (typeof PUBLIC_FIGURE_CATEGORIES)[number];

/**
 * Build the taxonomy for one named subject.
 *
 * The subject's name is a parameter rather than a placeholder the caller
 * string-replaces, because the name appears in three prompt fields and a
 * partial substitution is invisible in the output — the model simply
 * classifies against a generic "the subject" and the categories drift.
 *
 * `descriptor` is the one-line "who this person is" a stranger would need
 * (e.g. "a retired Air Force test pilot and podcast host"). Without it the
 * model classifies a fighter pilot's change-of-command speech against its
 * generic prior for "speech", and `craft` collapses into `doctrine`.
 */
export function publicFigureTaxonomy(
  subjectName: string,
  descriptor: string,
): CategorizeTaxonomy<PublicFigureCategory> {
  const name = subjectName.trim();
  const who = descriptor.trim();
  if (name.length === 0) {
    throw new Error('[publicFigureTaxonomy] subjectName is required');
  }
  if (who.length === 0) {
    throw new Error('[publicFigureTaxonomy] descriptor is required');
  }

  return {
    categories: PUBLIC_FIGURE_CATEGORIES,
    fallback: 'other',
    audienceBrief:
      `You are cataloguing the published output of ${name}, ${who}, for a team that ` +
      `repurposes it into clips, posts, and written pieces. Classify each item by the ` +
      `job it can do for that team, not by its subject matter. Some items are ${name}'s ` +
      `own words; others are guests on his show, or other people talking about him. ` +
      `Telling those apart matters more than any other distinction here.`,
    categoryDescriptions: {
      thesis:
        `the through-line argument ${name} returns to across his work, stated in his own framing`,
      origin_story:
        `a formative personal event ${name} retells — the version he tells, not a report of it`,
      doctrine:
        `a stated principle, rule, or lesson ${name} offers for how to lead, decide, or work`,
      craft:
        `the technical substance of what ${name} actually did or does, told at working depth`,
      promotion:
        'a push for a book, episode, product, appearance, or launch',
      tribute:
        'a memorial, honour, condolence, or praise directed at another person',
      guest_subject:
        `the substance of this item belongs to a GUEST or another participant rather than ${name} — ` +
        `he is hosting, interviewing, or introducing. Choose this whenever the quotable material ` +
        `is more likely someone else's than his`,
      press:
        `third-party coverage, an event listing, or a bio page ABOUT ${name}, written by someone else`,
      other: 'none of the above',
    },
    relevanceFieldPrompt:
      'one short sentence on what a repurposing team could make from this item, naming the ' +
      'format (clip, quote card, post, newsletter section) when it is obvious',
    quoteVoice:
      'a sentence someone actually said or wrote in this item, copied VERBATIM and standing on ' +
      'its own without setup. Prefer the strongest line regardless of who said it; do NOT ' +
      `assume the speaker is ${name}`,
  };
}

/**
 * A ready-made taxonomy for callers with no subject to hand.
 *
 * Deliberately generic: it produces coherent categories and useless category
 * descriptions, which is the correct behaviour for a caller who has not said
 * whose corpus this is. Prefer `publicFigureTaxonomy(name, descriptor)`.
 */
export const PUBLIC_FIGURE_TAXONOMY: CategorizeTaxonomy<PublicFigureCategory> =
  publicFigureTaxonomy('the subject', 'a public figure with a body of published work');
