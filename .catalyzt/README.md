# Catalyzt demonstration workspace: Catalyzt itself

One application, `CATZ` (Jira project CATZ): Catalyzt is the application under test. Its own repository
(sspcodeflix/catalyzt) is the knowledge base for App Context (docs, components); the automation repository
(sspcodeflix/catalyzt-ui-tests) holds Playwright tests of the UI, one folder per capability, whose JUnit
results CI publishes as the `test-results` artifact for the regression flow.

The server is pointed here with `HORIZON_WORKSPACE=../.catalyzt` and its own database
`HORIZON_DB_PATH=data/catalyzt.db` (see `app/.env`). The earlier simulation workspace `.myworkspace` is
untouched; the Saleor application that lived here before is in git history (`.catalyzt/SALR`, removed on
8 Nov 2026) and its database was kept as `app/data/catalyzt-saleor.db`.

## People

| Person | Role |
|---|---|
| Ram Kumar (`u-ram`) | app owner |
| Nandini (`u-nandini`) | product owner |
| Brijesh (`u-brijesh`) | component manager: home, chat, flows |
| Sourav (`u-sourav`) | component manager: stories, hexa, app-context, huddle |

Everyone has the same access in the flows; the roles only say whose turn it is when a story has no
assignee.

## Capabilities (components)

Each capability maps to a folder of the automation repository. The regression flow counts the tests
there and their results in the newest merged build.

| Capability | Manager | Folder in catalyzt-ui-tests |
|---|---|---|
| home | Brijesh | tests/home |
| chat | Brijesh | tests/chat |
| flows | Brijesh | tests/flows |
| stories | Sourav | tests/stories |
| hexa | Sourav | tests/hexa |
| app-context | Sourav | tests/app-context |
| huddle | Sourav | tests/huddle |

## Files

- `personas.json`: the four people.
- `CATZ/team.json`: the application, its two repositories and the capabilities.
- `CATZ/stories.json`: the UAT backlog, stories about Catalyzt's own features.
- `CATZ/repos/`: shallow clones of both repositories for App Context (not committed).
