/** The capability map a regression starts from (docs/FLOWS.md › Regression). Shared by server/capabilities.ts and the Regression page. */
export type CheckStatus = 'covered' | 'failing' | 'not-run' | 'none';

export interface CheckTest {
  id: string;
  title: string;
  /** Its result in the target build of its repository, if it ran there. */
  result: string | null;
  /** Why it is offered for this check, when it is a suggestion rather than a linked test. */
  why?: string;
}

export interface CapabilityCheck {
  id: string;
  text: string;
  origin: 'agent' | 'person';
  /** covered: a linked automated test passed in the target build; failing: one failed; not-run: linked tests with no result there; none: no linked test. */
  status: CheckStatus;
  /** Tests a person linked to this check, with their result. */
  tests: CheckTest[];
  /** Automated tests of the capability's component that share the check's words; a person links one so it counts. */
  suggestions: CheckTest[];
}

export interface Capability {
  id: string;
  name: string;
  summary: string;
  /** The component whose test folder holds this capability's tests, when known. */
  component: string | null;
  origin: 'agent' | 'person';
  /** Passages of App Context the agent drew it from (locators). */
  sources: string[];
  confirmedBy: string | null;
  confirmedAt: string | null;
  checks: CapabilityCheck[];
  counts: Record<CheckStatus, number>;
}

export interface CapabilityMap {
  capabilities: Capability[];
  totals: Record<CheckStatus, number> & { checks: number };
  /** When the agent last added to the map, and who asked. */
  mappedAt: string | null;
  mappedBy: string | null;
  /** Every capability has been confirmed by a person. */
  confirmed: boolean;
  /** The automation repository's target build, whose results count. */
  build: { label: string; at: string } | null;
}
