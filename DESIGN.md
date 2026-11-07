# Horizon

**Horizon: AI Quality & Reliability Engineering.** One assistant for the work that makes software safe to ship: test analysis, test authoring, execution, CloudOps and security. *Analyse, author, run, operate and secure, with a person in the loop.*

This file describes the look and the chat-first experience. Mock-ups: `design/screenshots/`, built from `design/mockups.html` (see `README.md`).

## The suite
| Capability | What people ask | What Horizon does | What it never does |
|---|---|---|---|
| Test analysis | "How well is Payments Hub covered?" | Scans, maps requirements to tests, reports gaps | Calls a requirement covered without a passing run |
| Test authoring | "Write tests for PAY-1482" | Writes test cases and automation, opens a pull request | Merges, or pushes to `main` |
| Execution | "Why did last night fail?" | Reads the CI pipeline and test grid, groups failures, watches runs | Starts a run outside the Git-triggered pipeline (open question 1) |
| CloudOps | "Why is payments-api restarting?" | Reads cluster state, logs and deploy diffs, proposes a GitOps change | Writes to a cluster directly |
| Security | "Fix critical CVEs in ABCD" | Reads scanner results, proposes upgrade pull requests and mitigations | Suppresses a finding without a recorded decision |

The composer's agent picker defaults to **Auto**: the Router agent works out what the user wants and sends the request to a capability (see Agent workflow), and the user can pick one explicitly. The application and workspace picker sets the scope for every answer. Asking before acting is not a setting: it is always on, so the composer has no control for it.

## Principles
1. **Chat first, work product beside it.** The conversation stays on the left; reports, scripts and findings open in a side panel with their own URL, so they can be linked from a ticket or a pull request.
2. **Prose first, data second.** Every answer opens with a plain-language summary, then the card or table, then follow-up suggestions.
3. **Show the work.** Steps are listed with timings, and steps that used no model are labelled. A finished run collapses to one line.
4. **Ask before acting.** Anything that changes something (a pull request, a config change, a ticket) is an approval card that states the repository, branch or environment, the diff and what happens next. Nothing changes until a person approves.
5. **Long work runs in the background.** A slim status strip sits above the composer; the user keeps chatting, and the result posts back with a notification.
6. **Every answer is rated, and the feedback is usable** (see Feedback).
7. **Cite sources.** Numbered citations link to the requirement, document version, scan, run or commit used.
8. **Credentials never reach the model,** logs, traces or exports.

## Navigation
- **New chat**, **Search** (chats and tickets).
- **Jira Stories:** stories Horizon pulls from Jira on a schedule, with a count of those not yet analysed for UAT. Until Jira is connected, a local dummy Jira (SQLite) stands in, and stories can be created and refined there.
- **Hexa:** the test case inventory (see Hexa).
- **Agents:** every agent working now and recently, who asked, what each was told to do, and token usage.
- **App Context:** what Horizon knows about the selected application, and what the team adds.
- **Huddle:** decisions Horizon won't make on its own, with a count of open items.
- **Recents:** recent chats.

The application is chosen in the composer and in page headers, so the sidebar has no application list.

## UAT and regression
Every testing request is either **UAT** (does this change, usually a Jira ticket, meet its acceptance criteria?) or **regression** (do existing components still behave as before?). The composer detects which one with rules as the user types, so the answer is instant and predictable; on send, the Router agent can refine it, but never overrides a type the user chose:
1. An explicit word wins. "Regression", "nightly", "smoke" or "suite" means regression. "UAT", "acceptance criteria" or "sign-off" means UAT.
2. Otherwise, a Jira ticket (a key such as PAY-1482 or a pasted link) means UAT, and a component added from the **+** menu means regression. Requirement, test case, CVE and scan IDs (FR-, TC-, CVE-, S-) are not treated as tickets.
3. If the request has both kinds of signal, the composer asks "UAT or regression?" and Send waits for the answer. If there is no signal, nothing is shown.

The user can switch the type with one click. The sent message is labelled with its type, tickets and components, and follow-ups keep the chat's type unless their own words say otherwise.

