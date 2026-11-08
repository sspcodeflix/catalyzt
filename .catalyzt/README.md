# Catalyzt demonstration workspace: Saleor

One application, `SALR` (Jira project SALR), built on the public repository saleor/saleor so that the
UAT and regression flows can be shown end to end on real code, real tests and real CI results
(the `Tests` workflow uploads JUnit XML as the `pytest-results` artifact on every merge to main).

The server is pointed here with `HORIZON_WORKSPACE=../.catalyzt` and its own database
`HORIZON_DB_PATH=data/catalyzt.db` (see `app/.env`); the earlier simulation workspace `.myworkspace`
and `data/horizon.db` are untouched and one env change away.

## People

| Person | Role |
|---|---|
| Ram Kumar (`u-ram`) | app owner |
| Nandini (`u-nandini`) | product owner |
| Brijesh (`u-brijesh`) | component manager: checkout, payment, giftcard, account |
| Sourav (`u-sourav`) | component manager: order, product, discount, warehouse |

## Components

| Component | Manager | Path in saleor/saleor | Tests |
|---|---|---|---|
| checkout | Brijesh | saleor/checkout | pytest |
| payment | Brijesh | saleor/payment | pytest |
| giftcard | Brijesh | saleor/giftcard | pytest |
| account | Brijesh | saleor/account | pytest |
| order | Sourav | saleor/order | pytest |
| product | Sourav | saleor/product | pytest |
| discount | Sourav | saleor/discount | pytest |
| warehouse | Sourav | saleor/warehouse | pytest |

## Files

- `personas.json`: the four people.
- `SALR/team.json`: the application, its repository and components.
- `SALR/stories.json`: the backlog for the demonstrations (Ready for UAT, fix version `demo`).
- `SALR/repos/`, `SALR/results/`: the clone and local CI output (not committed).
