# IBGM backlog notes

Team IBGM, "Nabih's Portfolio". Backlog written from the clone at `repos/piggymetrics` (HEAD `6bb2cf9`, 102 commits, tags `spring.version.1.3.5` and `spring.version.2.0.3`) by reading files and `git log`/`git show`; no code was built or run and no network was used. The `customer-portal` component (OWASP Juice Shop) is not cloned; its two stories come from the publicly known behaviour of the application and were not checked against a clone.

## fixVersion scheme

The repository tags releases after the Spring Boot version they sit on (`spring.version.1.3.5`, `spring.version.2.0.3`). HEAD is 50 commits past `spring.version.2.0.3` with no newer tag, so everything merged or in flight is placed in the next tag of that scheme, `spring.version.2.0.4`. The two `To Do` items are parked in `spring.version.2.1.0`. The same scheme is used for the Juice Shop stories so the team has one release train.

## Stories

### IBGM-1001 Register a new account (account-service, auth-service)
- `account-service/src/main/java/com/piggymetrics/account/controller/AccountController.java` (`createNewAccount`, `POST /`)
- `account-service/.../service/AccountServiceImpl.java` (`create`: existence check, `authClient.createUser`, default `Saving`)
- `account-service/.../domain/User.java` (`@Length(min=3,max=20)` username, `@Length(min=6,max=40)` password)
- `account-service/.../controller/ErrorHandler.java` (IllegalArgumentException -> 400)
- `gateway/src/main/resources/static/js/login.js` (`#signup` handler, alert texts)
- Tests: `AccountControllerTest.shouldRegisterNewAccount`, `shouldFailOnValidationTryingToRegisterNewAccount`, `AccountServiceTest.shouldCreateAccountWithGivenUser`

### IBGM-1002 Save current account and push datapoint (account-service, statistics-service)
- `AccountController.saveCurrentAccount` (`PUT /current`), `AccountServiceImpl.saveChanges`
- `account-service/.../domain/Account.java`, `Item.java`, `Saving.java` (validation annotations)
- `account-service/.../client/StatisticsServiceClient.java`
- Tests: `AccountControllerTest.shouldSaveCurrentAccount`, `shouldFailOnValidationTryingToSaveCurrentAccount`, `AccountServiceTest.shouldSaveChangesWhenUpdatedAccountGiven`

### IBGM-1003 Statistics client fallback (account-service), Done
- Commit `a8bf0f6` "add fallback on update statistic for account service" (Chi Dov, 2018-09-10): `StatisticsServiceClientFallback.java`, `feign.hystrix.enabled: true` in `config/src/main/resources/shared/account-service.yml`, `@EnableCircuitBreaker` on `AccountApplication`
- Commit `469455d` "add unit test for StatisticsServiceClientFallback": `StatisticsServiceClientFallbackTest.java`

### IBGM-1004 OAuth2 password grant and /uaa/users/current (auth-service, account-service)
- `auth-service/.../config/OAuth2AuthorizationConfig.java` (clients `browser`, `account-service`, `statistics-service`, `notification-service`; `InMemoryTokenStore`)
- `auth-service/.../config/WebSecurityConfig.java`, `service/security/MongoUserDetailsService.java`
- `auth-service/.../controller/UserController.java` (`GET /users/current`)
- `account-service/.../service/security/CustomUserInfoTokenServices.java`, `config/ResourceServerConfig.java` (`/` and `/demo` permitted), `AccountController` `@PreAuthorize("#oauth2.hasScope('server') or #name.equals('demo')")`
- `gateway/.../static/js/launch.js` (`requestOauthToken`: `Basic YnJvd3Nlcjo=`, `grant_type=password`, `scope=ui`)
- `config/src/main/resources/shared/application.yml` (`security.oauth2.resource.user-info-uri`)
- Tests: `UserControllerTest.shouldReturnCurrentUser`, `MongoUserDetailsServiceTest`

### IBGM-1005 Duplicate user returns 500 (auth-service, account-service), Bug
- `auth-service/.../service/UserServiceImpl.java` (`create` throws `IllegalArgumentException("user already exists")`)
- There is no `@ControllerAdvice` anywhere under `auth-service/src/main`, unlike `account-service/.../controller/ErrorHandler.java`
- `login.js` error branch: 400 -> "already exists" alert, anything else -> "An error during account creation"
- Tests: `UserServiceTest.shouldFailWhenUserAlreadyExists` (service level only; no controller-level status test)

