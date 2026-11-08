# Test flows: one shared view of where UAT and regression stand

A **test flow** takes a set of stories through UAT or regression. It belongs to the application, not
to a chat or a person. Anyone on the team who opens the application sees the same flow, at the same
step, waiting on the same people. Chat stays the way people ask and act. The flow shows where the
work stands, so nobody has to rebuild the picture after a day away.

Scope: testing only (UAT and regression). SRE and vulnerability remediation are out of scope here.

## The two flows

Each story in a flow moves through four steps. The agent does the first one in the background. Each
of the others waits on a named person, and the flow says who.

```
 UAT          Analyse ──▶ Review cases ──▶ Run tests ──────────▶ Sign off
              agent       component         UAT testers record      product owner
                          manager           pass / fail / blocked   (or app owner)

 Regression   Analyse ──▶ Review cases ──▶ Automate ───────────▶ Verify in CI
              agent       component         automation engineer     the pipeline:
                          manager           writes the test, PR     the new test must
                                            is reviewed and merged  pass in the target build
```

Where each step's state comes from (nothing is typed in by hand, so the flow cannot drift):

| Step | Done when | Comes from |
|---|---|---|
| Analyse | the UAT analyst's report for the story exists | the report in a chat the flow created |
| Review cases | the drafted cases are approved, or nothing needed drafting | the flow's review of the approval on that report |
| Run tests | every criterion has a passing automated test or a tester's pass | CI results in Hexa and testers' results |
| Sign off | a manager of the story's components signed off with that evidence | the sign-off record |
| Automate | every criterion has an automated test of the story's components | Hexa links |
| Verify in CI | every criterion's automated test passed in the target build | CI results |

## Who it waits on

The component manager owns the flow for their stories and can take a story from analysis to sign-off
alone. Nothing in a flow needs an app owner: owners are only the fallback for a component that has no
manager, and they can add or remove approvers.

- **Review cases:** every manager of the story's components approves the drafted cases, once each; a story
  spanning two managers' components needs both. A manager (or the flow's owner, or an app owner) can add
  people to a story, and their approval is needed too; "Who approves" on the story shows each person, why,
  and where they stand. The cases are added to Hexa when the last approval is in. Anyone required can ask
  for changes instead, with a note, which ends the review: the flow's owner analyses again. An app owner who
  is not among the approvers cannot approve for them. When several stories wait on the same person, the
  "Waiting on you" list offers them together: tick the ones checked, one Approve, and each is decided
  exactly as if approved alone (a story with other approvers still waits for them). Asking for changes
  stays per story, since it needs a note about that story.
- **Suggested tests:** when a passing CI test looks like it covers a criterion, the manager links it.
  No manual case is drafted for that criterion.
- **Run tests:** the story's managers run the manual cases in the UAT environment and record Passed, Failed
  or Blocked. People with the UAT tester or product owner role may record too, but nothing waits on them.
  A failing test waits on the component manager.
- **Sign off:** the story's managers sign off; a product owner or an app owner may too. Sign-off is refused
  while any criterion is unverified. A sign-off with a gap needs a risk acceptance in Huddle.
- **Automate:** the story's managers; an automation engineer may do the work, but nothing waits on a role.
- **Analyse, again:** the flow's owner, when an analysis failed or a reviewer asked for changes.

## Chat and the flow: who keeps what

Chat is the convenient way in, for the session you are in. The flow is the record: its steps, every
approval, result and sign-off with names and times, and its timeline stay with the flow after it ends.
Nothing in chat is a copy of the flow's state: every flow card loads the flow live, so an old chat
shows today's progress, and acting in a card acts on the flow itself.

- **Start from chat:** "start UAT for the Ready for UAT stories", "start UAT for 24.11", "start a
  regression". The answer is a Start card listing the stories found, to untick. Nothing starts until a
  person presses Start; pressing it twice gives the same flow. After that, the card is the live flow.
- **Ask where it stands:** "where is the UAT for ABCD-1004?" answers with a sentence naming the step and
  who it waits on, and the live flow card. A story in no flow gets the usual readiness report.
- **What waits on me:** "what's waiting on me?" lists the flows with what each one needs from you.
- **Act in the card:** the stories waiting on you open in the card, with their review link, Passed,
  Failed and Blocked for testers, and the sign-off box.
- **The team thread:** every flow has one shared chat that every member of the application can read and
  write. The flow's events (started, analysed, results, sign-offs) appear in it by time, read from the
  flow's timeline. A question there ("what is blocked?", "where are we?") is about that flow; any other
  question gets the flow's state as a cited source. Team threads and the flow's analysis chats stay out
  of personal Recents; they are reached from the flow and its cards.

## What people see

- **Test flows** in the nav, under Testing, with a count of stories waiting on you.
- **Home** shows the flows in progress, with what waits on you.
- **The flow page** shows the four steps with "n of m stories" each, coverage at the start and now,
  a "Waiting on" list with you first, one row per story with its current step and the button that moves
  it on, and a timeline of who did what.
- **Opening a story** shows its steps, its criteria with Verified or not, the manual cases with
  Passed, Failed and Blocked buttons from the Run tests step on, and the sign-off box.
- **Starting a flow:** UAT picks stories from the Jira filter. Regression first shows coverage today per
  component and preselects every story with a gap.
- **After a sign-off** the story reads "Signed off · when · by whom" on the Tickets, Search and Start
  pages (and in its panel) instead of the gaps its analysis found, as long as nothing analysed it again
  since. Such a story is left out of "Select all" when starting a UAT flow; it can still be picked to
  retest it. Finished and cancelled flows stay on the Test flows page under "Finished and cancelled".

## Rules

- **The agent never passes a gate.** Analysis runs as a durable job, so a flow over many stories keeps
  going while nobody is signed in. Approvals, results and sign-off are people's decisions, recorded with
  who and when.
- **Who starts a flow:** the app owner, or a component manager for stories that touch their components.
- **One regression flow per application** at a time. UAT flows can run side by side.
- **One flow per story** of each kind at a time. Starting a flow (from the page, a retry, another tab,
  or chat) or adding a story to a flow is refused for a story already in an active or paused flow of
  that kind, naming that flow. The start page shows such stories with their flow and cannot pick them;
  in chat they are left out, and a request for only such stories answers with their flow. Cancelling
  or finishing the flow frees the story.
- **Owner controls:** the person who started it, or the app owner, can pause, resume, cancel, and add or
  remove stories. Every change is in the timeline.
- **A failed or blocked result needs a note**, and so does not signing off.
- **Stale sign-off:** if the evidence changes after a sign-off and a criterion is no longer verified,
  the story goes back to waiting for sign-off.

## Not built yet

- Opening the automation pull request from Catalyzt. Today "Draft automation" puts the request in the
  chat box for an engineer to send, and the step completes when an automated test is linked.
- Reminders and escalation for steps that wait too long.
- Approving or changing single cases, and versions of a case. Today the drafted cases of a story are
  approved together, or sent back together with a note.
- Asking the product owner for missing requirements from inside the flow. Today that is a concern raised
  in Huddle.
- Notifications when something new waits on you; today the nav count and Home show it on the next visit.

## Data

Migration 23 adds `flows`, `flow_items`, `flow_signoffs`, `flow_events` and `manual_executions`; 24 adds `flows.origin` (the chat answer a flow was started from); 25 adds `chats.flow_id` (team threads); 27 adds `approvals.note` (what a reviewer asked to change); 28 adds `flow_story_approvers` (people added to a story's review) and `flow_reviews` (one decision per required approver and proposal). Step
states are derived on each read from reports, approvals, test links and results.
