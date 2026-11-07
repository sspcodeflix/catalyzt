# Simulation plan: three real teams using Catalyzt

## Goal
Replace every placeholder with data that behaves like the real thing, then have agents use Catalyzt the way three application teams would, for a week of work, and fix what breaks. The outcome is a stable app and a list of what was found and what was done about it.

## The teams

| Application | Owner | Component managers | Portfolio |
|---|---|---|---|
| ABCD, Ram's Portfolio | Ram Kumar | Sourav, Brijesh | Online Boutique microservices, moov-io ACH |
| IBGM, Nabih's Portfolio | Nabih Ben Lagha | Mohd Sayeer, Karim | PiggyMetrics, OWASP Juice Shop (scan only) |
| WIMT, Jacques's Portfolio | Jacques | Hitesh, David, Robin | Ghostfolio, Spring PetClinic |

Eleven people, two roles besides member: **app owner** (decides Huddle items, sets the Jira filter, approves changes for the whole app, watches token usage) and **component manager** (new role: owns components, writes and refines stories, authors and uploads tests, runs UAT analyses, approves changes to their components, raises Huddle items).

## Decisions needed before starting

1. ~~What are ABCD, IBGM and WIMT?~~ Decided: they are the owners' portfolios of public repositories, named after the owner, with no invented domain.
2. **Credentials.** A real `DEEPSEEK_API_KEY` makes the simulation exercise the model paths (routing, answers, refinement). Without it, the agents only test the rules paths and the specialists return placeholders. A `GITHUB_TOKEN` lets "Collect results" read GitHub Actions; without it, CI is simulated by a local runner that pushes results (realistic enough). Recommendation: DeepSeek key yes, GitHub token optional.
3. **Depth of the persistence work.** Chat answers, ratings, approvals, App Context and Huddle still live in the browser and vanish on reload. A multi-user simulation is meaningless without moving them to the server. Recommendation: do it first (phase 3). It is the largest single piece of work, about two days of focused effort.
4. **Git.** Nothing has ever been committed. Recommendation: commit the current state now on `main`, then one commit per phase, so the simulation's fixes are reviewable.

## Repositories (tentative, pending decision 1)

Chosen for domain fit, test suites that run without a cloud account, and a mix of languages so the scanner, result matching and CI runner are all exercised.