### IBGM-1006 Config server basic auth and health (config)
- `config/src/main/java/com/piggymetrics/config/SecurityConfig.java` (`/actuator/**` permitAll, `httpBasic`)
- `config/src/main/resources/application.yml` (`spring.security.user.password: ${CONFIG_SERVICE_PASSWORD}`, port 8888)
- `config/Dockerfile` (`HEALTHCHECK ... /actuator/health`), `docker-compose.yml` (`depends_on: config: condition: service_healthy`), `docker-compose.dev.yml` (port 8888 published), `.env` (commit `aaf8e17`)
- Every service `bootstrap.yml` (`fail-fast: true`, `username: user`, `password: ${CONFIG_SERVICE_PASSWORD}`)

### IBGM-1007 Eureka registry (registry, gateway)
- `registry/src/main/java/com/piggymetrics/registry/RegistryApplication.java`, `registry/src/main/resources/bootstrap.yml`
- `config/src/main/resources/shared/application.yml` (`eureka.instance.prefer-ip-address: true`, `defaultZone`), `shared/registry.yml` (port 8761)
- `@EnableDiscoveryClient` on `GatewayApplication`, `AuthApplication`, `AccountApplication`, `StatisticsApplication`, `NotificationServiceApplication`
- `shared/gateway.yml` (`serviceId` routes)

### IBGM-1008 Datapoint normalisation (statistics-service)
- `statistics-service/.../service/StatisticsServiceImpl.java` (`save`, `createItemMetric`, `createStatisticMetrics`)
- `statistics-service/.../domain/TimePeriod.java` (base ratios), `Currency.java` (`getBase()` USD), `domain/timeseries/DataPointId.java`, `DataPoint.java`
- `statistics-service/.../controller/StatisticsController.java` (`@PreAuthorize` on `PUT /{accountName}` and `GET /{accountName}`)
- Tests: `StatisticsServiceImplTest.shouldSaveDataPoint` (the exact figures 298.9802, 6.25, 11.6361, 17.8861, 1250 come from this test), `DataPointRepositoryTest.shouldRewriteDataPointWithinADay`

### IBGM-1009 NPE when the rates provider is unreachable (statistics-service, account-service), Bug
- `statistics-service/.../client/ExchangeRatesClientFallback.java` (returns `Collections.emptyMap()` rates)
- `statistics-service/.../service/ExchangeRatesServiceImpl.java` (`getCurrentRates` builds `ImmutableMap.of(EUR, rates.get("EUR"), RUB, rates.get("RUB"), USD, ONE)`; Guava `ImmutableMap.of` rejects null values)
- `config/src/main/resources/shared/statistics-service.yml` (`rates.url: https://api.exchangeratesapi.io`)
- `StatisticsServiceClientFallback` in account-service swallows the resulting failure

### IBGM-1010 Exchange rates client contract and daily cache (statistics-service), Done
- Commit `5c2880d` "#34 fixed exchange rates client in order to support API changes in exchangeratesapi.io" (sqshq, 2018-08-26): `ExchangeRatesClient.java`, `ExchangeRatesClientFallback.java`, `shared/statistics-service.yml`, `launch.js`
- Commit `836a97f` "fixed exchange rates test after the provider API change" (2018-09-25): `ExchangeRatesClientTest.java`
- Earlier related commit `7772ef6` "update exchange rate provider when init in frontend related to PR #24"
- Tests: `ExchangeRatesServiceImplTest` (`shouldNotRequestRatesWhenTodaysContainerAlreadyExists`, `shouldConvertCurrency`)

### IBGM-1011 Notification settings (notification-service)
- `notification-service/.../controller/RecipientController.java` (`GET`/`PUT /recipients/current`)
- `notification-service/.../service/RecipientServiceImpl.java` (`save` sets `lastNotified` when null)
- `notification-service/.../domain/Recipient.java` (`@Email`, `@NotNull`), `NotificationSettings.java`, `Frequency.java` (WEEKLY 7, MONTHLY 30, QUARTERLY 90)
- `notification-service/.../repository/converter/FrequencyWriterConverter.java`, `FrequencyReaderConverter.java`
- `login.js` `#mail` handler (REMIND active, MONTHLY)
- Tests: `RecipientControllerTest`, `RecipientServiceImplTest.shouldSaveRecipient`, `RecipientRepositoryTest.shouldFindByAccountName`

