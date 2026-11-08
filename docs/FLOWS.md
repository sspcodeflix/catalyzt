# Flows: one shared view of where the work is

A **flow** is a piece of work that takes days and several people, such as raising regression coverage
for an application. It belongs to the application, not to a chat or a person. Anyone on the team who
opens that workspace and application sees the same flow, at the same step, waiting on the same person.
Chat stays the way people act on it. The flow is the way they see where it stands.

## Why

Today the steps exist but are scattered. The scan is in App Context, coverage is in Hexa, drafts are in a
chat, reviews are in Needs you, and the pull request is in GitHub. A person who scans, logs out and comes
back two days later has to rebuild the picture. A teammate who joins sees none of it.

## The regression flow

```
 Step                  Who does it              Done when                         Waits on
 1 Scan                agent                    every component's repo scanned    —
 2 Baseline            agent                    coverage report per component     —
 3 Choose gaps         flow owner               gaps selected (all, or some)      owner
 4 Draft cases         agent                    a manual case per chosen gap      —
 5 Review cases        component managers       every case approved               each manager, for their component
                       (or reviewers they name)
 6 Generate automation agent                    test code per approved case       —
 7 Code review         repository code owners   pull request merged in GitHub     code owners
 8 Verify              CI                       the new test passed in the        the pipeline
                                                target build
 9 Result              agent                    coverage after vs. before         —
```

Two loops come back into the flow:
- **Changes requested.** A reviewer's comments send the case back to step 4. The agent writes a new
  version, and only that case goes round again.
- **Not enough knowledge.** A reviewer says the requirements behind a case are too thin to approve it.
  The case moves to **Needs knowledge** and a Huddle concern goes to the product owner or a business
  analyst. When they add the requirement, or upload a document to the app's context, the case is drafted
  again. This is the "the functional requirements are not good enough for me" path.

## Items, not one big step

A flow carries many gaps, and each one moves on its own. Twelve cases can be in review while four are
already in a pull request. So each step shows a count, and the flow's headline is the step that holds
the work back:

```
 Regression · ABCD (Ram's Portfolio)                         started by Sourav · 3 Nov

  ✓ Scan   ✓ Baseline   ✓ Choose gaps   ● Review cases   ○ Automation   ○ Code review   ○ Verify
                                         24 of 40 approved

  Waiting on you: 8 cases for checkoutservice                         [Review now]
  Waiting on Brijesh: 6 cases for paymentservice (2 days)             [Remind]
  Needs knowledge: 2 cases, asked Ram in Huddle                       [Open]

  Coverage   31% at baseline  →  31% now  →  52% when this flow finishes
```

The coverage line has three numbers:
- **Baseline:** the share of criteria and requirements with an automated test that passed in the target
  build, measured when the flow started.
- **Now:** the same share today.
- **When this flow finishes:** the share if every chosen gap ends with a passing test.

Where a requirement was inferred from code instead of taken from Jira or the knowledge base, the
report says so. A high number built on inferred requirements is not the same as one built on real ones.

## Where people see it

- **In chat**, as a flow card: the stepper and the "waiting on" lines, updated live. "Where is the
  regression for ABCD?" or "what is waiting on me?" answers with the card.
- **On arrival.** When someone opens the application, a strip above the chat shows its active flows and
  what changed since they last looked: "Since Tuesday: 14 cases drafted, waiting for your review."
- **In Needs you**, each waiting item links back to its place in the flow.
- **On the flow page**, the full view: the stepper, a table of items with their step and owner, and the
  timeline of who did what. It is reached from the card, never needed to act.

## Rules

- **The agent never passes a gate.** A gate is a named person's decision, recorded with who, when and
  which version. Agent steps run as durable jobs, so they finish while nobody is logged in.
- **One state for everyone.** The flow's state is computed from records: scans, test cases and their
  review states, pull requests and CI results. It is never typed in by hand, so it cannot drift from
  Hexa or GitHub.
- **Delegation is explicit.** "I need my team to review this" assigns cases to named reviewers per
  component. Only the component manager, or someone they named, can approve.
- **Stale work goes back.** If a criterion changes in Jira, or an approved case is edited, that item
  returns to review and the flow says why.
- **Owner controls.** The person who started the flow, or the app owner, can pause, cancel, or add and
  remove gaps. Each change is recorded. Only one regression flow can be active per application.
- **Reminders.** An item past its due time is reminded in Needs you, and later escalated to the app
  owner, as in Huddle.

## The same frame for what comes next

The story UAT flow in the chat-first note becomes one kind of flow. SRE remediation and vulnerability
remediation assurance are later kinds with the same parts: agent steps, gated steps, items, waiting on,
and a before-and-after measure. For vulnerabilities, the measure is open findings by severity. For SRE,
it is risk to the error budget or time to saturation.

## Data

- `flows`: id, application, kind, title, owner, status (active, paused, done, cancelled), baseline
  measure, created and finished times.
- `flow_items`: flow, gap reference (component plus criterion or requirement), test case, pull request,
  current step, state, assignee, due time.
- `flow_events`: the audit timeline, one row per transition, with who and why.

Steps and their counts are derived from items and existing records, not stored twice. The flow reuses
jobs, test case versions and review states (step 2a of the chat-first note), approvals, and Huddle
concerns.

## Build order

1. **Read-only flow.** Flow records, the baseline from the scan and Hexa, the flow card in chat, the
   arrival strip, and the flow page. Started from chat with "start a regression for ABCD".
2. **Gaps and cases.** Choose gaps, draft cases as durable jobs, case review with request changes and
   delegation. This is the chat-first step 2a, delivered inside the flow.
3. **Needs knowledge.** The Huddle concern to the product owner, and drafting again when knowledge
   arrives.
4. **Automation.** Generated test code, a pull request opened in the repository, its review state
   mirrored, and verification in CI.
5. **Result and reminders.** Coverage after the flow, reminders and escalation, and a virtual-user
   simulation that leaves the flow mid-way and resumes it as another person.

## Open decisions

- Who may start a regression flow: the app owner only, or any component manager for their components.
- Whether gaps are chosen per criterion, or per component with all its gaps.
- Whether automation pull requests are grouped per component or opened one per test.