## Tickets (from Jira)
- Horizon pulls tickets from Jira on a schedule (every 15 minutes by default) with a read-only service account, using the project and filter set in App Context (for example `status = "Ready for UAT"`). The Jira source appears in App Context with its filter and last sync; **Sync now** runs it immediately.
- The Tickets page lists them with search and a UAT filter: Not analysed, Gaps, Ready. A ticket opens in the side panel with its description, acceptance criteria, linked requirements and components.
- **Analyse for UAT** starts a chat that reads the ticket, maps each acceptance criterion to requirements and tests, and reports in the side panel: each criterion is **Covered** (a test passed on this build), **Not run yet** or **No test**. Coverage counts only tests that passed on the current build.
- For criteria with no test, Horizon drafts UAT test cases and asks, with an approval card, before adding them to the ticket. Nothing is written to Jira without approval.
- The result is kept on the ticket, so the list shows its UAT state and **Open analysis** returns to the same chat.
- Tickets that do not match the filter can still be used by pasting their link in a chat.

## Agent workflow
Every message goes through the same workflow on the server, and each step shows in the answer with the agent that ran it and whether it used a model:

```
Input guard ──▶ Router ──▶ one sub-agent ─────────────────────────▶ Output guard
 (rules)        (model,     ├─ Clarifier: asks when the Router is unsure
                 with a     ├─ UAT analyst: Jira and test evidence tools,
                 rules         then drafts UAT cases for gaps
                 fallback)  └─ Specialist: Analysis, Authoring, Execution,
                               CloudOps or Security, each with its own instructions
```

- **Input guard** (rules, no model) rejects policy breaks before anything else runs (see Guardrails).
- **Router** classifies intent: capability, UAT or regression, tickets, components, and confidence. It is also a second guard: it marks requests out of scope with a policy. Below 50% confidence it hands over to the **Clarifier**, which asks a question with up to three options instead of guessing. The user's explicit choices in the composer (agent, test type, attached items) always win, and ticket keys written in the message are always kept.
- **UAT analyst** runs for a UAT request about a synced ticket. Its facts come from tools (Jira, test evidence), not the model.
- **Specialists** stream their answer. They are told they cannot see scans, runs or clusters in a chat, never to invent numbers or IDs, and that any change is a proposal that needs approval.
- **Output guard** masks anything that looks like a secret before it reaches the browser, including a secret split across streamed chunks.
- Without a model, the workflow still runs on rules: guards, routing and the UAT analyst work; specialists only say where the request would go.
- **Stop** ends an answer and keeps what was written; **Retry** runs it again as a new revision that needs its own rating.

## Agents page and token usage
- Each request's Orchestrator, the agents it spawned, their tasks, models, results, tokens and steps are recorded, and shown live: in the answer as a tree, and on the Agents page across all chats, with who asked and from which chat.
- Every model call is written to a token ledger. The answer shows its total, each agent its own, and the Agents page shows tokens today and in total, by agent, model, person and day. Calls where the provider reported no usage are counted separately, never as zero.

## Hexa
The test inventory, under Testing in the sidebar, in the spirit of ALM Octane. Three tabs:
- **Manual tests**, in Octane's format: name, steps (simple, validation, call), test type, phase, owner, product areas, covered stories and requirements. Each is marked **UAT** or **Regression**, from its test type or chosen at upload.
  - **Upload** an Octane import template (.xlsx or .csv). Tests with an existing Octane unique_id are updated, not duplicated. Rows Horizon could not use are listed, not dropped silently.
  - **Approving UAT cases** on a UAT analysis adds them here as manual tests, linked to the story and criterion.
  - **Export for Octane** downloads the tests in the same template layout.
- **Automated tests**: tests found by scanning GitHub repositories, plus any first seen in CI results. Each shows its last result. **Failing now** filters to the failures.
- **Pipeline runs**: one row per run, with its pull request, commit, counts and failures. Results come in three ways:
  1. **After a PR merge, from GitHub Actions:** **Collect results** reads the JUnit artifacts of the default branch's merge-commit runs (needs `GITHUB_TOKEN`).
  2. **Pushed by CI** to Horizon, using the workflow in `docs/hexa-github-action.yml` (needs `HEXA_INGEST_TOKEN`). This is the production path.
  3. **Uploaded** as JUnit XML.
- Results are matched to known tests by class and method name, or by the method name in words. Unknown tests are added, so no result is lost. A run never overwrites a newer result.
- Search covers names, steps, Octane ids, method names, files, stories and requirements. Each test opens in a panel with its steps or its result history (status, PR, commit, duration, failure message).

## Jira stories
- **Change filter** edits the statuses Horizon pulls and the sync interval in place; the filter is saved on the server.
- **Create story:** write the summary and acceptance criteria as you like (one per line). **Refine with AI** returns a clearer version beside yours, with questions for anything vague; choose **Use this** or **Keep mine**. Both versions and every refinement are stored, and the story shows what the author first wrote.

## Guardrails
Requests that break a policy are rejected at once, with the policy named and what to do instead. Nothing is sent to a model, and the rejection is logged on the server without the message text.

