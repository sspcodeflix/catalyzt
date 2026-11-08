# WIMT backlog notes

Team WIMT, "Jacques's Portfolio". Backlog written from the two clones by reading files and `git log`/`git show`; no code was built or run by me and no network was used.

- `repos/ghostfolio`: HEAD `bdf122a` (2026-11-07, 50 commits in the shallow clone back to `b633b1f` on 2026-10-31), tags `3.95.0`, `3.96.0`, `3.97.0`, `3.98.0`; `package.json` version `3.98.0`; `CHANGELOG.md` has an `Unreleased` section. Older CHANGELOG entries (3.94.0, 3.93.0) are quoted from the file; their commits are not in the clone, so those stories cite the current code instead of a hash.
- `repos/petclinic`: HEAD `e8b747a` (2026-10-19, 50 commits in the clone), tags `v3.2.0` and `v3.4.1` (24 commits behind HEAD); root `pom.xml` version `4.0.1` on Spring Boot `4.0.1`, Java 17.

The local CI run of petclinic (`results/petclinic/local-e8b747a-maven-a1-20261107T225733`, `maven:3.9-eclipse-temurin-17`, exit 0, 95 s) produced 10 JUnit files with 19 test cases, 0 failures. The test class and method names below are taken from those files and from the `src/test` folders; where a criterion is covered by one of them, it is named so it can be linked in Hexa. Ghostfolio's Jest specs are named too (from the repository), but they have not been run here.

## fixVersion scheme

- Ghostfolio tags its releases by semantic version (`3.98.0` on 2026-11-04 is the latest). Everything merged after that tag or still open is placed in the plausible next release `3.99.0` (not a tag yet; the CHANGELOG calls it `Unreleased`). Released changes keep the version their CHANGELOG entry sits under (`3.97.0`, `3.94.0`, `3.93.0`).
- Petclinic tags follow the Spring Boot line it runs on (`v3.2.0`, `v3.4.1`). HEAD is on Spring Boot 4.0.1 with `pom.xml` version 4.0.1 and no 4.x tag, so every petclinic item uses the plausible next tag `v4.0.1`. This is an assumption; the team may prefer `v4.0.0`.

## Stories

### WIMT-1001 Account balance note through the accounts API (portfolio-api, platform, common-lib), In Progress
- Commit `bdf122a` "Feature/note for account balances (#8416)" (Thomas Kaul, 2026-11-07), 21 files
- `apps/api/src/app/endpoints/accounts/accounts.controller.ts` (`POST :id/balances`, `GET :id/balances`, `DELETE :id/balances/:balanceId`), `account-balance.controller.ts` (deprecated `POST account-balance`, also takes `comment`)
- `apps/api/src/services/account-balance/account-balance.service.ts` (`createOrUpdateAccountBalance`: upsert on `accountId_userId_date`, "A missing comment keeps the comment of an existing account balance"; `getAccountBalances` selects `comment`)
- `libs/common/src/lib/dtos/create-account-balance.dto.ts` (`@IsOptional @IsString @MaxLength(COMMENT_MAXIMUM_LENGTH)`, trim transform, `IsValidAccountBalanceDateConstraint`), `account-balance.dto.ts` (import shape), `libs/common/src/lib/config.ts` (`COMMENT_MAXIMUM_LENGTH = 2000`, `'balances[*].comment'` in `DEFAULT_REDACTED_PATHS`)
- `libs/common/src/lib/helper.ts` (`isValidAccountBalanceDate`, `isAccountBalanceInFuture` against the start of tomorrow in UTC), `validator-constraints/is-valid-account-balance-date.ts` (message `$property must be a valid date which is not in the future`)
- `apps/api/src/app/endpoints/export/export.service.ts` (comment written only when set), `apps/api/src/app/endpoints/import/import.controller.ts` (`POST`, `dryRun` query), `test/import/ok/sample.json` (balance with `"comment": "Deposit of the annual savings"` and one with `null`)
- Tests (not run): `apps/api/src/services/import/import-data.dto.spec.ts` "refuses a comment of an account balance which exceeds the maximum length" (AC3 message), `apps/api/src/helper/object.helper.spec.ts` "should redact the account balances of a response", `libs/common/src/lib/helper.spec.ts` "Is valid account balance date" (five cases behind AC4), `libs/common/src/lib/validator-constraints/is-valid-account-balance-date.spec.ts`