### IBGM-1012 Scheduled backup and reminder e-mails (notification-service, account-service)
- `notification-service/.../service/NotificationServiceImpl.java` (`@Scheduled(cron = "${backup.cron}")`, `"${remind.cron}"`, per-recipient `CompletableFuture`)
- `notification-service/.../service/EmailServiceImpl.java` (`@RefreshScope`, subject/text/attachment from `Environment`)
- `notification-service/.../repository/RecipientRepository.java` (`findReadyForBackup`, `findReadyForRemind` `$where` queries)
- `notification-service/.../client/AccountServiceClient.java` (`GET /accounts/{accountName}`), `config/ResourceServerConfig.java` (client_credentials interceptor)
- `config/src/main/resources/shared/notification-service.yml` (`remind.*`, `backup.*`, `spring.mail.*`)
- README section "With Spring Cloud Config, you can change application config dynamically" (`POST /notifications/refresh`)
- Tests: `NotificationServiceImplTest` (errors for one recipient do not block the others), `RecipientRepositoryTest` (8 days ago vs yesterday vs inactive), `EmailServiceImplTest`

### IBGM-1013 Zuul gateway routing (gateway)
- `config/src/main/resources/shared/gateway.yml` (routes, `ignoredServices: '*'`, `sensitiveHeaders:` empty, 20000 ms timeouts, port 4000)
- `gateway/src/main/java/com/piggymetrics/gateway/GatewayApplication.java` (`@EnableZuulProxy`)
- `gateway/src/main/resources/static/index.html` and `js/*`, `docker-compose.yml` (`80:4000`)

### IBGM-1014 Dashboard shows 0 for USD/EUR items (gateway), Bug
- `gateway/src/main/resources/static/js/launch.js` (`global.usd = 0`, `global.eur = 0`, `$.getJSON("https://api.exchangeratesapi.io/latest?base=RUB&symbols=EUR,USD", ...)` with no error callback)
- `gateway/src/main/resources/static/js/dashboard.js` (`getConverted` lines 70-96, savings conversion lines 125-135 multiply by `global.usd` / `global.eur`)
- `mongodb/dump/account-service-dump.js` (demo account: Rent 1300 USD MONTH, Vacation 3500 EUR YEAR, used in AC1)
- History: `7772ef6`, `5c2880d` changed only the URL of this call

### IBGM-1015 Juice Shop login (customer-portal)
- Not cloned. Based on the publicly documented Juice Shop login page (`/#/login`, `POST /rest/user/login`, `GET /rest/user/whoami`, error text "Invalid email or password."). Not checked against a clone.

### IBGM-1016 Juice Shop basket (customer-portal)
- Not cloned. Based on the publicly documented basket (`POST /api/BasketItems`, `GET /rest/basket/{bid}`, `/#/basket`). Not checked against a clone.

## Manual tests

`manual-tests.csv`: 9 tests, 42 steps. IBGM-MT-1 to MT-5 belong to Mohd Sayeer (account-service, auth-service, config), MT-6 to MT-9 to Karim (statistics-service, notification-service, gateway, customer-portal). Covered content points at the story keys and `#ACn` criteria above; MT-3, MT-5 and MT-8 are `Regression`, the rest `Acceptance`. MT-6 and MT-9 are left in phase `New` because they need a rates stub, respectively the Juice Shop instance, that the team has not set up yet.

## Things I was unsure about

- **IBGM-1005 (500 on duplicate user)**: inferred from the missing `@ControllerAdvice` in auth-service and Spring Boot's default handling of an uncaught `IllegalArgumentException`. Not executed.
- **IBGM-1009 (NPE on fallback)**: inferred from `ImmutableMap.of` rejecting null values and the fallback's empty map. That `api.exchangeratesapi.io/latest` now needs an API key is general knowledge, not something the repository states; the network was not used to confirm it. The same assumption drives IBGM-1014.
- **IBGM-1004 AC2**: HTTP 400 with `invalid_grant` is the standard Spring Security OAuth2 answer to a bad password; the repository has no test for it.
- **IBGM-1007 AC4 and IBGM-1013 AC5**: Eureka eviction timing and the exact Zuul timeout status (504 vs 500) are not configured or tested in the repository; the criteria are phrased as "5xx within 20 seconds".
- **IBGM-1011 AC4**: checking that `frequency` is stored as `30` needs the Mongo shell on `notification-mongodb`; it is observable but not through the API.
- **IBGM-1008 / MT-6**: the real provider cannot be made to return EUR 0.8 and RUB 80, so the story and test assume a stub at `rates.url`. The repository's `ExchangeRatesClientTest` hits the live provider and will fail offline.
- **Status of Done items**: IBGM-1003 and IBGM-1010 are marked Done because their commits are merged on master; the tests were not run here.
- **Not filed**: `ItemMetric.equals` compares titles case-insensitively, so two items "Rent" and "rent" collapse into one metric in the datapoint. Left out to keep the backlog at 16 stories; it could become a Bug on statistics-service later.
- **monitoring and turbine-stream-service** modules exist in the clone but are not components in team.json, so no stories were written for them (the reverted `d3beabc`/`fd32bf9` monitoring port change was skipped for that reason).