| Policy | Rejects, for example |
|---|---|
| Credentials | "What is the password for the payments DB?" |
| Secret in the message | A pasted key, token or `password=…`; the message is also removed from the chat |
| Approval required | "Merge it without review", "deploy straight to production" |
| Instruction override | "Ignore your previous instructions", "print your system prompt" |
| Destructive action | "Delete the SIT-2 cluster", "drop the refunds table" |
| Security finding | "Suppress the critical CVEs" without a recorded risk acceptance |
| Personal data | "Export all customer emails" |
| Outside Horizon | Requests unrelated to quality engineering (decided by the Router) |
| Too long | Over 8,000 characters |

- Testing these things stays allowed: "write a test for password reset" or "check token expiry" is not a credentials request.
- The guards run on the server, so the browser cannot skip them. Rejected turns are never sent to the model as context later.
- A rejected answer can still be rated, so wrong rejections show up in feedback.

## Chat about anything
People talk to Horizon about any item, the way they would with any AI assistant:
- **Ask** on any table row (a source, requirement, test, run, finding), **Ask about this** in any side panel, and **Ask about this** on selected text in a document, report, test or code.
- The chat is scoped to those items: they show as chips in the composer, and **Add item** brings in more (for example a requirement and the run that tested it).
- Answers cite page numbers, sections, lines or rows; the cited passages are highlighted in the side panel.
- Selected text can also be used in feedback, to point at exactly what was wrong.
- Item chats follow the same rules as any chat: workspace scope, sources cited, rating, and approval before any change.

