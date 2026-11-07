# POC plan: CloudOps and security remediation on public repositories

## Goal
Show that Horizon can find real problems in real code and infrastructure, explain them, and propose fixes that pass CI, without touching anything we own in production. Everything runs against public repositories, forks we control, and a throwaway local cluster.

## Can Horizon pull public GitHub repos and run through them?
Yes. Hexa already does the reading part today: give it `owner/repo` and it lists the tree, reads the test files and extracts test cases (a scan of `GoogleCloudPlatform/microservices-demo` found 43 Go and .NET tests in 6 files). The same access works for scanners and agents. Two rules keep it safe:
- **Read and scan, never execute the repo's code** on the Horizon host. Scanners read files and lockfiles. Anything that runs code (tests, builds, the app itself) runs in CI on our fork or inside the throwaway cluster.
- **Write only to forks** in a POC GitHub organisation, through a GitHub App with access to those forks only, and only after a person approves the change in Horizon.

## Candidate repositories
| Track | Repository | Why |
|---|---|---|
| CloudOps | `GoogleCloudPlatform/microservices-demo` (Online Boutique) | 11 services, Kubernetes manifests, Helm and Kustomize; easy to run in a local cluster and to break on purpose |
| CloudOps | `argoproj/argocd-example-apps` | GitOps layouts, to prove the "change by pull request" flow |
| CloudOps | `stefanprodan/podinfo` | Small, well-behaved service with probes and Helm, a good control |
| Security | `juice-shop/juice-shop` | Intentionally vulnerable Node app with outdated dependencies |
| Security | `WebGoat/WebGoat` | Intentionally vulnerable Java app (Maven), matches the Java test conventions in Hexa |
| Security | `OWASP/NodeGoat` | Smaller Node target for fast iterations |

## Security remediation flow
1. **Scan** a repo at a commit with off-the-shelf scanners in a sandboxed worker container:
   - OSV-Scanner or Trivy for vulnerable dependencies.
   - Semgrep (community rules) for code issues.
   - Gitleaks for committed secrets.
   - Trivy config for Dockerfiles and IaC.
2. **Store** findings in a new `security_findings` table (repo, commit, scanner, rule, package, version, fixed version, severity, file, line, status).
3. **Security agent** ranks them by severity, exploitability and whether a fix exists, groups by package, and proposes the smallest safe upgrade. Anything without a fix becomes a Huddle risk acceptance; nothing is suppressed.
4. **Approval card:** fork, branch, diff, and what CI will run. On approval, Horizon opens a PR on the fork.
5. **CI on the fork** (GitHub Actions) runs the repo's own tests. The result comes back to Horizon and is shown on the finding and in Hexa.
6. **Measure:** findings fixed by a PR that passes CI, wrong or unsafe proposals, time to fix, and tokens per fix.

## CloudOps flow
Two levels, so we get value before any cluster exists.
1. **Static review (week 1):** kube-linter, kube-score and Trivy config over the manifests and Helm charts. These catch missing resource limits and probes, `latest` image tags, privileged containers and missing network policies. The CloudOps agent explains each one and proposes a manifest change as a PR on the fork.
2. **Live investigation (week 2):** a local kind (or k3d) cluster running Online Boutique and Argo CD, synced from our fork. We inject known faults:

   | Fault | How | What the agent should conclude |
   |---|---|---|
   | Memory pressure | Lower a memory limit | OOMKilled restarts |
   | Bad rollout | Push an image tag that doesn't exist | ImagePullBackOff |
   | Failing readiness probe | Break the probe | Traffic drops |
   | Bad config | Wrong environment variable | Crash loop |

   The CloudOps agent gets **read-only tools**: get and describe pods, events, logs, and the deploy diff from Git. It works out the cause, then proposes the fix as a GitOps PR to the fork. Argo CD applies the fix after a person merges it. Horizon never has write access to the cluster.
3. **Measure:** correct root cause per injected fault, time to diagnosis, fixes that recover the service after merge, and tokens per incident.

## Hexa and test writing
Giving Horizon the repositories is the right move. The inventory becomes the base for writing tests:
1. **Inventory (built):** scan repos for existing tests; UAT analyst proposals are added as proposed cases.
2. **Link tests to what they cover:** a model-assisted pass suggests which story, acceptance criterion or requirement each scanned test covers, with confidence. A person confirms in Hexa. Today scanned tests start unlinked.
3. **Gaps:** criteria and requirements with no linked, passing test.
4. **Authoring agent** writes tests for the gaps in the repo's own framework and style, learned from the scanned tests. It opens them as a PR on the fork after approval.
5. **Results:** CI runs the new tests and writes results back as `test_runs`, so Hexa shows passed, failed or not run for real.

## What the data model needs next
- `security_findings`.
- `pull_requests`: fork, branch, status, CI result, and its link to an approval.
- `test_runs`, plus a `last_result` on each test case that comes from real runs.
- `cluster_events`: what the CloudOps agent observed, with the time.

These follow the same rules as the rest of the model in [DATA_MODEL.md](DATA_MODEL.md): every row has an owner and a time, and agents are recorded as actors.

## Do we need a FastAPI backend?
**Not for the POC, and probably not at all.** Recommendation:
- **Keep the API in TypeScript.** The browser and server share the same intent, guardrail and workflow code today (`app/src/lib`). That is why the guards and the UI never disagree. A Python backend would duplicate it.
- **Move `/api` out of the Vite dev server** into a standalone Node service (Fastify or Hono) before anyone else uses it. This is a small move, because `server/api.ts` is already plain Node middleware.
- **Run scanners and cluster tools as separate worker containers** fed by a job queue. They are command-line tools, so the language of the API doesn't matter to them.
- **Choose FastAPI only if** the team is Python-first, or we adopt a Python-only agent framework or ML component. The cost is rewriting about 1,500 lines of server code and keeping the API and UI types in step with OpenAPI code generation.

## Replacing the dummy Jira later
The dummy Jira is SQLite behind four operations: list stories by filter, get a story, create a story, and sync. Real Jira replaces those with the Jira REST API (a JQL search and issue create) using a read-only service account, plus a write scope only for approved actions. The `stories` table stays as the local cache that sync fills, so the Jira Stories page, Hexa links, the UAT analyst and refinement history keep working unchanged.

## Suggested order
| Week | Deliverable |
|---|---|
| 1 | Scanner worker and `security_findings`; Security agent proposals; GitHub App and fork PRs; static manifest review |
| 2 | kind cluster with Online Boutique and Argo CD; read-only CloudOps tools via DeepSeek function calling; fault scenarios |
| 3 | Hexa linking and gaps; Authoring agent test PRs; `test_runs` from fork CI; evaluation report (accuracy, fixes passing CI, tokens and cost per task) |

## Decisions needed
1. A GitHub organisation for POC forks, and who owns the GitHub App.
2. Whether prompts that include public-repo code may go to DeepSeek's hosted API, or should use a self-hosted model from the start.
3. A machine for the kind cluster (8 CPU, 16 GB is comfortable for Online Boutique plus Argo CD).