| Team | Repository | Why | Components (manager) |
|---|---|---|---|
| ABCD | `GoogleCloudPlatform/microservices-demo` (37 MB, Go/C#/Java/Node/Python) | Checkout, payment, cart, currency: a payments flow; 43 tests already found by Hexa | frontend, cartservice (Sourav); checkoutservice, paymentservice, currencyservice (Brijesh) |
| ABCD | `moov-io/ach` (64 MB, Go) | Payments file format with a large, fast test suite | ach-core (Brijesh) |
| IBGM | `sqshq/piggymetrics` (1 MB, Java Spring Cloud) | Account, statistics and notification services with gateway and auth: a small banking shape | account-service, auth-service (Mohd Sayeer); statistics-service, notification-service, gateway (Karim) |
| WIMT | `ghostfolio/ghostfolio` (111 MB, Angular + NestJS) | Open-source wealth management: portfolios, orders, market data; Jest tests | api (Hitesh); client (David); common libs, infrastructure (Robin) |
| Security track, one team | `juice-shop/juice-shop` (314 MB, Node) | Intentionally vulnerable, for the Security agent scenarios in POC_PLAN.md | optional; add to the team you choose |

Alternative for IBGM if you want a real core banking system: `apache/fineract` (128 MB, Gradle, slow to build). Not recommended for a POC.

Clones are shallow (`--depth 50`, enough merge history to simulate pull request merges) and git-ignored.

## Workspace layout

```
.myworkspace/
  personas.json              # the 11 people: id, name, initials, email, role, app, components
  ABCD/ IBGM/ WIMT/
    team.json                # app id, name, Jira project key, owner, managers, components -> repo + path
    repos/<name>/            # shallow clones (git-ignored)
    stories.json             # the team's backlog, written from each repo's real features and issues
    manual-tests.xlsx        # Octane-format tests the team "wrote"
    results/<run>/*.xml      # JUnit from the local CI runner, one folder per simulated merge
    log/
      scenario-<persona>.md  # what the agent did, step by step
      issues.md              # every bug and friction point, with repro steps and severity
ISSUES.md                    # consolidated, prioritised, with what was fixed
```

The server reads the workspace at start-up (`HORIZON_WORKSPACE=.myworkspace`) and seeds applications, people, memberships, components, Jira filters and stories from it. With no workspace, Catalyzt starts empty and says so. No fake data anywhere.

## Phases

### 1. Workspace and clones (half a day)
- Scaffold the folders, `personas.json` and the three `team.json` files.
- Clone the repositories shallowly.
- Write each team's backlog (10 to 15 stories per app) from the repos' real features, open issues and READMEs, with acceptance criteria. Mark which are UAT (feature) and which are regression (hardening).
- Write 5 to 10 manual tests per team in the Octane template.

### 2. Remove the dummy content and make Catalyzt multi-app (one day)
- Delete the seed data: Payments Hub, PAY-xxxx stories, Priya and colleagues, the placeholder coverage map, the sample chat, the hard-coded recents, the seeded App Context sources and Huddle items.
- Seed from the workspace instead.
- Replace `DEFAULT_APP` with the selected application everywhere: Jira Stories, Hexa, Agents, App Context, Huddle, usage and chats are all scoped to the app in the composer's picker. People see the apps they belong to.
- Add the `component_manager` role and permission checks on the server: who can decide, approve, change the filter, upload.
- Add **Sign in as** (clearly marked as POC-only, replacing SSO): a picker that sets the user for the browser session; the server trusts it the way it trusts the header today. Each simulated persona uses it.

### 3. Persist what still lives in the browser (two days)
- Chats, messages, answer revisions, ratings, approvals and artifacts move to SQLite through the existing tables. The chat store becomes an API client; the sidebar's Recents come from the database.
- App Context sources, processing, conflicts and Huddle items, votes, comments and decisions move the same way.
- Reloading, switching users and opening the same chat from two browsers all keep working.
- The feedback form for ratings below 4 stars (reasons, where, what did you expect, refine) is still not built; the simulation will record it as a gap unless we add it here. Recommendation: add a minimal version (reasons plus comment), since rating is central to the design.

### 4. Real test evidence (one day)
- **Local CI runner** (`scripts/ci-run.sh`): runs a repo's tests in its toolchain's Docker image (Go, Maven, Node, pytest), converts output to JUnit XML, and pushes it to Hexa as a merge-commit run, using real pull request numbers from the clone's merge history. Lets us simulate "PR merged, pipeline ran" without GitHub Actions.
- **UAT readiness from results:** a criterion is covered when a linked test passed in the latest merge run, not run when a linked test has no result, no test otherwise. The placeholder coverage map goes.
- **Linking:** component managers link scanned tests to stories and criteria in Hexa (a link action in the test panel), and the UAT analyst reads those links.

### 5. The simulation (one day of agent time)
- **Three agents, one per team, run in parallel**, each playing its owner and managers in turn through Sign in as. Parallel teams exercise multi-app scoping and concurrent agent runs.
- Each agent drives the real UI with Playwright, falling back to the API only where the UI has no path (for example the CI push). It follows a scenario script but is told to explore, and to record every bug, confusing moment and missing feature in `log/issues.md` with repro steps and a severity (blocker, major, minor).
- Owner scenario: set up App Context (components, a Confluence link, a document upload), set the Jira filter, review the backlog, run a UAT analysis, approve UAT cases, decide a Huddle conflict, review Agents and token usage, try something a guardrail should reject.
- Manager scenario: create and refine stories, attach a story and ask for UAT readiness, ask a regression question with a component attached, author tests for a gap and inspect the approval card, scan the repo in Hexa, upload Octane manual tests, run the local CI runner and check the results landed on the right tests, rate answers high and low, raise a Huddle item, open the same chat after a reload and from a second sign-in.
- Cross-team checks: one agent tries to see another team's app, stories and chats.

### 6. Fix and re-run (one to two days)
- Consolidate the three issue logs into `ISSUES.md`, prioritised. Fix blockers and majors, re-run the affected scenarios, and record the outcome per issue.
- Update DESIGN.md, DATA_MODEL.md and README.md to match.

## What you get at the end
- Catalyzt with no placeholder data, three real applications, eleven people with roles, everything persisted, UAT readiness driven by real test results.
- `.myworkspace/` as a reusable fixture: swap `team.json` and the backlog for your real teams later.
- `ISSUES.md`: everything the simulation found, what was fixed, what is left and why.
- Scenario logs showing how each persona used the app, useful for onboarding and for the Jira and SSO integrations later.

## Risks
- **Persistence refactor** is the biggest piece and touches most of the UI; it goes first so the simulation tests the real thing.
- **Large repositories:** Juice Shop and Ghostfolio have slow installs; the CI runner uses Docker images with cached layers, and we can cap which test projects run.
- **PiggyMetrics on Java 21:** it targets an older Java; tests run in a Java 8 Maven image instead.
- **Model cost:** three agents plus the Catalyzt model calls; the token ledger will show the spend, and the simulation can run rules-only if needed.
- **GitHub API rate limits:** cloning is git, not the API, so scans and clones are fine; "Collect results" needs the token.
