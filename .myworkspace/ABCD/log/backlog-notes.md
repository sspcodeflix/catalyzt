# ABCD backlog notes

Team ABCD, "Ram's Portfolio" (owner Ram Kumar, component managers Sourav and Brijesh). Backlog written from the two clones by reading files and `git log` / `git show`; nothing was built or run and the network was not used.

- `repos/microservices-demo` (GoogleCloudPlatform/microservices-demo, Online Boutique): HEAD `c7cb6d5` "Change cleanup workflow to be scheduled and hourly", branch main. The clone is shallow (50 commits, boundary `2b63910` "Clean up PR workflows", 2026-08-11) and carries no tags; apart from `38e7348` "Release v0.10.7 (#3534)" (2026-09-18) every commit in it is a dependency or image update, so the service code cannot be attributed to the commits that introduced it. Stories for this repository therefore cite files, not commits.
- `repos/ach` (moov-io/ach): HEAD `c7025ec` "fix(deps): update module github.com/moov-io/base to v0.68.2 (#1922)", branch master, 55 commits (also shallow), tags down to `v1.64.0`; latest tag `v1.68.0` at `417fc3b` (2026-11-03), HEAD is 6 commits past it.

Hexa already holds the local CI results for both repositories (see `log/ci-runs.md`): moov-io/ach 2,211 go tests passing at `c7025ec` (Hexa run `1d41591ab25b6fc4`), microservices-demo productcatalogservice 4 and shippingservice 15 go tests passing at `c7cb6d5` (runs `e7893507f54a6a93` and `b2a2ee32fd7637b1`). Where a criterion is covered by one of those tests the test name and file are listed below so it can be linked in Hexa; every name was checked against the `go.xml` files under `results/`.

## fixVersion scheme

- microservices-demo tags releases `v0.10.x`; the clone has no tags but `release/kubernetes-manifests.yaml` and the Release commit pin `v0.10.7`. Shipped behaviour verified as regression (ABCD-1005, ABCD-1006) is placed in `v0.10.7`; work in flight or awaiting UAT in the plausible next patch `v0.10.8`; the `To Do` bug ABCD-1003 (needs a proto change) in `v0.11.0`. The two next versions are assumptions, not tags.
- ach: all cited commits except `ff3a098` are contained in `v1.68.0` (`git tag --contains`), so the four ach stories carry `v1.68.0`. Nothing is placed in `v1.69.0` because nothing in the backlog depends on the six unreleased commits.

## Stories

### ABCD-1001 Currency switch and shop_currency cookie (frontend)
- `src/frontend/handlers.go` (`setCurrencyHandler`, `currentCurrency`, `renderMoney`, `renderCurrencyLogo`, `logoutHandler`)
- `src/frontend/main.go` (`whitelistedCurrencies`, `cookieCurrency = "shop_currency"`, `cookieMaxAge = 60*60*48`, `defaultCurrency`)
- `src/frontend/rpc.go` (`getCurrencies` filters through the whitelist, `convertCurrency`, `avoidNoopCurrencyConversionRPC = false`)
- `src/frontend/validator/validator.go` (`SetCurrencyPayload` `iso4217`, `ValidationErrorResponse` text "Field '%s' is invalid: %s")
- `src/frontend/templates/header.html` (currency `<select>`), `footer.html` (session-id, request-id)
- `src/currencyservice/data/currency_conversion.json` (order EUR, USD, JPY, ... GBP ... TRY ... CAD gives the dropdown order)
- Figures: €17.68 and €7.95 computed by replaying `convert()` from `server.js` on 19.99 and 8.99 USD (see ABCD-1005)
- Tests: `src/frontend/validator/validator_test.go` `TestSetCurrencyPassesValidation`, `TestSetCurrencyFailsValidation` (not in the local CI; see ABCD-1007)

