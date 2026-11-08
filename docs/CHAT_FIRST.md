# Chat-first Catalyzt

Decision (8 November 2026): chat becomes the front door and the main way to work. The separate
pages stay, behind one entry, for checking evidence, bulk work and administration. This note says
what changes, in what order, and what must be true before each step.

## Principles

1. **One place to ask, one place to act.** Every request starts in chat: questions, analyses, uploads,
   links, scans, decisions. Anything that changes data comes back as an approval card in the
   conversation, never as a silent change.
2. **Evidence comes to the conversation.** Coverage tables, test lists, run failures, cited passages and
   conflicts open as cards and side panels from the answer. Nobody has to leave the chat to check a claim.
3. **Decisions live outside the stream.** Approvals, risk acceptances and conflict decisions are records
   with an owner and a history. Chat creates and links them; the inbox is where they wait.
4. **Correct before simple.** The fewer screens people see, the more they rely on the answer. Evidence
   correctness (step 1) comes first.

## Navigation

```
Before                         After
──────                         ─────
Home                           Chat            (landing page; recents below the composer)
Search                         Needs you  (3)  approvals, decisions, failing evidence for my stories
Jira Stories                   Library ▸       Stories · Tests (Hexa) · Context · Decisions (Huddle) · Agents
Hexa · Tests
App Context
Huddle · Decisions
Agents
```

## Screens

```
Chat (landing)
┌──────────────────────────────────────────────────────────────┬───────────────────────────────┐
│ Good morning, Sourav                                         │                               │
│ ┌──────────────────────────────────────────────────────────┐ │   (side panel opens here for  │
│ │ Ask Catalyzt… e.g. "Is ABCD-1004 ready for UAT?"        │ │    a report, a test, a source │
│ │ [+ attach]                                       [send]  │ │    or a decision)             │
│ └──────────────────────────────────────────────────────────┘ │                               │
│ Needs you: 2 approvals · 1 decision · ABCD-1004 AC2 failing  │                               │
│ Recent: UAT · ABCD-1004 · Which tests cover frontend…        │                               │
└──────────────────────────────────────────────────────────────┴───────────────────────────────┘

An answer with evidence and an action
  You:  link the ach batch tests to ABCD-1014 AC4
  Catalyzt: Two tests in moov-io/ach cover AC4 [1]:
      ┌ Evidence ─────────────────────────────────────────────┐
      │ TestFile__AscendingBatchSequenceADV  passed  c7025ec  │
      │ TestFile__IATBatchNumbersAscend…     passed  c7025ec  │
      └───────────────────────────────────────── Open in Tests ┘
      ┌ Link 2 tests to ABCD-1014 AC4? ───────────────────────┐
      │ Changes: Hexa links only · Jira unchanged              │
      │                                  [Not now] [Link]      │
      └────────────────────────────────────────────────────────┘

Needs you
┌──────────────────────────────────────────────────────────────┐
│ Approve  · Add 5 UAT cases to WIMT-1006 · asked by David   ▸ │
│ Decide   · Refund window: team notes vs Jira · 2 votes      ▸ │
│ Evidence · ABCD-1004 AC2 failing in c7025ec since 09:12     ▸ │
└──────────────────────────────────────────────────────────────┘
```

## Chat actions (step 2)

Each page action becomes a request the router recognises and a tool the right agent calls. Every one
that changes data returns an approval card; reads answer directly.

| Request (examples) | Tool | Changes data |
|---|---|---|
| "Is ABCD-1004 ready for UAT?" | UAT analysis | proposes cases (approval) |
| "Write the UAT cases for AC3" | Authoring | adds manual tests (approval) |
| "Link TC-… to ABCD-1014 AC4", "which tests could cover AC4?" | Hexa link suggestions | links (approval) |
| Attach a document: "use this as context" | App Context upload | adds a source (approval for app scope) |
| "Scan the ach repository" | Hexa repo scan | updates the inventory (approval) |
| "Keep the Jira version of the refund window" | Huddle decide | records a decision (owner only) |
| "What failed in the last build?" | Runs and results | no |
| "Change the Jira filter to include Done" | Jira filter | yes (owner, approval) |

## Steps

1. **Evidence correctness.** CI results keep their package and file so tests map to components; a
   component's tests are matched by link, module path and distinctive package words only; a linked test
   from a repository that none of the story's components use does not count, and linking one is refused
   unless confirmed. Regression tests use the real import shapes (Maven, Go, Jest).
2. **Chat actions** from the table above, each with its approval card and audit row.
3. **Evidence cards** in answers: coverage, tests, runs, passages, conflicts, with "Open in …".
4. **Navigation**: Chat as landing page, the "Needs you" inbox, Library for the existing pages.
5. **Proactive updates** into the inbox when evidence for a story changes.

Each step ends with the browser suite, a simulation of all three portfolios and a judgement review.
