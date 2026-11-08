# Huddle: the team's decisions, across testing, reliability and security

Huddle today handles four testing-centred kinds of item: source conflicts, disputed mappings, risk
acceptances and feedback patterns. It becomes the place for anything that needs more than one person,
whatever the domain: a doubt someone wants a second opinion on, a choice between options, an exception
to a rule, and the follow-up actions a decision creates.

## What goes into Huddle

| Kind | Raised when | Options typically | Decided by |
|---|---|---|---|
| **Concern** | Anyone (or the agent) is unsure: "is this flaky test hiding a real bug?", "is it safe to restart checkout during the sale?" | Answer it, turn it into a decision, or create a follow-up | The owner of the domain; anyone can answer |
| **Decision** | A choice has to be made between named options | Two or more, with evidence per option | The domain's decider |
| **Risk acceptance** | Shipping, running or leaving something with a known gap | Accept until a date with compensating controls, or do not accept | Decider for the domain; always with an expiry |
| **Change review** | The agent has prepared a change (GitOps PR, config, scaling) that deserves discussion before the approval card | Go, go with changes, not now | The domain's decider; the approval card then executes |
| **Vulnerability triage** | A finding needs a plan: CVE, severity, affected components, fix availability | Upgrade now, patch, mitigate, accept until a date | Security champion (app owner as fallback) |
| **Incident follow-up** | After an incident or an alert analysis | Actions with owners and due dates | SRE / on-call lead |
| **Capacity warning** | Predictive CloudOps: "memory reaches its limit in about 3 h at this rate" | Scale, restart, investigate, accept the risk | SRE / on-call lead |
| **Source conflict**, **disputed mapping**, **feedback pattern** | As today (App Context, test links, low ratings) | As today | As today |

Each item names its **domain** (Testing, Reliability, Security, Knowledge, Process). The domain decides who
is asked to decide, which reminders apply, and where the item shows in Needs you.

## Lifecycle

```
Open ──▶ Needs input ──▶ Decided ──▶ Follow-up ──▶ Closed
  │            ▲             │          (actions with owners and due dates; closed when all are done)
  └── answered (concern) ────┘
Risk acceptances: Decided ──▶ Expired (at the expiry date the item reopens, the owner is reminded)
```

- **Votes are advisory; one named person decides,** with a reason. The decision and its reason are the record.
- **Actions** created by a decision (open a PR, rotate a key, add a test) have an owner and a due date, are
  reminded in Needs you, and close the item when all are done. An action that changes a system still
  goes through its approval card; Huddle never changes anything by itself.
- **Expiry:** every risk acceptance has an end date (security defaults by severity: critical 7 days,
  high 30, medium 90). At expiry the item reopens.
- **Escalation:** an item waiting past its due time is reminded, then escalated to the app owner.

## The agent's part

- **Raises items when it should not decide alone:** conflicting sources, low confidence on a coverage
  or root-cause answer, a change with blast radius, a finding without an upgrade path, a capacity warning.
- **Prepares the item:** a neutral summary, the options with the evidence for each (cited, with links to
  runs, tests, deploys, CVEs, passages), what each option changes, and who has to decide.
- **Never decides and never votes.** After a decision it drafts the actions and their approval cards.
- **From chat:** any answer offers "Raise with the team"; the item carries the question, the answer and
  its sources. "What is waiting on me?" lists the items that need the person.

## Who decides, by domain

| Domain | Decider | Fallback |
|---|---|---|
| Testing | Component manager of the affected component; product owner for UAT sign-off exceptions | App owner |
| Reliability | SRE / on-call lead | App owner |
| Security | Security champion (`security_champion` role, already in the data model) | App owner |
| Knowledge | App owner | — |
| Process | App owner | — |

## What changes in the product

1. **Data:** a `domain` and a `type` per item, due date and expiry, an `actions` table (owner, due, status,
   link to its approval card), links to any entity (story, test, run, component, deployment, CVE,
   chat). Existing items keep working: they become Testing and Knowledge items.
2. **Huddle page:** filters by domain and by "waiting on me"; the item panel shows the evidence per option,
   the decision, the actions and the expiry.
3. **Chat:** "Raise with the team" on every answer; CloudOps and Security agents raise their kinds of item.
4. **Needs you:** decisions to make, actions due, risk acceptances expiring.
5. **Roles:** SRE / on-call lead and product owner join the existing roles; the security champion role is
   given to people in the workspace.