### WIMT-1002 MCP OAuth discovery documents (portfolio-api), Ready for UAT
- Commit `157e425` "Feature/support MCP OAuth discovery and metadata endpoints (#8401)" (Kenrick Tandrian, 2026-11-06)
- `apps/api/src/app/endpoints/oauth/oauth-metadata.controller.ts` (`@Controller('.well-known')`, `GET oauth-protected-resource/mcp`, `GET oauth-authorization-server`, `VERSION_NEUTRAL`, `NotFoundException` when disabled)
- `apps/api/src/helper/mcp-oauth.helper.ts` (`getMcpAuthorizationServerMetadata` with the endpoint URLs and supported values quoted in AC1, `getMcpOAuthBaseUrl` strips trailing slashes, `isMcpOAuthEnabled`, `isValidMcpOAuthIssuerUrl`)
- `apps/api/src/middlewares/mcp-authorization.middleware.ts` (`sendUnauthorizedResponse`: `realm="Ghostfolio"`, `resource_metadata=...`, `error="invalid_token"`, body message "A valid access is required as a bearer token"), `libs/common/src/lib/config.ts` (`MCP_ENDPOINT = '/mcp'`, `MCP_REALM = 'Ghostfolio'`)
- `apps/api/src/main.ts` (`.well-known{/*wildcard}` excluded from the `api` prefix, the warning text of AC5, middleware mounted on `MCP_ENDPOINT`)
- Tests (not run): `oauth-metadata.controller.spec.ts` ("returns RFC 9728 protected resource metadata when feature flags are enabled" gives the exact body of AC2, "normalizes ROOT_URL with trailing slash", three `NotFoundException` cases per endpoint), `mcp-oauth.helper.spec.ts`, `mcp-authorization.middleware.spec.ts` ("returns 401 challenge with only realm when token is missing and OAuth is disabled", "...with resource_metadata when token is missing and OAuth is enabled", "returns 401 with invalid_token when token is invalid and OAuth is enabled")

### WIMT-1003 Checkout button without a price id (portfolio-client, portfolio-api), Bug, In Progress
- Commit `4fc9c2f` "Bugfix/visibility of checkout button without price id (#8383)" (2026-11-05): `apps/client/src/app/components/user-account-membership/user-account-membership.html` and `apps/client/src/app/pages/pricing/pricing-page.html` add `user?.subscription?.offer?.priceId` to the `@if` around the "Upgrade Plan" / "Renew Plan" button
- Commit `6248dba` "Bugfix/validation of missing price id in Stripe checkout session (#8379)" (2026-11-02, CHANGELOG 3.97.0): `apps/api/src/services/subscription/subscription.service.ts` throws `BadRequestException('Invalid priceId')`
- `apps/api/src/app/endpoints/subscription/subscription.controller.ts` (`POST stripe/checkout-session`, logs the error and answers 400 Bad Request), `user-account-membership.component.ts` (`onCheckout` redirects to `sessionUrl`), `libs/ui/src/lib/services/data.service.ts` (`createStripeCheckoutSession`)
- Related: commit `82fdf82` "Feature/Max plan on pricing page (#8376)" reshaped `pricing-page.html`