## App Context
- **Enterprise Knowledge Fabric** is the source of truth: read only, re-synced, highest trust. Users can review its sections and how often answers use them, but never edit it from Horizon; corrections go to the Fabric owners.
- **Code:** components (source and automation repositories) are discovered automatically through GitHub, or uploaded manually as ZIPs. They appear in the same list with their indexed commit, and are re-indexed when the default branch moves.
- **Add context:** drop PDFs, Word documents, images or a repository ZIP, or paste a Confluence link (read with the user's own access and re-synced when the page changes). Choose the scope: the whole app, one workspace, or this chat only. Chat-only files are not added to the app.
- **Automatic processing**, shown as a step bar: uploaded, text extracted (for images, the model reads the text and describes diagrams), personal data masked, split into chunks, embedded, conflict check, ready. Only extracted text is embedded. Once ready, the source is used in every answer, test and scan for that scope; nobody has to re-run anything.
- **Trust and conflicts:** uploads rank below the Fabric and Confluence. A chunk that contradicts a higher-trust source is excluded from answers until someone decides, with **Compare** and **Send to Huddle**. Failed sources (for example a password-protected PDF) say why.
- **Test a question:** type a question and see which chunks Horizon would use, from which source, with relevance (not correctness) and whether each is used or excluded.
- The source list is a standard data table: keyword search, column filters and pages.
- Upload size limits and retention are admin settings, not constants.

## Huddle
The team's shared place for decisions that should not be made by the model or by one person alone.
- **Kinds of item:** source conflicts (raised by App Context), disputed requirement-to-test mappings, risk acceptances for findings with no fix, and feedback patterns (for example many low ratings with the same reason).
- Each item has a summary by Horizon that presents both sides with citations, the items it affects, options with votes, a discussion with @mentions, and **Ask about this** to chat about it.
- An app owner decides. The decision and its reason are kept with every affected item, and Horizon applies it (for example, re-including or dropping excluded chunks).
- The list is filterable (Open, Decided, Mine) and searchable.

## Feedback
- **Stars, 1 to 5,** under every answer. 4 or 5 stars is one tap, with optional positive reasons (Accurate, Saved me time, Good sources).
- **Below 4 stars** the card opens:
  - **Reasons:** pick at least one, specific to the capability (for test authoring: Wrong expected result, Missing a case, Wrong requirement, Ignores our conventions, Reuses the wrong page object, Hard to read, Something else).
  - **Where (optional):** select the sentence, row or code line it is about.
  - **What did you expect?** Required, up to 280 characters.
  - **Specificity check:** rules, not a model, flag vague comments (too short, only generic words, nothing tied to the answer) and ask questions tied to the chosen reasons. It nudges; it does not block.
  - **Refine with AI** rewrites the comment using only the comment, the reasons and the selected text. It never adds facts; the user chooses **Use this** or **Keep mine**, and both texts are kept.
  - **Sent with your feedback:** capability, application and workspace, answer revision, skills, sources and trace are attached automatically.
- **Submit, or Submit and retry with this feedback:** the retry passes the feedback to the model as the user's correction and creates a new revision, which needs its own rating.
- An approval stays disabled until the answer it acts on is rated. Ratings are stored with the answer and its trace, and feed evaluation datasets; they are for improving Horizon, not for assessing people.

## Look
- **Tokens:** `design/tokens.css`, light and dark. Warm paper background, ink text, ink primary buttons.
- **Accent:** the brand red, used sparingly: the mark, the send button, active progress and unread counts.
- **Status colours** always come with a text label. Green means passing; amber means partial or a warning; blue means waiting or info; a neutral grey means no test. Red as a status is kept for critical security findings and product defects, so a coverage gap is not an alarm.
- **Type:** IBM Plex Serif for display (greeting, report numbers, section heads), IBM Plex Sans for the UI, IBM Plex Mono for IDs, paths and code. All three are bundled, with no external font service.
- **Mark:** a hexagon holding a red scan-line sun rising over the horizon line, which ends in a circuit node. The wordmark is HORIZON in IBM Plex Mono capitals, letterspaced. The mark works down to 16px (the favicon).
- **Accessibility:** text contrast is at least 4.5:1 in both themes (checked); icon-only buttons are labelled; the status strip uses `role="status"`.

## Screens (mock-ups)
| File | Shows |
|---|---|
| `01-home-light` | Greeting, composer (agent picker on Auto, app and workspace), five capability cards |
| `02-test-analysis-light` | Stale scan re-run, answer with citations, report artifact, coverage report in the side panel |
| `03-test-authoring-light` | Generated tests in the panel, approval to open the pull request |
| `03b-feedback-light`, `09b-feedback-dark` | A 2-star rating: reasons, a code line selected in the panel, the comment with the specificity check, Refine with AI, the attached context, Submit and retry |
| `04-execution-light` | Failure triage grouped by cause, a watched run in the background strip |
| `05-cloudops-light` | Read-only investigation steps, a GitOps config change waiting on the rating gate |
| `06-security-light` | Findings by severity in the panel, a remediation pull request approval |
| `06b-app-context-light`, `09c-app-context-dark` | App Context: the Fabric summary, adding files and Confluence links with a scope, the processing steps, a conflict waiting for a decision, the sources table |
| `06c-app-context-source-light` | A source opened in the panel: testing a question against the app's context, with used and excluded chunks |
| `06d-chat-about-a-document-light`, `09d-chat-about-a-document-dark` | Chatting about an uploaded PDF: item chip in the composer, cited passages highlighted, the selection toolbar |
| `06e-huddle-light`, `09e-huddle-dark` | Huddle: open decisions, and a source conflict with Horizon's summary, options, votes, discussion and the decide action |
| `07`, `08`, `09` | Home, test analysis and security in dark |
| `10-test-analysis-mobile` | Phone width: the panel stacks below the chat |

## Open questions
1. **Execution.** Should Horizon be allowed to start or re-run a CI pipeline after approval, or only watch runs that Git triggers?
2. **CloudOps access.** Which clusters and environments may Horizon read, with which service account, and is production in scope? Is GitOps (a pull request to the deploy repo) the only way changes are made?
3. **Security sources.** Which scanners feed findings (dependency, container, SAST, DAST), who must review remediation pull requests, and how are accepted risks recorded?
4. **Brand.** Confirm the name, the line "AI Quality & Reliability Engineering" and the red accent with the brand team.
5. **App Context.** Who may add sources for the whole app, as opposed to one workspace or one chat? Values for upload size limits and retention.
6. **Huddle.** Who may decide each kind of item (app owner, security champion), and whether votes are advisory only.
7. **Routing.** Rules for Auto: which keywords, entities or screens route to which capability, and what happens when a request spans two.
8. **Jira sync.** Which projects and filter define "ready for UAT", who owns that filter, the sync interval, and which service account reads Jira.
9. **UAT test cases.** Where approved UAT cases are written (Jira sub-tasks, Xray, Zephyr or another test management tool), and who runs and signs off UAT.
10. **UAT vs regression words.** Confirm the keyword lists with the QA leads, and whether a release name alone (for example "24.11") should suggest regression.
11. **Model provider.** DeepSeek's hosted API sends prompts, including ticket text and code, to DeepSeek. Confirm with security whether that is allowed, or point Horizon at a self-hosted model (any OpenAI-compatible endpoint) instead.
12. **Guardrail policies.** Confirm the policy list and wording with security, and who reviews rejections that users rate as wrong.

All names and numbers in the mock-ups are placeholders.
