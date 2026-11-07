# Who owns what in the simulation

Each application is its owner's portfolio of public repositories, chosen so the simulation covers several languages and test frameworks. The codes ABCD, IBGM and WIMT are the application ids and Jira project keys; the repositories give each component its real code and tests.

## ABCD, Ram's Portfolio: owner Ram Kumar (`u-ram`), Jira project ABCD
Online Boutique microservices and the moov-io ACH library. Workspaces: online-boutique, ach.

| Component | Manager | Repository | Path | Language | Tests |
|---|---|---|---|---|---|
| frontend | Sourav | GoogleCloudPlatform/microservices-demo | src/frontend | Go | go test |
| cartservice | Sourav | microservices-demo | src/cartservice | C# | xUnit (.NET) |
| paymentservice | Sourav | microservices-demo | src/paymentservice | Node.js | none in repo |
| currencyservice | Sourav | microservices-demo | src/currencyservice | Node.js | none in repo |
| shippingservice | Sourav | microservices-demo | src/shippingservice | Go | go test |
| checkoutservice | Brijesh | microservices-demo | src/checkoutservice | Go | go test |
| productcatalogservice | Brijesh | microservices-demo | src/productcatalogservice | Go | go test |
| adservice | Brijesh | microservices-demo | src/adservice | Java | JUnit (Gradle) |
| emailservice | Brijesh | microservices-demo | src/emailservice | Python | pytest |
| recommendationservice | Brijesh | microservices-demo | src/recommendationservice | Python | pytest |
| ach-core | Brijesh | moov-io/ach | . | Go | go test (large suite) |

## IBGM, Nabih's Portfolio: owner Nabih Ben Lagha (`u-nabih`), Jira project IBGM
PiggyMetrics microservices and OWASP Juice Shop. Workspaces: piggymetrics, juice-shop.

| Component | Manager | Repository | Path | Language | Tests |
|---|---|---|---|---|---|
| account-service | Mohd Sayeer | sqshq/piggymetrics | account-service | Java (Spring Boot) | JUnit (Maven) |
| auth-service | Mohd Sayeer | piggymetrics | auth-service | Java | JUnit (Maven) |
| config | Mohd Sayeer | piggymetrics | config | Java | none in repo |
| registry | Mohd Sayeer | piggymetrics | registry | Java | none in repo |
| statistics-service | Karim | piggymetrics | statistics-service | Java | JUnit (Maven) |
| notification-service | Karim | piggymetrics | notification-service | Java | JUnit (Maven) |
| gateway | Karim | piggymetrics | gateway | Java | none in repo |
| customer-portal | Karim | juice-shop/juice-shop (scan only, not cloned) | . | TypeScript | Mocha, Jasmine, Cypress, Frisby |

## WIMT, Jacques's Portfolio: owner Jacques (`u-jacques`), Jira project WIMT
Ghostfolio and the Spring PetClinic microservices. Workspaces: ghostfolio, petclinic.

| Component | Manager | Repository | Path | Language | Tests |
|---|---|---|---|---|---|
| portfolio-api | Hitesh | ghostfolio/ghostfolio | apps/api | TypeScript (NestJS) | Jest |
| portfolio-client | David | ghostfolio | apps/client | TypeScript (Angular) | Jest |
| ui-lib | David | ghostfolio | libs/ui | TypeScript | Jest |
| common-lib | Robin | ghostfolio | libs/common | TypeScript | Jest |
| platform | Robin | ghostfolio | prisma | TypeScript | none in repo |
| customers-service | Robin | spring-petclinic/spring-petclinic-microservices | spring-petclinic-customers-service | Java 17 | JUnit 5 (Maven) |
| visits-service | Robin | petclinic | spring-petclinic-visits-service | Java 17 | JUnit 5 (Maven) |
| vets-service | Hitesh | petclinic | spring-petclinic-vets-service | Java 17 | JUnit 5 (Maven) |
| api-gateway | Hitesh | petclinic | spring-petclinic-api-gateway | Java 17 | JUnit 5 (Maven) |

## Coverage of technologies
Go (go test), C# (.NET xUnit), Java 8 and 17 (JUnit via Maven and Gradle), Python (pytest), TypeScript (Jest, and Mocha/Cypress on the scan-only portal). Node.js services with no tests are included on purpose: they are the gaps the agents should find.

## Files
- `personas.json`: the ten people, their roles and apps.
- `<APP>/team.json`: what Horizon seeds for each application.
- `<APP>/stories.json`, `<APP>/manual-tests.csv`: the team's backlog and manual tests (phase 1).
- `<APP>/results/`: JUnit output from the local CI runner (phase 4, not committed).
- `<APP>/log/`: scenario transcripts and `issues.md` from the simulation (phase 5).