### WIMT-1004 Double submission of dialog forms (portfolio-client, ui-lib), Bug, Ready for UAT
- CHANGELOG 3.94.0 (2026-10-28) "Fixed the double submission of forms in the account detail dialog, the create or update access dialog, the historical market data editor, the import activities dialog, the coupon system and the create asset profile dialog of the admin control panel"; the commits are older than the clone
- `apps/client/src/app/components/account-detail-dialog/account-detail-dialog.component.ts` (`isSubmitting` signal, `onAddAccountBalance` with `finalize`), `account-detail-dialog.html` (`[isSubmitting]="isSubmitting()"`), `libs/ui/src/lib/account-balances/account-balances.component.html` (`[disabled]="accountBalanceForm.invalid || isSubmitting()"`)
- `apps/client/src/app/components/user-account-access/create-or-update-access-dialog/create-or-update-access-dialog.component.ts` and `.html` (`(keyup.enter)="accessForm.valid && !isSubmitting() && onSubmit()"`), `apps/client/src/app/pages/portfolio/activities/import-activities-dialog/`, `apps/client/src/app/components/admin-market-data/create-asset-profile-dialog/` (all carry `isSubmitting`)
- No client spec files exist (`apps/client/src` has 0 `*.spec.ts`)

### WIMT-1005 Filter activities by type (ui-lib, portfolio-client, portfolio-api), Ready for UAT
- CHANGELOG 3.93.0 (2026-10-25) "Moved the support for filtering by activity type on the activities page from experimental to general availability"; commit older than the clone
- `apps/client/src/app/pages/portfolio/activities/activities-page.html` (`[hasPermissionToFilterByType]="true"`, `[activityTypes]="user?.activityTypes"`), `activities-page.component.ts` (`onTypesFilterChanged`, `fetchActivities` with `activityTypes`)
- `libs/ui/src/lib/activities-table/activities-table.component.html` ("Type" `mat-select multiple`, shown only when `hasPermissionToFilterByType && activityTypeOptions().length > 1`, inside `d-none d-lg-flex`), `activities-table.component.ts` (`activityTypeOptions` sorted by translated label)
- `libs/ui/src/lib/services/data.service.ts` (`fetchActivities` appends `activityTypes` joined by commas), `apps/api/src/app/endpoints/activities/activities.controller.ts` (`getAllActivities` passes `types: activityTypes`), `apps/api/src/services/user/user.service.ts` (`activityTypes` from the grouped activities)

### WIMT-1006 Note field in the account balances form (ui-lib, portfolio-client), To Do
- `libs/ui/src/lib/account-balances/account-balances.component.ts` (`displayedColumns` already `date, value, comment, actions`; `onOpenComment` alert; `accountBalanceForm` has only `balance` and `date`; `onSubmitAccountBalance` validates with `CreateAccountBalanceDto`), `.html` (comment column `d-none d-lg-table-cell`, note button `title="Note"`, `document-text-outline`)
- Same API and DTO files as WIMT-1001; the gap (no input for the note) is observed in the current code, hence To Do

### WIMT-1007 AccountBalance migrations (platform, portfolio-api), Task, Done
- `prisma/migrations/20261014000000_added_user_id_to_unique_constraint_of_account_balance/migration.sql` (drop `AccountBalance_accountId_date_key`, create `AccountBalance_accountId_userId_date_key`), `prisma/migrations/20261107000000_added_comment_to_account_balance/migration.sql` (commit `bdf122a`)
- `prisma/schema.prisma` (`model AccountBalance`: `comment String?`, `@@unique([accountId, userId, date])`), `docker/entrypoint.sh` (`npx prisma migrate deploy`)
- CHANGELOG 3.93.0 "Fixed a race condition in the creation of an account balance"; the link between that entry and the 20261014 migration is inferred from dates and from the upsert key in `account-balance.service.ts`