### ABCD-1002 Add to cart, cart page, empty cart (frontend, cartservice)
- `src/frontend/handlers.go` (`addToCartHandler`, `viewCartHandler`, `emptyCartHandler`, `cartSize`), `src/frontend/validator/validator.go` (`AddToCartPayload` `gte=1,lte=10`)
- `src/frontend/templates/product.html` (quantity options 1-5 and 10), `cart.html` ("Your shopping cart is empty!", "Cart ({{ $.cart_size }})", Shipping, Total)
- `src/cartservice/src/services/CartService.cs`, `src/cartservice/src/cartstore/RedisCartStore.cs` (`AddItemAsync` adds to an existing line, `GetCartAsync` returns `new Cart()` for an unknown user, `FailedPrecondition "Can't access cart storage."`), `src/cartservice/src/Startup.cs` (store selection by `REDIS_ADDR`, `SPANNER_PROJECT`, `SPANNER_CONNECTION_STRING`, `ALLOYDB_PRIMARY_IP`)
- `src/productcatalogservice/product_catalog.go` (`NotFound "no product with ID %s"` behind AC4)
- Tests: `src/cartservice/tests/CartServiceTests.cs` `GetItem_NoAddItemBefore_EmptyCartReturned`, `AddItem_ItemExists_Updated`, `AddItem_New_Inserted` (xUnit, not in the local CI); `validator_test.go` `TestAddToCartPassesValidation`, `TestAddToCartFailsValidation`

### ABCD-1003 Checkout form: numeric zip and month 12 labelled January (frontend), Bug, To Do
- `src/frontend/handlers.go` (`placeOrderHandler`: `zipCode, _ = strconv.ParseInt(r.FormValue("zip_code"), 10, 32)`), `validator.go` (`ZipCode int64 validate:"required"`)
- `src/frontend/templates/cart.html` line 130 (`pattern="\d{4,5}"`), line 188 (`<option value="12">January</option>`)
- `protos/demo.proto` (`Address.zip_code int32`), `src/emailservice/templates/confirmation.html` (prints `zip_code`)
- Tests: `validator_test.go` `TestPlaceOrderFailsValidation` case "invalid zip code" (0)

### ABCD-1004 Declined card ends in HTTP 500 (paymentservice, checkoutservice, frontend), Bug, In Progress
- `src/paymentservice/charge.js` (`CreditCardError.code = 400`, `InvalidCreditCard`, `UnacceptedCreditCard`, `ExpiredCreditCard` texts, `Transaction processed:` log), `src/paymentservice/server.js` (`ChargeServiceHandler` passes the error to the callback)
- `src/checkoutservice/main.go` (`chargeCard` -> `status.Errorf(codes.Internal, "failed to charge card: %+v", err)`)
- `src/frontend/handlers.go` (`placeOrderHandler` -> `renderHTTPError(... "failed to complete the order" ... StatusInternalServerError)`), `templates/error.html` ("Uh, oh!", "HTTP Status:")
- `src/frontend/templates/cart.html` (default card 4432801561520454, CVV 672)
- No tests exist for paymentservice (team.json "none in repo")

### ABCD-1005 Currency conversion (currencyservice), regression
- `src/currencyservice/server.js` (`_carry`, `getSupportedCurrencies`, `convert`, "conversion request successful", "Profiler disabled."), `src/currencyservice/data/currency_conversion.json` (33 codes)
- `kubernetes-manifests/currencyservice.yaml` (`PORT 7000`, `DISABLE_PROFILER`)
- The units/nanos in AC2-AC4 were computed by replaying the JavaScript arithmetic in Python with IEEE doubles (same number type); the USD round trip of all nine prices came out unchanged
- No tests in the repository

### ABCD-1006 Shipping quote and tracking id (shippingservice), Done, regression
- `src/shippingservice/quote.go` (`CreateQuoteFromCount` 8.99 / 0, `CreateQuoteFromFloat`), `tracker.go` (`CreateTrackingId` format `%c%c-%d%s-%d%s`), `main.go` (`GetQuote` sums quantities, `ShipOrder` salt `"<street>, <city>, <state>"`)
- Tests in Hexa (run `b2a2ee32fd7637b1`, file `src/shippingservice/shippingservice_test.go`): `TestGetQuote` (AC1), `TestGetQuoteEmptyCart` (AC2), `TestShipOrder`, `TestTrackingIdFormat`, `TestTrackingIdUniqueness` (AC3), `TestCreateQuoteFromFloat` with subtests `zero`, `whole_dollars`, `with_cents`, `small_value`, `large_value` (AC4), plus `TestCreateQuoteFromCount`, `TestGetRandomLetterCode`, `TestGetRandomNumber`, `TestQuoteString`
- Default address salt "1600 Amphitheatre Parkway, Mountain View, CA" is 44 characters, hence the 18-character id with digit groups starting 44 and 22 (MT-4)

