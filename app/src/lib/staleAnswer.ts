/**
 * R04: saved answers whose test facts predate how Catalyzt reads Hexa today. Models are not re-run;
 * the answer gets a note and an "Ask again" that resends the same question.
 *
 * The rule, from what every saved answer carries (its router intent and its numbered sources):
 *  - Only a finished specialist answer whose request named components (the router's extraction or
 *    the composer tags) is checked. UAT analyst reports, clarifying questions, rejections and
 *    answers about nothing in particular are not.
 *  - Since S03 a specialist reads Hexa for every named component and cites one "Hexa · <name>"
 *    source per component. No such source means the answer was written before Hexa was read.
 *  - Since R01 a component's tests are matched by link, module path and package, and the source's
 *    detail says so (HEXA_COMPONENT_FACTS). A component source without that wording was produced
 *    by the earlier title-only match, which reported "no automated tests" for CI-imported tests.
 * Either way the note says what is known (the facts were read the old way) and nothing more.
 */
import type { AssistantMessage, Message } from './types';

/** Written into the detail of each component's Hexa source by the matcher introduced with R01. */
export const HEXA_COMPONENT_FACTS = 'tests by link, path and package';

/** At most this many components get a Hexa source per answer (server/evidence.ts). */
const MAX_COMPONENT_FACTS = 3;

export type StaleReason = 'no-hexa' | 'old-matching';

export function staleTestFacts(m: AssistantMessage): StaleReason | null {
  if ((m.status ?? 'done') !== 'done' || !m.intent || m.intent.question) return null;
  if (m.blocks.some((b) => b.kind === 'artifact' || b.kind === 'rejected')) return null;
  const components = m.intent.components.slice(0, MAX_COMPONENT_FACTS);
  if (!components.length) return null;
  const hexa = m.citations.filter((c) => c.title.startsWith('Hexa · '));
  if (!hexa.length) return 'no-hexa';
  const current = (name: string) => hexa.some((c) => c.title === `Hexa · ${name}` && c.detail.includes(HEXA_COMPONENT_FACTS));
  return components.every(current) ? null : 'old-matching';
}

export const STALE_TEXT: Record<StaleReason, string> = {
  'no-hexa': 'This answer was written before Catalyzt read Hexa for the components a question names, so what it says about tests was not checked against the test inventory.',
  'old-matching':
    'This answer was written before Catalyzt matched tests to a component by module path and package, so its test counts may be wrong (CI-imported tests were missed).',
};

/** The question an answer replied to: the user message right before it, unless it was removed. */
export function questionFor(messages: Message[], answerId: string) {
  const i = messages.findIndex((m) => m.id === answerId);
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role === 'user') return m.text.startsWith('[Message removed') ? null : m;
  }
  return null;
}