### WIMT-1008 Grantee validation of an access (common-lib, portfolio-api), Done
- CHANGELOG 3.94.0 "Fixed an issue where users could grant a private access to themselves"; commit older than the clone
- `libs/common/src/lib/helper.ts` (`isValidGranteeOfAccess`), `apps/api/src/app/endpoints/accesses/accesses.controller.ts` (`createAccess`: 403 for Basic with subscription, 400 for MCP without the flag, 400 from `isValidGranteeOfAccess`, type derived from `granteeUserId`), `libs/common/src/lib/dtos/create-access.dto.ts` (`IsInTheFutureConstraint` on `expiresAt`, `@IsIn(Object.values(scopes))`), `libs/common/src/lib/scopes.ts` (`SCOPES_OF_TYPE.PUBLIC` = `activity:read`, `portfolio:read`; `getScopesOfAccess` drops the rest)
- Tests (not run): `libs/common/src/lib/helper.spec.ts` "Is valid grantee of access" (7 cases, including "A private access with its owner as grantee"), `libs/common/src/lib/scopes.spec.ts` "Get scopes of public access"

### WIMT-1009 Pet update by path id (customers-service, api-gateway), Ready for UAT
- Commit `e8b747a` "Fix pet updates to use path identifier" (Vinod Kumar, 2026-10-19): `PetRequest.java` (record without `id`), `PetResource.java` (`processUpdateForm(@Valid @RequestBody PetRequest, @PathVariable("petId") @Min(1) int petId)`), `PetFormPage.js` (no `id` in the payload), `genai/dto/PetRequest.java`, `PetResourceTest.java` (+57 lines)
- `spring-petclinic-customers-service/src/main/java/.../web/PetResource.java` (`POST /owners/{ownerId}/pets` 201, `PUT /owners/*/pets/{petId}` 204, `GET owners/*/pets/{petId}`), `ResourceNotFoundException.java` (`@ResponseStatus(NOT_FOUND)`), `web/PetDetails.java` (`owner` = first + last name), `db/hsqldb/data.sql` (owner 2 Betty Davis, pet 2 Basil type 6, pet 5 Iggy)
- Tests, passed in the local run (`TEST-org.springframework.samples.petclinic.customers.web.PetResourceTest.xml`): `PetResourceTest.shouldUpdatePetUsingPathIdWithoutBodyId` (AC1, AC5), `PetResourceTest.shouldReturnNotFoundWhenUpdatingNonexistentPathPet` (AC3), `PetResourceTest.shouldCreatePetWithoutBodyId` (AC4), `PetResourceTest.shouldGetAPetInJSonFormat`, `PetResourceTest.shouldReturnNotFoundWhenPetDoesNotExist` (commit `3858f9c`, #545)

### WIMT-1010 Future birth dates rejected (customers-service, api-gateway), Ready for UAT
- Commits `1e7ecb8` "Pet birthdays cannot be set to a future date" and `a3f9d06` "Add validation to reject future pet birth dates" (Divya Balagopal, 2026-08-28), `1d76b00` "Use dynamic date instead of hardcoded year in future-birthdate tests" (2026-08-29)
- `PetRequest.java` (`@JsonFormat(pattern = "yyyy-MM-dd") @PastOrPresent Date birthDate`, `@Size(min = 1) String name`), `PetResource.java` (`@Valid` on both bodies), `PetFormPage.js` (date input without `max`), `state/errors.js` and `RootApp.js` (error banner with `payload.error || payload.message`)
- Tests, passed in the local run: `PetResourceTest.shouldRejectFuturePetBirthdayOnPost` (AC1), `PetResourceTest.shouldRejectFuturePetBirthdayOnUpdate` (AC2)

### WIMT-1011 Unknown owner returns 200 with an empty body (customers-service, api-gateway), Bug, In Progress
- `spring-petclinic-customers-service/src/main/java/.../web/OwnerResource.java` (`findOwner` returns `Optional<Owner>`; `updateOwner` uses `orElseThrow(ResourceNotFoundException)`; `@Min(1)` on `ownerId`; no `OwnerResourceTest` exists under `src/test`)
- `spring-petclinic-api-gateway/.../application/CustomersServiceClient.java` (`bodyToMono(OwnerDetails.class)`), `boundary/web/ApiGatewayController.java` (`flatMap` on the owner), `static/scripts/pages/OwnerDetailsPage.js` (`requireObject(..., 'Owner not found.')`), `static/scripts/api/client.js` (`ApiError` without status), `static/scripts/components/LoadingState.js` (the texts of AC3)
- History: `OwnerResource.java` last touched by `b9c725f` "Get rid of Lombok" (2024-12-27) and `39f6670` (records, 2024-01-05)

### WIMT-1012 Visits (visits-service, api-gateway), Ready for UAT
- `spring-petclinic-visits-service/src/main/java/.../web/VisitResource.java` (`POST owners/*/pets/{petId}/visits` 201, `GET owners/*/pets/{petId}/visits`, `GET pets/visits?petId=` returning `Visits(items)`, `@Min(1)` on `petId`), `model/Visit.java` (`@JsonFormat(pattern = "yyyy-MM-dd")`, `@Size(max = 8192)`, `date = new Date()`), `model/VisitRepository.java` (`findByPetId`, `findByPetIdIn`), `db/hsqldb/data.sql` (visits 1-4 of pets 7 and 8), `db/hsqldb/schema.sql` (`description VARCHAR(8192)`)
- `spring-petclinic-api-gateway/.../static/scripts/pages/VisitsPage.js` (`/api/visit/owners/${ownerId}/pets/${petId}/visits`, `maxlength="8192"`, `required`, redirect to `/owners/details/${ownerId}`)
- Tests, passed in the local run (`TEST-org.springframework.samples.petclinic.visits.web.VisitResourceTest.xml`): `VisitResourceTest.shouldFetchVisits` (AC3, `GET /pets/visits?petId=111,222`)

### WIMT-1013 Vets list and cache (vets-service, api-gateway), Ready for UAT
- `spring-petclinic-vets-service/src/main/java/.../web/VetResource.java` (`@GetMapping @Cacheable("vets")`), `system/CacheConfig.java` (`@EnableCaching @Profile("production")`), `system/VetsProperties.java` (`vets.cache.ttl`, `heapSize`), `src/main/resources/application.yml` (`spring.cache.cache-names: vets`, `spring.profiles.active: production`), `src/test/resources/application-test.yml` (`ttl: 10`, `heap-size: 10`), `model/Vet.java` (`getSpecialties` sorted by name, `getNrOfSpecialties`), `db/hsqldb/data.sql` (6 vets, 3 specialties, 5 links)
- `docker/Dockerfile` (`ENV SPRING_PROFILES_ACTIVE=docker`), `spring-petclinic-config-server/src/main/resources/application.yml` (config comes from `github.com/spring-petclinic/spring-petclinic-microservices-config`, not in the clone)
- `spring-petclinic-api-gateway/.../static/scripts/pages/VetsPage.js` (`/api/vet/vets`, "none")
- Tests, passed in the local run (`TEST-org.springframework.samples.petclinic.vets.web.VetResourceTest.xml`): `VetResourceTest.shouldGetAListOfVets` (AC5)

### WIMT-1014 Owner details aggregation with circuit breaker (api-gateway, customers-service, visits-service), Ready for UAT
- `spring-petclinic-api-gateway/src/main/java/.../boundary/web/ApiGatewayController.java` (`GET /api/gateway/owners/{ownerId}`, `cbFactory.create("getOwnerDetails")`, `emptyVisitsForPets`, `addVisitsToOwner`), `application/CustomersServiceClient.java`, `application/VisitsServiceClient.java` (`pets/visits?petId=` with joined ids, `setHostname` for tests), `dto/OwnerDetails.java`, `dto/PetDetails.java` (`visits` defaults to an empty list), `ApiGatewayApplication.java` (`TimeLimiterConfig` 10 s, load-balanced `WebClient.Builder`)
- `static/scripts/pages/OwnerDetailsPage.js` (tables and links of AC4), customers `data.sql` (owner 6 Jean Coleman, pets 7 Samantha and 8 Max, both type 1 cat) and visits `data.sql`
- Tests, passed in the local run: `ApiGatewayControllerTest.getOwnerDetails_withAvailableVisitsService` (AC1/AC2 shape), `ApiGatewayControllerTest.getOwnerDetails_withServiceError` (AC3), `VisitsServiceClientIntegrationTest.getVisitsForPets_withAvailableVisitsService` (MockWebServer), `ApiGatewayApplicationTests.contextLoads`

### WIMT-1015 Vue shell, routes and fallback (api-gateway), Task, Done
- Commit `dc9ca15` "Migrate from AngularJS to Vue.js for frontend components (#568)" (Antoine Rey, 2026-10-04): `ApiGatewayApplication.java` (`routerFunction`), `FallbackController.java`, `static/index.html` (import map for `vue`, `vue-router`, `dompurify`, `marked`), `static/scripts/*`; commit `295fa8d` (#563) fixed 405 errors by moving to chaos-monkey 4.0.0
- `spring-petclinic-api-gateway/src/main/resources/application.yml` (routes `/api/vet/**`, `/api/visit/**`, `/api/customer/**`, `/api/genai/**` with `StripPrefix=2`, default `CircuitBreaker` filter `fallbackUri: forward:/fallback`, `Retry` 1 for `POST` on `SERVICE_UNAVAILABLE`), `FallbackController.java` (503 text of AC4), `static/scripts/components/LoadingState.js` (503 text of AC4), `static/scripts/router.js`, `PetRepository.findPetTypes` (`ORDER BY ptype.name`) and `types` seed for AC3
- Tests, passed in the local run: `ApiGatewayApplicationRouterTest.servesTheVueApplicationForHtmlNavigation` (AC1), `ApiGatewayApplicationRouterTest.doesNotServeTheVueApplicationForApiRequests`, `ApiGatewayApplicationRouterTest.doesNotServeTheVueApplicationForWebjars`, `ApiGatewayApplicationRouterTest.doesNotServeTheVueApplicationForScriptRequests` (AC2), `FallbackControllerTest.returnsServiceUnavailableForGetRequests` (AC4)

### WIMT-1016 Dates one day early west of UTC (api-gateway), Bug, To Do
- `spring-petclinic-api-gateway/src/main/resources/static/scripts/utils/dates.js` (`formatDate`, `toDateInputValue`, `today`: `new Date(value)` then local getters), `pages/OwnerDetailsPage.js` (`formatDate` for birth and visit dates), `pages/PetFormPage.js` (`toDateInputValue(loadedPet.birthDate)` fed back into the PUT), `pages/VisitsPage.js` (raw `visit.date`, `today()`)
- `spring-petclinic-visits-service/.../model/Visit.java` (`@JsonFormat(pattern = "yyyy-MM-dd")` on a `Date`), `spring-petclinic-customers-service/.../model/Pet.java` (`birthDate` `@Temporal(DATE)` without `@JsonFormat`), `web/PetDetails.java` (`@DateTimeFormat`, which does not affect Jackson)

## Manual tests

`manual-tests.csv`: 9 tests, 42 steps. WIMT-MT-1, MT-2, MT-8 and MT-9 belong to Hitesh (portfolio-api, api-gateway), MT-3 to MT-5 to David (portfolio-client, ui-lib), MT-6 and MT-7 to Robin (customers-service, visits-service). MT-4, MT-8 and MT-9 are `Regression`, the other six `Acceptance`. Covered content points at the story keys and `#ACn` criteria above plus component names. MT-2 and MT-3 are left in phase `New` because they need an HTTPS `ROOT_URL` with the MCP flags, respectively a subscription-enabled instance without a Stripe price, which the team has not set up.

## Things I was unsure about

- **WIMT-1011 (200 with an empty body)**: inferred from `findOwner` returning `Optional<Owner>` directly. Spring MVC hands the `Optional` to Jackson, which writes `Optional.empty()` as `null` with HTTP 200; the gateway's empty `Mono` and the "server cannot be reached" text follow from `client.js` and `LoadingState.js`. Not executed. AC4's HTTP 400 for `/owners/0` relies on the built-in method validation of Spring Framework 6.1+ for `@Min` on a path variable without `@Validated`; also not executed.
- **WIMT-1016 (date shift)**: inferred from `dates.js` and the UTC serialisation of `Visit.date` and `Pet.birthDate`; the exact birth date string of a pet (ISO instant versus epoch) depends on the Jackson defaults of Spring Boot 4, but both parse to UTC midnight, so the shift is the same. Not executed in a browser.
- **WIMT-1013 AC3 (cache)**: the TTL value lives in the external config repository, which is not cloned, so the criterion names the property instead of a number. In the Docker image `SPRING_PROFILES_ACTIVE=docker` replaces the `production` profile of `application.yml`, so caching is probably inactive in docker compose; the criterion is therefore phrased for a local run. The profile difference itself was not filed as a bug.
- **WIMT-1015 AC4 (503 when a service is down)**: that the load balancer's "no instance" error goes through the default `CircuitBreaker` filter to `/fallback` (rather than a bare 503 from Spring Cloud Gateway) is how the configuration reads, not something I ran. Either way the status is 503.
- **WIMT-1010 AC5 and WIMT-1004 AC5**: the exact banner text for a validation error depends on Spring Boot's `server.error.include-message` setting from the config repository; the criterion only requires the banner and that nothing is saved. In Ghostfolio the re-enabling after a failure follows from `finalize` in `onAddAccountBalance`; the other dialogs were not checked line by line.
- **WIMT-1007 (migrations) and the 3.93.0 race condition**: the 3.93.0 and 3.94.0 commits are not in the shallow clone (50 commits from 2026-10-31), so WIMT-1004, WIMT-1005, WIMT-1007 and WIMT-1008 cite CHANGELOG text and the current code; the mapping of "race condition" to migration `20261014` is by date and by the upsert key.
- **WIMT-1002 AC4 (`POST /mcp`)**: the MCP transport is mounted on `MCP_ENDPOINT = '/mcp'` outside the `api` prefix per `main.ts`; the exact method the transport expects (POST for Streamable HTTP) comes from the MCP specification rather than from the repository.
- **fixVersion**: `3.99.0` and `v4.0.1` are plausible next tags, not existing ones (see the scheme above).
- **Status of Done items**: WIMT-1007, WIMT-1008 and WIMT-1015 are Done because their changes are merged and, for WIMT-1015, the tests passed in the local run; Ghostfolio's Jest suites were not run.
- **Requirement ids** (`FR-07xx`, `FR-09xx`, `NFR-08xx`, `NFR-09xx`) are placeholders in the same style as IBGM; there is no requirements register in the workspace.
- **Not filed**: `POST /owners/{ownerId}/pets` with an unknown `typeId` leaves `pet.type` null and should fail on the `NOT NULL` of `pets.type_id` with an HTTP 500 instead of a 400 (`PetResource.save` uses `ifPresent`); `VisitResource` and `PetResource` accept any owner id in the `owners/*` wildcard without checking that the pet belongs to that owner; the owners page labels its search "Last name" but `matchesQuery` filters on every field including pet names. Left out to keep the backlog at 16 stories.
- **Modules without a component** (`spring-petclinic-genai-service`, `admin-server`, `config-server`, `discovery-server`; ghostfolio `apps/api` admin features) got no stories; their CI tests (`PetclinicConfigServerApplicationTests.contextLoads`, `DiscoveryServerApplicationTests.contextLoads`) are in the run but not linked.