### ABCD-1007 Local CI targets for validator, money and cartservice tests (frontend, checkoutservice, cartservice), Task
- `.myworkspace/ABCD/ci.json` (only `src/productcatalogservice` and `src/shippingservice` targets), `log/ci-runs.md` (4 + 15 results delivered)
- `.github/workflows/ci-pr.yaml` (upstream runs `go test` in shippingservice, productcatalogservice, frontend/validator and `dotnet test src/cartservice/`)
- `src/frontend/validator/validator_test.go`, `src/frontend/money/money_test.go`, `src/checkoutservice/money/money_test.go` (same ten test functions in both money packages), `src/cartservice/tests/cartservice.tests.csproj` (net10.0, xunit 2.9.3), `src/cartservice/src/Dockerfile` (sdk 10.0 image)

### ABCD-1008 PlaceOrder flow (checkoutservice, paymentservice, shippingservice, emailservice)
- `src/checkoutservice/main.go` (`PlaceOrder`, `prepareOrderItemsAndShippingQuoteFromCart`, `prepOrderItems`, `chargeCard`, `shipOrder`, `emptyUserCart` result discarded, `sendOrderConfirmation` warn-only; log lines "payment went through (transaction_id: %s)", "order confirmation email sent to %q", "failed to send order confirmation to %q", `codes.Unavailable "shipping error"`)
- `src/checkoutservice/money/money.go` (`Sum`, `MultiplySlow`), `src/frontend/handlers.go` (`placeOrderHandler` total_paid), `templates/order.html` (Confirmation #, Tracking #, Total Paid)
- `src/emailservice/email_server.py` (`DummyEmailService` log "A request to send order confirmation email to {} has been received.")
- EUR figures: Sunglasses {17, 682441398} x2 = {35, 364882796}; shipping {7, 952233525}; sum {43, 317116321} -> €43.31
- Tests: `src/checkoutservice/money/money_test.go` (`TestSum`, `TestIsValid`, `TestMust_panic` ...), not in the local CI

### ABCD-1009 Product catalog (productcatalogservice)
- `src/productcatalogservice/product_catalog.go` (`ListProducts`, `GetProduct`, `SearchProducts`, `parseCatalog`), `catalog_loader.go` (`loadCatalogFromLocalFile` log "loading catalog from local products.json file...", `loadCatalogFromAlloyDB`), `server.go` (SIGUSR1/SIGUSR2 "Enable catalog reloading"/"Disable catalog reloading", `EXTRA_LATENCY` with `log.Fatalf("failed to parse EXTRA_LATENCY ...")`, "extra latency enabled (duration: %v)", port 3550), `README.md` (reload and latency sections), `products.json` (9 products; "kitchen" appears in two descriptions, "glass" in Sunglasses' description and the Bamboo Glass Jar name)
- Tests in Hexa (run `e7893507f54a6a93`, file `src/productcatalogservice/product_catalog_test.go`): `TestListProducts` (AC1 count), `TestGetProductExists`, `TestGetProductNotFound` (AC2), `TestSearchProducts` (AC3, query "alpha" over the mock catalog)

### ABCD-1010 Ads by category (adservice)
- `src/adservice/src/main/java/hipstershop/AdService.java` (`getAds`, `getAdsByCategory`, `getRandomAds`, `MAX_ADS_TO_SERVE = 2`, `createAdsMap` texts and redirect URLs, default port 9555)
- `src/frontend/rpc.go` (`getAd` 100 ms timeout), `handlers.go` (`chooseAd` picks one at random, warns "failed to retrieve ads"), `templates/ad.html`
- `src/productcatalogservice/products.json` (categories per product)
- No test sources under `src/adservice` (team.json says JUnit (Gradle); the build has no `src/test`)

### ABCD-1011 Confirmation template defects (emailservice), Bug, In Progress
- `src/emailservice/templates/confirmation.html` (`street_address_1`, `street_address_2`, `"{{ order.shipping_cost.units }}. {{ ... }}"`, item rows by `product_id`)
- `protos/demo.proto` (`Address` fields), `src/emailservice/email_server.py` (`EmailService.__init__` raises "cloud mail client not implemented", `start()` always `DummyEmailService`, template loaded at import), `kubernetes-manifests/emailservice.yaml` (PORT 8080)
- No pytest in `src/emailservice`

### ABCD-1012 Recommendations (recommendationservice)
- `src/recommendationservice/recommendation_server.py` (`ListRecommendations`: `max_responses = 5`, set difference, `random.sample`, log "[Recv ListRecommendations] product_ids={}", start-up error "PRODUCT_CATALOG_SERVICE_ADDR environment variable not set")
- `src/frontend/rpc.go` (`getRecommendations` keeps the first four), `handlers.go` (product page passes `[]string{id}`, cart passes `cartIDs(cart)`, order passes nil; warn "failed to get product recommendations"), `templates/recommendations.html` ("You May Also Like")
- No tests in the repository

### ABCD-1013 ISO-8859-1 writer (ach-core), Task, Done
- Commit `3f6ca97` "fix: encode Nacha records as ISO-8859-1 bytes (#1915)" (Adam Shannon, 2026-11-03): `encoding.go` (`encodeNachaRecord`), `fieldErrors.go` (`ErrRecordLength`, `ErrNonLatin1`), `writer.go`, `encoding_test.go`, `writer_test.go`; in `v1.68.0`
- Commit `ff3a098` "perf: write ASCII Nacha records with WriteString (#1920)" (2026-11-05): `writer.go`, `writer_test.go`; not yet tagged
- `validators.go` `isAlphanumeric` accepts U+00C0-U+00FF, so é is valid in names (used by MT-9)
- Tests in Hexa (run `1d41591ab25b6fc4`): `TestWriter_Latin1Addenda05` (`writer_test.go`, AC1), `TestExtendedCharacters` with subtests `IAT_File`, `ACH_File`, `detect`, `parse_nonaschii-utf8`, `parse_windows-1252` (`encoding_test.go`, AC2), `TestEncodeNachaRecord`, `TestWriter_writeLine` with subtests `ASCII`, `wrong_length`, `bypass_wrong_length`, `Latin-1`, `Latin-1_wrong_length`, `non_Latin-1`, `bypass_non_Latin-1` (AC3, AC4), `TestWriteBypassValidation`, `TestPPDWrite`

### ABCD-1014 Batch numbering and ascending checks (ach-core)
- Commit `151651f` "fix: renumber batches that an earlier File.Create numbered (#1883)" (Michael Parsons, 2026-10-09) and `12199c8` "fix: number batches 1..n in File.Create unless PreserveBatchNumbers (#1885)" (2026-10-12): `file.go` (`Create`, `preserveBatchNumbers()`, `ValidateOpts.PreserveBatchNumbers`), `server/validate.go` (query `preserveBatchNumbers`), `openapi.yaml`, `docs/create-file.md`, `docs/custom-validation.md`
- Commit `b7a40f7` "fix: check that IAT and ADV batch numbers ascend (#1911)" (keanfreeman-narmi, 2026-10-28) and `471ba1d` "perf: skip domesticNumbers map when File has no IAT batches (#1914)": `file.go` (`isSequenceAscending`), `fileErrors.go` (`NewErrFileBatchNumberAscending` text)
- `server/test/unordered_batches/Moov-batch-numbers-issue.json` (two CCD batches with `batchNumber` 2 then 1), `server/routing.go` (POST `/files/{fileID}` i.e. `/files/create`, GET `/files/{id}/contents`, GET/POST `/files/{id}/validate`)
- Tests in Hexa: `TestFile__CreateAgainAfterAddBatch` subtests `IAT_batch`, `caller_set_batch_numbers`, `PreserveBatchNumbers_keeps_caller_numbers`, `JSON_clone_then_add_batch`, `default_batch_number_1_compacted`, `read_files_then_add_batch`, `parsed_descending_batch_numbers`, `PreserveBatchNumbers_keeps_descending_numbers` (`file_test.go`, AC1, AC2); `TestFile__IATBatchNumbersAscendApartFromDomestic` (4 subtests, AC3); `TestFile__AscendingBatchSequenceADV` (AC4); `TestFile__AscendingBatchSequence` (4 subtests); `TestUnorderedBatches` (`server/test/unordered_batches/unordered_batch_test.go`, AC5); `TestReadValidateOpts_PreserveBatchNumbers` (`server/validate_test.go`, AC5)

### ABCD-1015 achcli stdin, -validate-totals, -validate-file (ach-core)
- Commit `31aac1a` "feat(achcli): read input from stdin when the path is - (#1904)" (2026-10-27): `cmd/achcli/input.go` (`errStdinEmpty`, `errStdinFix`, `readInput`, `canReadStdin`), `input_test.go`
- Commit `99c384d` "feat(achcli): allow -validate-totals with -reformat (#1905)" (2026-10-27) and `0fea53d` "feat(achcli): add -validate-file to check raw files with File.ValidateWith (#1909)" (2026-10-28): `cmd/achcli/validate_totals.go` (error texts quoted in the criteria), `reformat.go`, `main.go` (flags), `README.md` (exit codes, rejected flags, `ERROR: <path>:` format)
- Tests in Hexa (`cmd/achcli`): `TestStdinCLI` subtests `reformat_json`, `validate_totals`, `describe`, `diff_caches_stdin`, `diff_file_against_stdin`, `empty_stdin`, `fix_rejects_stdin` (AC1, AC2); `TestReadInput`, `TestCanReadStdin`, `TestRejectStdinFix`, `TestReadIncomingFileStdin`, `TestValidateTotalsFileStdin`; `TestValidateTotalsCLI` (93 subtests, among them `valid`, `verbose`, `missing`, `BatchCount`, `EntryAddendaCount`, `skip_all_options`, `unequal_count_options`, `inactive_flags`) (AC3, AC4)

### ABCD-1016 CTX/ATX zero-addenda JSON and PAY code (ach-core), Bug, Done
- Commit `48b4eb3` "fix: keep CTX/ATX receiving company when loading zero-addenda entries from JSON (#1902)" (2026-10-26): `file.go`, `batchCATX_test.go`
- Commit `cdbd536` "fix: parse CTX/ATX JSON addenda count as a numeric field" (Adam Shannon, 2026-10-26): `entryDetail.go` (`catxAddendaCount`), `file.go`, `entryDetail_test.go`, `examples/example_ctxWrite_noAddenda_test.go`, `test/issues/issue1901_test.go`, `test/issues/testdata/issue1901.json`
- Commit `ad0658b` "fix: accept PAY as IAT Addenda10 Transaction Type Code (#1893)" (2026-10-20): `validators.go`, `addenda10_test.go`, `test/issues/issue1891_test.go`, `openapi.yaml`
- Tests in Hexa: `TestIssue1901` (`test/issues`, AC1, AC2), `TestCATXAddendaCount` subtests `zero_count_with_company`, `zero_count_with_company_padded`, `nonzero_count_with_company`, `count_only`, `bare_company`, `short_name`, `empty`, `letters_in_count_slot` (`entryDetail_test.go`, AC4), `TestBatchCATX_JSONKeepsReceivingCompany` subtests `CTX_without_addenda`, `CTX_with_addenda_and_a_zero_count`, `ATX_without_addenda`, `ATX_with_addenda_and_a_zero_count` (`batchCATX_test.go`, AC4), `TestIssue1891` and `TestAddenda10TransactionTypeCodePAY` (`addenda10_test.go`, AC5)

## Manual tests

`manual-tests.csv`: 9 tests, 48 steps. ABCD-MT-1 to MT-4 belong to Sourav (frontend, cartservice, paymentservice, shippingservice), MT-5 to MT-9 to Brijesh (productcatalogservice, checkoutservice, adservice, ach-core). MT-4, MT-5 and MT-9 are `Regression`, the other six `Acceptance`. Covered content points at the story keys, `#ACn` criteria and component names above. MT-3 is left in phase `New` because it accepts the fix of ABCD-1004, which is still in progress. The Online Boutique tests assume the frontend port-forwarded to localhost:8080 and `kubectl` access to the demo namespace; MT-5 needs `grpcurl` with `protos/demo.proto`; MT-8 needs the `moov/ach:v1.68.0` image and MT-9 a Go toolchain to build `achcli`.

## Things I was unsure about

- **Both clones are shallow** (50 and 55 commits). For microservices-demo no feature commit is visible at all, so nothing in ABCD-1001 to ABCD-1012 is attributed to a commit; the ach commits cited are all within the clone.
- **fixVersions v0.10.8 and v0.11.0** for microservices-demo are the plausible next versions after the pinned `v0.10.7`; the clone has no tags.
- **ABCD-1004**: that grpc-js forwards `code = 400` so that Go sees `rpc error: code = Code(400)` and the frontend answers HTTP 500 is inferred from the three code paths, not executed; likewise the lower-case card type `amex` in the message comes from the `simple-card-validator` type names used in the `visa`/`mastercard` comparison, which were not inspected (node_modules is not in the clone).
- **ABCD-1005 figures** (nanos such as 682441398) come from replaying `convert()` in Python; JavaScript `Math.round` and Python `round` differ only at exact .5, which none of the computed values hit, but a one-nano difference on another input would not surprise me.
- **ABCD-1001 AC3 / ABCD-1008 AC2**: the JPY and EUR cart totals assume the frontend converts the unit price first and then multiplies (`convertCurrency` then `money.MultiplySlow`), which is what `viewCartHandler` does; converting the multiplied amount would give a cent less in some cases.
- **ABCD-1003**: the `January` label on month 12 and the numeric-only zip code are observed in `cart.html` and `handlers.go`; that a postal code with a leading zero is sent as 2134 follows from `int32 zip_code` in the proto and was not observed in a running system.
- **ABCD-1009 AC3**: "kitchen" and "glass" matches were checked against `products.json` descriptions; the real test `TestSearchProducts` uses a mock catalog, so only the matching rule is covered by CI, not these exact results.
- **ABCD-1010 AC5** (100 ms deadline) is observable only as a missing ad and a frontend warning; the exact warning text for a deadline is not asserted anywhere in the repository.
- **ABCD-1011**: the template bug is only visible if someone renders `confirmation.html`; the shipped service never does because `EmailService.__init__` raises. The expected address line including the state is a proposal, not a documented requirement.
- **ABCD-1013 AC5** and the writer's byte identity for ASCII files are inferred from the identity path in `encodeNachaRecord`; there is no golden-file test for that.
- **ABCD-1014 AC5 / MT-8 step 5**: combining `?preserveBatchNumbers=true&unorderedBatchNumbers=true` is not exercised by `TestUnorderedBatches` (it tests each option alone); the expected HTTP 200 follows from `readValidateOpts` parsing every query key and `ValidateWith` honouring `AllowUnorderedBatchNumbers`.
- **ABCD-1015 AC3**: the exact text after `ERROR: <path>: ` for a wrong batch count and the `-v` summary line were not read from the tests, only their existence (`TestValidateTotalsCLI/BatchCount`, `verbose`).
- **ABCD-1016 AC3** (positions 55-76 of the entry detail line) is the Nacha layout, not something a test in the repository asserts through the HTTP server.
- **Statuses**: `Done` is used for ABCD-1006, ABCD-1013 and ABCD-1016 because the code is merged and their tests passed in the local CI run; `Ready for UAT` and `In Progress` are simulation choices.
- **Not filed**: `shippingservice/quote.go` `Quote.String` formats `$%d.%d`, so `Quote{8, 5}` prints `$8.5` (the method is only used by `TestQuoteString`); `currencyservice` `convert` with an unknown `to_code` yields NaN units instead of an error (unreachable through the frontend whitelist); `homeHandler` resolves `metadata.google.internal.` on every request; `getRandomAds` can return the same ad twice. Left out to keep the backlog at 16 stories.
- **Components without a dedicated story**: none; `shoppingassistantservice` and `loadgenerator` exist in the clone but are not components in team.json, so no stories were written for them.
