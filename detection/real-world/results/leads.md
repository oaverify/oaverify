# Differential leads

> Measured against 300 specs on 2026-08-20.
>
> Not a baseline. `specs/` is gitignored and `download.sh` re-selects
> from live upstreams, so a later run measures a different population
> and no CI job gates on these numbers. A count that moved may mean the
> corpus moved. No `audited-*` specs were present, so this is the public corpus alone.

Noisy by construction. Nothing here is a finding until it has been
minimized to a hand-written document; the filters below are keyword
heuristics over four tools' prose and they misjudge both ways.

## oaverify silent, a comparator flagged something schema-shaped

49 specs.

- `guru-6-dot-authentiqio.appspot.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.AuthentiqID`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.Claims`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.Error`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.PushToken`
- `guru-1password.com_events-3.0.0.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.Client`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.Cursor`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Cursor from id # @ `components.schemas.CursorCollection`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.Details`
- `guru-adyen.com_BalanceControlService-3.1.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.BalanceTransferRequest`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.BalanceTransferResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BalanceTransferResponse from id # @ `paths./balanceTransfer.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BalanceTransferRequest from id # @ `paths./balanceTransfer.post.requestBody.application/json`
- `guru-adyen.com_AccountService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.Account`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountHolderDetails`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/AccountEvent from id # @ `components.schemas.AccountHolderStatus`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountPayoutState`
- `guru-adyen.com_BinLookupService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.CardBin`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.CostEstimateRequest`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.CostEstimateResponse`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.Recurring`
- `guru-adyen.com_CheckoutUtilityService-3.0.0.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.CheckoutUtilityRequest`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.CheckoutUtilityResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CheckoutUtilityResponse from id # @ `paths./originKeys.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CheckoutUtilityRequest from id # @ `paths./originKeys.post.requestBody.application/json`
- `guru-adyen.com_DataProtectionService-3.1.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/SubjectErasureResponse from id # @ `paths./requestSubjectErasure.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ServiceError from id # @ `paths./requestSubjectErasure.post.responses.400.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ServiceError from id # @ `paths./requestSubjectErasure.post.responses.401.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ServiceError from id # @ `paths./requestSubjectErasure.post.responses.403.application/json`
- `guru-adyen.com_HopService-3.1.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/FieldType from id # @ `components.schemas.ErrorFieldType`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CollectInformation from id # @ `components.schemas.GetOnboardingUrlRequest`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.GetOnboardingUrlResponse`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.GetPciUrlResponse`
- `guru-adyen.com_FundService-3.1.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/DetailBalance from id # @ `components.schemas.AccountDetailBalance`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountHolderBalanceResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/TransactionListForAccount from id # @ `components.schemas.AccountHolderTransactionListRequest`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountHolderTransactionListResponse`
- `guru-adyen.com_CheckoutService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountInfo`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AchDetails`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-deprecatedInVersion" @ `components.schemas.AdditionalData3DSecure`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-enum" @ `components.schemas.AdditionalDataCommon`
- `guru-adyen.com_NotificationConfigurationService-3.1.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/NotificationConfigurationDetails from id # @ `components.schemas.CreateNotificationConfigurationRequest`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/FieldType from id # @ `components.schemas.ErrorFieldType`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.GenericResponse`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.GetNotificationConfigurationListResponse`
- `guru-adyen.com_MarketPayNotificationService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountCloseNotification`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountCreateNotification`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountFundsBelowThresholdNotification`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/LocalDate from id # @ `components.schemas.AccountFundsBelowThresholdNotificationContent`
- `guru-adyen.com_PayoutService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.BankAccount`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.FraudCheckResultWrapper`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/FraudCheckResultWrapper from id # @ `components.schemas.FraudResult`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Address from id # @ `components.schemas.FundSource`
- `guru-adyen.com_RecurringService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.BankAccount`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Permit from id # @ `components.schemas.CreatePermitRequest`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/PermitResult from id # @ `components.schemas.CreatePermitResult`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.DisableRequest`
- `guru-adyen.com_PaymentService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountInfo`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-enum" @ `components.schemas.AdditionalDataCommon`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AdjustAuthorisationRequest`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CommonField from id # @ `components.schemas.ApplicationInfo`
- `guru-adyen.com_StoredValueService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.ServiceError`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.StoredValueBalanceCheckRequest`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.StoredValueBalanceCheckResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.StoredValueBalanceMergeRequest`
- `guru-adyen.com_TestCardService-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.AvsAddress`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.CreateTestCardRangesRequest`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `components.schemas.CreateTestCardRangesResult`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.ServiceError`
- `guru-api.ebay.com_sell-account-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CompactCustomPolicyResponse from id # @ `components.schemas.CustomPolicyResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Amount from id # @ `components.schemas.Deposit`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ErrorParameter from id # @ `components.schemas.Error`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CategoryType from id # @ `components.schemas.FulfillmentPolicy`
- `guru-apidapp.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Empty from id # @ `paths./.options.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Empty from id # @ `paths./.x-amazon-apigateway-any-method.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Empty from id # @ `paths./account.options.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Empty from id # @ `paths./account.post.responses.200.application/json`
- `guru-apispot.io_whois-3.0.2.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.ArrayOfBatch`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.Batch`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ArrayOfBatch from id # @ `paths./batch.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Batch from id # @ `paths./batch.post.responses.200.application/json`
- `guru-archive.org_search-3.0.0.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.Error`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Hit from id # @ `components.schemas.OrganicResult`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Cursor from id # @ `components.schemas.ScrapeResult`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Field from id # @ `paths./search/v1/fields.get.responses.200.application/javascript`
- `guru-arespass.net-3.0.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "xml" @ `components.schemas.about`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "xml" @ `components.schemas.ec`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/about from id # @ `paths./about.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/about from id # @ `paths./about.get.responses.200.application/x-yaml`
- `guru-autodealerdata.com-3.0.2.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BasicModelStats from id # @ `components.schemas.BasicModelStatsResp`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BucketEntry from id # @ `components.schemas.BucketResp`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/DealershipData from id # @ `components.schemas.DealershipDataPaginated`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/DealershipDataPaginated from id # @ `components.schemas.DealershipDataPaginatedResp`
- `guru-axesso.de-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BuyRecommendationResponse from id # @ `paths./amz/amazon-lookup-buy-recommendations.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ProductDetailsResponse from id # @ `paths./amz/amazon-lookup-product.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/KeywordSearchResponse from id # @ `paths./amz/amazon-search-by-keyword.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/SortOptionResponse from id # @ `paths./amz/sort-options.get.responses.200.application/json`
- `guru-bintable.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ResponseItem from id # @ `paths./balance.get.responses.200.*/*`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ResponseItem from id # @ `paths./{bin}.get.responses.200.application/json`
- `guru-botschaft.local-3.0.2.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ValidationError from id # @ `components.schemas.HTTPValidationError`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Config from id # @ `paths./config.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/HTTPValidationError from id # @ `paths./config.get.responses.422.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/HTTPValidationError from id # @ `paths./discord.get.responses.422.application/json`
- `guru-canada-holidays.ca-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Holiday from id # @ `paths./api/v1/holidays.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Holiday from id # @ `paths./api/v1/holidays/{holidayId}.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Error from id # @ `paths./api/v1/holidays/{holidayId}.get.responses.400.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Province from id # @ `paths./api/v1/provinces.get.responses.200.application/json`
- `guru-chaingateway.io-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/clearAddress from id # @ `paths./clearAddress.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/clearAddressRequest from id # @ `paths./clearAddress.post.requestBody.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/deleteAddress from id # @ `paths./deleteAddress.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/deleteAddressRequest from id # @ `paths./deleteAddress.post.requestBody.application/json`
- `guru-circleci.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Artifact from id # @ `components.schemas.Artifacts`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Lifecycle from id # @ `components.schemas.Build`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/CommitDetails from id # @ `components.schemas.BuildDetail`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Outcome from id # @ `components.schemas.BuildSummary`
- `guru-crediwatch.com_covid19-3.0.2.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ValidationError from id # @ `components.schemas.HTTPValidationError`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/GetStatus from id # @ `components.schemas.StatusCall`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/VerifyNameData from id # @ `components.schemas.VerifyName`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/PlaceCall from id # @ `components.schemas.VerifyPhone`
- `guru-d7networks.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/SendSMSRequest from id # @ `paths./send.post.requestBody.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BulkSMSRequest from id # @ `paths./sendbatch.post.requestBody.application/json`
- `guru-discourse.local-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `paths./admin/backups.json.post.responses.200.application/json`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `paths./admin/backups.json.post.requestBody.application/json`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `paths./admin/badges.json.get.responses.200.application/json`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `paths./admin/badges.json.post.responses.200.application/json`
- `guru-edrv.io-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/schema1 from id # @ `paths./v1/chargestations.post.requestBody.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/schema1 from id # @ `paths./v1/chargestations/{id}.patch.requestBody.application/json`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `paths./v1/commands/chargingschedule.post.requestBody.application/json`
- `guru-eos.local-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/paths/~1net~1status/post/responses/200/content/application~1json/schema/properties/last_handshake/properties/token from id # @ `paths./net/connections.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/paths/~1net~1status/post/responses/200/content/application~1json/schema/properties/last_handshake/properties/token from id # @ `paths./net/status.post.responses.200.application/json`
- `guru-extendsclass.com_json-storage-3.0.1.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.CreateStatus`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.DeleteStatus`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.Error`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "properties" at "#" (strictTypes) @ `components.schemas.UpdateStatus`
- `guru-firmalyzer.com_iotvas-3.0.2.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Vulnerability from id # @ `components.schemas.DeviceInfo`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ValidationError from id # @ `components.schemas.HTTPValidationError`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Vulnerability from id # @ `components.schemas.VulnerableComponent`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/DeviceInfo from id # @ `paths./device/detect.post.responses.200.application/json`
- `guru-freetv-app.com-3.0.1.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/NewsItem from id # @ `components.schemas.ApiResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ApiResponse from id # @ `paths./services.get.responses.200.application/json`
- `guru-google.home-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Getcurrentvalues from id # @ `paths./assistant/a11y_mode.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/AccessibilityRequest from id # @ `paths./assistant/a11y_mode.post.requestBody.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/DeleteAlarmsandTimersRequest from id # @ `paths./assistant/alarms/delete.post.requestBody.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Getvolume from id # @ `paths./assistant/alarms/volume.post.responses.200.application/json`
- `guru-groundhog-day.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: schema is invalid: data/properties/active/exclusiveMaximum must be number, data/properties/active/exclusiveMinimum must be number, data/properties/isGroundhog/e @ `components.schemas.Groundhog`
  - **ajv** `ajv/compile`: schema is invalid: data/properties/year/exclusiveMinimum must be number @ `components.schemas.Prediction`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Groundhog from id # @ `paths./api/v1/groundhogs/{slug}.get.responses.200.application/json`
- `guru-hubapi.com_analytics-3.0.1.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/BehavioralEventHttpCompletionRequest from id # @ `paths./events/v3/send.post.requestBody.application/json`
- `guru-klarna.com_openai-3.0.1.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Product from id # @ `components.schemas.ProductResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ProductResponse from id # @ `paths./public/openai/v0/products.get.responses.200.application/json`
- `guru-mercure.local-3.0.2.yaml`
  - **ajv** `ajv/compile`: strict mode: missing type "object" for keyword "required" at "#" (strictTypes) @ `paths./.well-known/mercure.post.requestBody.application/x-www-form-urlencoded`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Subscriptions from id # @ `paths./.well-known/mercure/subscriptions.get.responses.200.application/ld+json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Subscriptions from id # @ `paths./.well-known/mercure/subscriptions/{topic}.get.responses.200.application/ld+json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Subscriptions from id # @ `paths./.well-known/mercure/subscriptions/{topic}/{subscriber}.get.responses.200.application/ld+json`
- `guru-mermade.org.uk_openapi-converter-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/validationResult from id # @ `paths./validate.get.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/validationResult from id # @ `paths./validate.get.responses.200.application/x-yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/validationResult from id # @ `paths./validate.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/validationResult from id # @ `paths./validate.post.responses.200.application/x-yaml`
- `guru-magento.com-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/asynchronous-operations-data-operation-extension-interface from id # @ `components.schemas.asynchronous-operations-data-detailed-operation-status-interface`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/bundle-data-bundle-option-extension-interface from id # @ `components.schemas.bundle-data-bundle-option-interface`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/bundle-data-link-extension-interface from id # @ `components.schemas.bundle-data-link-interface`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/bundle-data-option-extension-interface from id # @ `components.schemas.bundle-data-option-interface`
- `guru-nasa.gov_apod-3.0.0.yaml`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-thing" @ `paths./apod.get.responses.200.application/json`
- `guru-nebl.io-3.0.0.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/getTxResponse from id # @ `components.schemas.getTxsResponse`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/rpcResponse from id # @ `paths./.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/rpcRequest from id # @ `paths./.post.requestBody.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/getAddressResponse from id # @ `paths./ins/addr/{address}.get.responses.200.application/json`
- `guru-nlpcloud.io-3.0.2.yaml`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/Arc from id # @ `components.schemas.DependenciesOut`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/EntityOut from id # @ `components.schemas.EntitiesOut`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ValidationError from id # @ `components.schemas.HTTPValidationError`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/SentenceDependencyOut from id # @ `components.schemas.SentenceDependenciesOut`
- `guru-urlbox.io-3.1.0.yaml`
  - **ajv** `ajv/compile`: strict mode: required property "url" is not defined at "#/oneOf/0" (strictRequired) @ `components.schemas.RenderRequest`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/RenderResponse from id # @ `paths./v1/render/sync.post.responses.200.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/RedirectResponse from id # @ `paths./v1/render/sync.post.responses.307.application/json`
  - **ajv** `ajv/compile`: can't resolve reference #/components/schemas/ErrorResponse from id # @ `paths./v1/render/sync.post.responses.400.application/json`
- `large-adyen-checkout.json`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AccountInfo`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-addedInVersion" @ `components.schemas.AchDetails`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-deprecatedInVersion" @ `components.schemas.AdditionalData3DSecure`
  - **ajv** `ajv/compile`: strict mode: unknown keyword: "x-enum" @ `components.schemas.AdditionalDataCommon`

## oaverify findings no comparator locates, by rule

### `example-invalid` (2925 findings, 41 specs)

- `guru-api.video-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: session.endedAt: must match format date-time; session.loadedAt: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-api.video-3.0.0.yaml`: example does not match its schema: must be array (actual: string)
- `guru-apicurio.local_registry-3.0.2.yaml`: example does not match its schema: must be string (actual: object)
- `guru-ato.gov.au-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-ato.gov.au-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-ato.gov.au-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-ato.gov.au-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-ato.gov.au-3.0.0.yaml`: example does not match its schema: must match format date-time
- `guru-ato.gov.au-3.0.0.yaml`: example does not match its schema: must match format date-time

### `silent-rewrite/ref-siblings-oas30` (2747 findings, 16 specs)

- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "components.schemas.TaskInstance.properties.sla_miss" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "components.schemas.TaskInstance.properties.state" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "components.schemas.TaskInstance.properties.trigger" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "components.schemas.TaskInstance.properties.triggerer_job" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "readOnly" sibling of $ref at "components.schemas.DAGRun.properties.state" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "readOnly" sibling of $ref at "components.schemas.BasicDAGRun.properties.state" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "properties.sla_miss" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "properties.state" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "properties.trigger" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "properties.triggerer_job" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "readOnly" sibling of $ref at "properties.state" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "properties.execution_timeout" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "properties.retry_delay" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "allOf[1].properties.dag_run_timeout" is silently dropped (only description/summary survive)
- `guru-apache.org-3.0.3.yaml`: OAS 3.0: "nullable" sibling of $ref at "components.schemas.Task.properties.execution_timeout" is silently dropped (only description/summary survive)

### `unused-component` (1904 findings, 56 specs)

- `guru-airbyte.local_config-3.0.0.yaml`: components.schemas.DbMigrationState is declared but no operation reaches it
- `guru-airbyte.local_config-3.0.0.yaml`: components.schemas.ResourceId is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.AnalysisArchiveTransitionHistory is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.AnalysisUpdateEval is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.AnalysisUpdateNotification is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.AnalysisUpdateNotificationData is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.AnalysisUpdateNotificationPayload is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.Annotations is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.BaseNotificationData is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.ContentResponse is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.GenericNotificationPayload is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.ImageAnalysisReport is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.ImageContentDeleteResponse is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.ImageFilter is declared but no operation reaches it
- `guru-anchore.io-3.0.0.yaml`: components.schemas.LocalAnalysisSource is declared but no operation reaches it

### `unknown-keyword` (438 findings, 10 specs)

- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "definitions" at "components.schemas.BankTransactions"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.BankTransactions.properties.accountId"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.BankTransactions.properties.transactions"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.BankTransactions.definitions.bankTransactionLine.allOf[0].properties.counterparty"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.BankTransactions.definitions.bankTransactionLine.allOf[0].properties.description"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.BankTransactions.definitions.bankTransactionLine.allOf[0].properties.reference"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "definitions" at <root>
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "properties.options"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "properties.properties"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.PushOption.definitions.pushOptionProperty.properties.options"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.PushOption.definitions.pushOptionProperty.properties.properties"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.PushOption.definitions.pushValidationInfo.properties.information"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.PushOption.definitions.pushFieldValidation.properties.ref"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "components.schemas.PushOption.definitions.pushValidationInfo.properties.warnings"
- `guru-codat.io_bank-feeds-3.1.0.yaml`: unknown keyword "nullable" at "properties.validation"

### `format-not-validated` (356 findings, 149 specs)

- `guru-1password.local_connect-3.0.2.yaml`: OpenAPI defines "binary", and no validator can assert it over JSON, so values are checked against "type" alone.
- `guru-1password.local_connect-3.0.2.yaml`: "url" is not a validated format, so values are checked against "type" alone.
- `guru-ably.net_control-3.0.1.yaml`: OpenAPI defines "binary", and no validator can assert it over JSON, so values are checked against "type" alone.
- `guru-adobe.com_aem-3.0.0.yaml`: OpenAPI defines "binary", and no validator can assert it over JSON, so values are checked against "type" alone (12 positions use it).
- `guru-airbyte.local_config-3.0.0.yaml`: OpenAPI defines "binary", and no validator can assert it over JSON, so values are checked against "type" alone (3 positions use it).
- `guru-apache.org-3.0.3.yaml`: "datetime" is not a validated format, so values are checked against "type" alone (21 positions use it).
- `guru-apache.org-3.0.3.yaml`: OpenAPI defines "password", and no validator can assert it over JSON, so values are checked against "type" alone.
- `guru-apache.org-3.0.3.yaml`: "path" is not a validated format, so values are checked against "type" alone (2 positions use it).
- `guru-anchore.io-3.0.0.yaml`: OpenAPI defines "binary", and no validator can assert it over JSON, so values are checked against "type" alone (2 positions use it).
- `guru-anchore.io-3.0.0.yaml`: "path" is not a validated format, so values are checked against "type" alone (3 positions use it).
- `guru-api2pdf.com-3.0.0.yaml`: OpenAPI defines "binary", and no validator can assert it over JSON, so values are checked against "type" alone (3 positions use it).
- `guru-api2pdf.com-3.0.0.yaml`: OpenAPI defines "html", and no validator can assert it over JSON, so values are checked against "type" alone (2 positions use it).
- `guru-api2pdf.com-3.0.0.yaml`: "url" is not a validated format, so values are checked against "type" alone (3 positions use it).
- `guru-api2pdf.com-3.0.0.yaml`: "list of urls to pdfs" is not a validated format, so values are checked against "type" alone.
- `guru-api.video-3.0.0.yaml`: "period" is not a validated format, so values are checked against "type" alone (2 positions use it).

### `silent-rewrite/required-not-in-properties` (273 findings, 37 specs)

- `guru-airbyte.local_config-3.0.0.yaml`: required: "json_schema" at "properties.catalog.properties.streams.items.properties.stream" is not declared in properties reachable here (likely a typo)
- `guru-airbyte.local_config-3.0.0.yaml`: required: "json_schema" at "properties.syncCatalog.properties.streams.items.properties.stream" is not declared in properties reachable here (likely a typo)
- `guru-airbyte.local_config-3.0.0.yaml`: required: "json_schema" at "properties.connections.items.properties.syncCatalog.properties.streams.items.properties.stream" is not declared in properties reachable here (likely a typo)
- `guru-airbyte.local_config-3.0.0.yaml`: required: "dockerImageag" at <root> is not declared in properties reachable here (likely a typo)
- `guru-apicurio.local_registry-3.0.2.yaml`: required: "group" at "properties.artifacts.items" is not declared in properties reachable here (likely a typo)
- `guru-apicurio.local_registry-3.0.2.yaml`: required: "group" at <root> is not declared in properties reachable here (likely a typo)
- `guru-asana.com-3.0.0.yaml`: required: "project" at "properties.data" is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "jwt_token" at <root> is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "payload" at <root> is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "biapi.last_push" at <root> is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "token" at <root> is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "failed" at <root> is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "total" at <root> is not declared in properties reachable here (likely a typo)
- `guru-biapi.pro-3.0.0.yaml`: required: "transactions" at <root> is not declared in properties reachable here (likely a typo)
- `guru-atlassian.com_jira-3.0.1.yaml`: required: "defaultScreen" at "properties.screens.allOf[0]" is not declared in properties reachable here (likely a typo)

### `unused-tag` (99 findings, 26 specs)

- `guru-airbyte.local_config-3.0.0.yaml`: tag "deployment" is declared but no operation references it
- `guru-anchore.io-3.0.0.yaml`: tag "Image Content" is declared but no operation references it
- `guru-anchore.io-3.0.0.yaml`: tag "Vulnerabilities" is declared but no operation references it
- `guru-anchore.io-3.0.0.yaml`: tag "Policy Evaluation" is declared but no operation references it
- `guru-anchore.io-3.0.0.yaml`: tag "Services" is declared but no operation references it
- `guru-anchore.io-3.0.0.yaml`: tag "Queries" is declared but no operation references it
- `guru-appwrite.io_client-3.0.0.yaml`: tag "health" is declared but no operation references it
- `guru-appwrite.io_client-3.0.0.yaml`: tag "projects" is declared but no operation references it
- `guru-appwrite.io_client-3.0.0.yaml`: tag "users" is declared but no operation references it
- `guru-biapi.pro-3.0.0.yaml`: tag "Documents" is declared but no operation references it
- `guru-biapi.pro-3.0.0.yaml`: tag "OIDC" is declared but no operation references it
- `guru-biapi.pro-3.0.0.yaml`: tag "Payments" is declared but no operation references it
- `guru-biapi.pro-3.0.0.yaml`: tag "Recipients" is declared but no operation references it
- `guru-biapi.pro-3.0.0.yaml`: tag "Service" is declared but no operation references it
- `guru-biapi.pro-3.0.0.yaml`: tag "Terms" is declared but no operation references it

### `ambiguous-pattern` (90 findings, 15 specs)

- `guru-amazonaws.com_AWSMigrationHub-3.0.0.yaml`: "arn:[a-z-]+:[a-z0-9-]+:(?:[a-z0-9-]+|):(?:[0-9]{12}|):.*" is ambiguous. An input of the form `[^][^][^][^][^][^]arn:[a-z-][a-z-]:[a-z0-9-][a-z0-9-]:[a-z0-9-][a-z0-9-][a-z0-9-][a-z0-9-][a-z0-9-][a-z0-
- `guru-anchore.io-3.0.0.yaml`: "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]..." is ambiguous. An input of the form `[^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][a-z0-9!#$%&'*+/=?^_`{|}~-][a-z0-9!#$%&'*+/=?^_`{|
- `guru-agco-ats.com-3.0.0.yaml`: "^[0-9a-zA-Z]*?[a-zA-Z]+[0-9a-zA-Z]*$" is ambiguous. An input of the form `[0-9a-zA-Z][0-9a-zA-Z][0-9a-zA-Z][0-9a-zA-Z][a-zA-Z][0-9a-zA-Z]` matches more than one way. A crafted value here may cost sup
- `guru-bbc.com-3.0.0.yaml`: "([a-z0-9\.\-]+|.*PID.*)" is ambiguous. An input of the form `[^][^][^][^]` matches more than one way. A crafted value here may cost superlinear time to match.
- `guru-cpy.re_peertube-3.0.0.yaml`: "/magnet:\?xt=urn:[a-z0-9]+:[a-z0-9]{32}/i" is ambiguous. An input of the form `[^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^]
- `guru-cpy.re_peertube-3.0.0.yaml`: "/magnet:\?xt=urn:[a-z0-9]+:[a-z0-9]{32}/i" is ambiguous. An input of the form `[^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^][^]
- `guru-digitalocean.com-3.0.0.yaml`: "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$" is ambiguous. An input of the form `xn--[a-zA-Z0-9]-[a-zA-Z0-9]\.[a-zA-Z0-9][a-zA-Z0-9][a-zA-Z0-9]\.` matches more than one way. A crafted v
- `guru-digitalocean.com-3.0.0.yaml`: "^.+/.+$" is ambiguous. An input of the form `....\/.` matches more than one way. A crafted value here may cost superlinear time to match.
- `guru-digitalocean.com-3.0.0.yaml`: "^$|^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[..." is ambiguous. An input of the form `25[0-5]\.2[0-4][0-9]\.[01][0-9][0-9]\.[0-9][0-9]` matches more than one way. A crafted value here 
- `guru-flickr.com-3.0.0.yaml`: "^([0-9]+@N[0-9]+)|([0-9a-zA-Z-_]+)$" is ambiguous. An input of the form `[^][0-9a-zA-Z-_][0-9a-zA-Z-_][0-9a-zA-Z-_]` matches more than one way. A crafted value here may cost superlinear time to match
- `guru-flickr.com-3.0.0.yaml`: "^([0-9]+@N[0-9]+)|([0-9a-zA-Z-_]+)$" is ambiguous. An input of the form `[^][0-9a-zA-Z-_][0-9a-zA-Z-_][0-9a-zA-Z-_]` matches more than one way. A crafted value here may cost superlinear time to match
- `guru-flickr.com-3.0.0.yaml`: "^([0-9]+@N[0-9]+)|([0-9a-zA-Z-_]+)$" is ambiguous. An input of the form `[^][0-9a-zA-Z-_][0-9a-zA-Z-_][0-9a-zA-Z-_]` matches more than one way. A crafted value here may cost superlinear time to match
- `guru-flickr.com-3.0.0.yaml`: "^([0-9]+@N[0-9]+)|([0-9a-zA-Z-_]+)$" is ambiguous. An input of the form `[^][0-9a-zA-Z-_][0-9a-zA-Z-_][0-9a-zA-Z-_]` matches more than one way. A crafted value here may cost superlinear time to match
- `guru-flickr.com-3.0.0.yaml`: "^([0-9]+@N[0-9]+)|([0-9a-zA-Z-_]+)$" is ambiguous. An input of the form `[^][0-9a-zA-Z-_][0-9a-zA-Z-_][0-9a-zA-Z-_]` matches more than one way. A crafted value here may cost superlinear time to match
- `guru-flickr.com-3.0.0.yaml`: "^([0-9]+@N[0-9]+)|([0-9a-zA-Z-_]+)$" is ambiguous. An input of the form `[^][0-9a-zA-Z-_][0-9a-zA-Z-_][0-9a-zA-Z-_]` matches more than one way. A crafted value here may cost superlinear time to match

### `example-uncheckable` (66 findings, 6 specs)

- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\.)+[a-zA-Z]{2,}\.?$", whose worst-case matching time may be superlinear, so the e
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^.+/.+$", whose worst-case matching time may be superlinear, so the example was not run against it (the redos class rep
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^.+/.+$", whose worst-case matching time may be superlinear, so the example was not run against it (the redos class rep
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^.+/.+$", whose worst-case matching time may be superlinear, so the example was not run against it (the redos class rep
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^$|^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[...", whose worst-case matching time may be superlinear, so
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^$|^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[...", whose worst-case matching time may be superlinear, so
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^$|^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[...", whose worst-case matching time may be superlinear, so
- `guru-digitalocean.com-3.0.0.yaml`: example could not be checked against its schema: its schema reaches the pattern "^$|^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[...", whose worst-case matching time may be superlinear, so

### `unsatisfiable/enum-member-type` (40 findings, 12 specs)

- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.ignorecase" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.trim" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.lower" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.trim" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.lower" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.uppercase" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.lower" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.trim" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-apptigent.com-3.0.1.yaml`: "enum" at "properties.ignoreCase" has 2 members that "type": string can never admit: [0] true, [1] false; every member is dead, so no value validates here
- `guru-bbci.co.uk-3.0.0.yaml`: "enum" at <root> has 2 members that "type": array can never admit: [0] "live", [1] "promotions"; every member is dead, so no value validates here
- `guru-bhagavadgita.io-3.0.0.yaml`: "enum" at <root> has 3 members that "type": string can never admit: [0] 1, [1] 2, [2] 3; every member is dead, so no value validates here
- `guru-bitbucket.org-3.0.0.yaml`: "enum" at "components.schemas.participant.allOf[1].properties.state" has a member that "type": string can never admit: [2] null; that member can never be selected
- `guru-bitbucket.org-3.0.0.yaml`: "enum" at "allOf[1].properties.state" has a member that "type": string can never admit: [2] null; that member can never be selected
- `guru-daniweb.com-3.0.0.yaml`: "enum" at "properties.goals[]" has 7 members that "type": array can never admit: [0] "Find business partnerships", [1] "Find prospective clients", [2] "Hire employees", [3] "Find a job", [4] "Find a c
- `guru-bungie.net-3.0.0.yaml`: "enum" at "components.schemas.Destiny.Entities.Items.DestinyItemInstanceComponent.properties.breakerType" has 4 members that "type": integer can never admit: [0] "0", [1] "1", [2] "2", [3] "3"; every 

### `silent-rewrite/redundant-composition-branches` (30 findings, 6 specs)

- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[1] is structurally identical to oneOf[0] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[1] is structurally identical to oneOf[0] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[2] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[3] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[4] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[5] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[6] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[2] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[3] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[4] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[5] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-apple.com_app-store-connect-3.0.1.yaml`: oneOf[6] is structurally identical to oneOf[1] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-dataflowkit.com-3.0.0.yaml`: anyOf[1] is structurally identical to anyOf[0] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-dataflowkit.com-3.0.0.yaml`: anyOf[3] is structurally identical to anyOf[2] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec
- `guru-dataflowkit.com-3.0.0.yaml`: anyOf[4] is structurally identical to anyOf[2] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec

### `silent-rewrite/discriminator-unroutable` (17 findings, 3 specs)

- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "disable_backups", "enable_backups", "enable_ipv6", "power_cycle", "power_off", "power_on", "shutdown", "snapshot" name no branch. Th
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "attach", "detach" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "A", "AAAA", "CAA", "CNAME", "MX", "NS", "SOA", "SRV", "TXT" name no branch. The discriminator is ignored and the composition validat
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "change_kernel", "disable_backups", "enable_backups", "enable_ipv6", "password_reset", "power_cycle", "power_off", "power_on", "reboo
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "assign", "unassign" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "convert", "transfer" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "assign", "unassign" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `guru-digitalocean.com-3.0.0.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "attach", "detach", "resize" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "disable_backups", "enable_backups", "enable_ipv6", "power_cycle", "power_off", "power_on", "shutdown", "snapshot" name no branch. Th
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "attach", "detach" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "A", "AAAA", "CAA", "CNAME", "MX", "NS", "SOA", "SRV", "TXT" name no branch. The discriminator is ignored and the composition validat
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "change_kernel", "disable_backups", "enable_backups", "enable_ipv6", "password_reset", "power_cycle", "power_off", "power_on", "reboo
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "assign", "unassign" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "convert", "transfer" name no branch. The discriminator is ignored and the composition validates every branch instead.
- `large-digitalocean.yaml`: "discriminator" at <root> cannot select a branch: mapping value(s) "assign", "unassign" name no branch. The discriminator is ignored and the composition validates every branch instead.

### `silent-rewrite/pattern-not-unicode-mode` (14 findings, 6 specs)

- `guru-ably.io_platform-3.0.1.yaml`: "pattern" at <root> compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format: regex" rejec
- `guru-anchore.io-3.0.0.yaml`: "pattern" at "components.schemas.WhitelistItem.properties.expires_on" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-
- `guru-digitalocean.com-3.0.0.yaml`: "pattern" at <root> compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format: regex" rejec
- `guru-digitalocean.com-3.0.0.yaml`: "pattern" at "paths./v2/tags.get.responses.200.content.application/json.schema.allOf.0.properties.tags.items.properties.name" compiles only without the "u" flag; the validator falls back to non-unicod
- `guru-digitalocean.com-3.0.0.yaml`: "pattern" at "allOf[0].properties.tags.items.properties.name" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pat
- `guru-digitalocean.com-3.0.0.yaml`: "pattern" at "properties.name" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format: r
- `guru-linode.com-3.0.1.yaml`: "pattern" at "properties.domain" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format:
- `guru-linode.com-3.0.1.yaml`: "pattern" at "properties.domain" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format:
- `guru-linode.com-3.0.1.yaml`: "pattern" at "components.schemas.Domain.properties.domain" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode patter
- `large-digitalocean.yaml`: "pattern" at <root> compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format: regex" rejec
- `large-digitalocean.yaml`: "pattern" at "paths./v2/tags.get.responses.200.content.application/json.schema.allOf.0.properties.tags.items.properties.name" compiles only without the "u" flag; the validator falls back to non-unicod
- `large-digitalocean.yaml`: "pattern" at "allOf[0].properties.tags.items.properties.name" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pat
- `large-digitalocean.yaml`: "pattern" at "properties.name" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as written (and "format: r
- `guru-beezup.com-3.0.0.yaml`: "pattern" at "components.schemas.orderInvoiceUri" compiles only without the "u" flag; the validator falls back to non-unicode mode, which reads some escapes differently from the u-mode pattern as writ

### `malformed-schema` (5 findings, 2 specs)

- `guru-codat.io_accounting-3.1.0.yaml`: GET /companies/{companyId}/data/items/{itemId} 200 response body (application/json): keyword "type" at "definitions.itemType.type" requires a type name or array of type names; got object
- `guru-codat.io_accounting-3.1.0.yaml`: GET /companies/{companyId}/data/items 200 response body (application/json): keyword "type" at "components.schemas.Item.definitions.itemType.type" requires a type name or array of type names; got objec
- `guru-codat.io_accounting-3.1.0.yaml`: POST /companies/{companyId}/connections/{connectionId}/push/items request body (application/json): keyword "type" at "definitions.itemType.type" requires a type name or array of type names; got object
- `guru-codat.io_accounting-3.1.0.yaml`: POST /companies/{companyId}/connections/{connectionId}/push/items 200 response body (application/json): keyword "type" at "components.schemas.Item.definitions.itemType.type" requires a type name or ar
- `guru-dnd5eapi.co-3.0.1.yaml`: GET /api/monsters/{index} 200 response body (application/json): "allOf" at <root> must be an array of schemas; got a object.

### `path-param-undeclared` (1 findings, 1 specs)

- `guru-clicksend.com-3.0.0.yaml`: path template "/uploads?convert={convert}" references "{convert}" but neither the operation nor its path item declares a path parameter named "convert"

### `annotation-value-type` (1 findings, 1 specs)

- `guru-codat.io_assess-3.1.0.yaml`: "examples" at <root> should be an array; got object
