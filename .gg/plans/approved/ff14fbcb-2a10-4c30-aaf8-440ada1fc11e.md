<!-- gg-plan-status: approved -->
# Add an operator-ready queue and resilience checks

## Scope

Extend the current local Playwright CLI from one durable job per invocation to a bounded batch queue. Preserve the visible dedicated Chrome profile, public Suno UI boundary, manual login/challenge handoff, one-click submission rule, durable per-job recovery, and non-submitting smoke dependency boundary. Do not add stealth, alternate identities, proxying, private APIs, CAPTCHA handling, request interception, or retries after a submission attempt, rate limit, account block, login requirement, challenge, validation rejection, or ambiguous UI result.

## Current structure

- `src/job.ts` parses one command-line job; `src/tracking.ts` already gives normalized inputs deterministic identifiers, validated atomic state, attempt/confirmation markers, and restart decisions.
- `src/cli.ts` creates or resumes one job, launches one persistent context, owns submission/observation/download flow, prints stable identifiers without prompt content, and closes the context after that job.
- `src/browser.ts` launches visible Chrome against `.suno-control/chrome-profile`; the attached Playwright revision confirms persistent contexts retain cookies/local storage, only one browser may own a user-data directory, and the normal Chrome profile must not be automated (`docs/src/api/class-browsertype.md:329-352`, revision `d4e1023f6c03a8dced50eb3db88c2217e7c1a86a`).
- `src/preparation.ts` centralizes current Create-page readiness, login/challenge classification, and semantic form locators. `src/smoke.ts` reuses that path without importing submission, but its artifacts do not yet provide a fixed redacted selector matrix.
- Current per-job observation and download limits are bounded, but queue concurrency and pre-submission retry policy are not explicit CLI inputs.
- The worktree contains the preceding completion/tracking phase changes. Implementation must build on them in place and must not discard or reset them.

## Queue input and limits

Keep the existing single-job command compatible. Add a mutually exclusive `--jobs <manifest.json>` batch form plus optional `--concurrency <n>` and `--retries <n>` controls for both forms. The manifest is an array of the existing `{ prompt, options }` shape. Parse it as untrusted input with an exact-key schema, regular-file and byte-size limit, 1–100 job bound, existing normalized field validation, and duplicate deterministic-ID rejection. Never print manifest contents, prompts, styles, or raw parse data.

Use explicit conservative limits: concurrency defaults to `1` and permits only `1` or `2`; pre-submission retries default to `0` and permit only `0` or `1`. Reject out-of-range or repeated queue flags. The retry applies only when browser launch/navigation/session work fails while durable state proves `submission.attemptedAt` is absent. It must never retry a Create click or continue retrying any visible account/rate-limit/block/challenge/validation/changed-UI outcome.

Before opening Chrome, create or validate durable state for every manifest entry so the complete batch is recoverable. Run a bounded worker pool inside one persistent browser context, satisfying Playwright's one-owner profile constraint; each worker gets a distinct page navigated to the public Create route. Close pages after jobs and close the context once after the queue settles. Stop dispatching new jobs after a rate-limit or account-block outcome; already running jobs finish, while untouched jobs remain queued for deliberate recovery.

Print one concise line per transition using only queue position, a shortened deterministic job identifier, attempt number when retrying, and stable status. End with counts by terminal status. Return success only when every job completes; otherwise choose a documented aggregate nonzero exit by highest-action priority without hiding each job's individual outcome.

## Redacted diagnostics

Add a diagnostic writer under each contained job directory and for smoke artifacts. Capture diagnostics whenever a job cannot complete and whenever smoke reports changed UI. The versioned JSON must contain only: timestamp, stable job identifier or `smoke`, fixed stage/category enums, an allowlisted URL classification with query/fragment removed, and a fixed selector-presence/count matrix for the known Create controls, login marker, challenge marker, result container, and Download control.

Do not persist raw exception messages, page HTML/text/title, screenshots for queue failures, accessibility snapshots, console/network traffic, cookies, headers, storage state, prompt values, user names, arbitrary URLs, or locator-rendered values. Map exceptions to fixed categories. Validate diagnostic objects before atomic restrictive-permission writes, contain every path under `.suno-control`, and make diagnostic-write failure secondary so it cannot erase the original job outcome.

Centralize the selector probe beside the existing semantic locators so production failures and smoke use the same drift indicators. The smoke result may retain its explicitly documented local screenshot, but its JSON should add the redacted selector matrix and sanitized location. Keep `smoke-cli.ts` dependency-isolated from `submission.ts`, and preserve the static test proving that no Create click is reachable.

## Recovery and operator documentation

Update `README.md` with the manifest schema and examples, sequential default, opt-in ceiling of two, zero-retry default, exact retry exclusions, queue status/aggregate exit behavior, dispatch stop on enforcement signals, and rerun recovery through existing deterministic state. Explain manual login and challenge pauses, closing all dedicated-profile windows before a run, safe profile reset by moving/deleting only `.suno-control/chrome-profile` after Chrome closes, and the resulting logout without deleting job/output state.

Document diagnostic locations and their deliberately limited fields, smoke behavior, selectors most likely to drift, and how to use smoke before submitting work. State plainly that browser automation may violate Suno terms or trigger account enforcement, concurrency increases account pressure, and the tool offers no guarantee against suspension. Retain guidance to use only the dedicated local profile, keep `.suno-control` private, avoid shared machines, and never use the normal Chrome profile.

## Verification

- Add parser tests for single-job compatibility, valid manifests, exact-schema rejection, duplicate IDs, size/job ceilings, and limit bounds.
- Add queue tests with injected workers for sequential default ordering, explicit concurrency ceiling, status lines for every job, aggregate exits, all-state-before-launch persistence, dispatch stop after enforcement outcomes, context/page cleanup, and restart behavior.
- Prove retry policy with tests that retry one eligible pre-attempt browser failure and never retry attempted, ambiguous, login, challenge, validation, rate-limit, blocked, or changed-UI work.
- Add diagnostic tests proving fixed selector matrices are useful, URLs are sanitized, arbitrary page/account/prompt/error text is absent, paths remain contained, writes are atomic, and diagnostic failures preserve original outcomes.
- Extend smoke tests to prove the current structure probe is non-submitting and its dependency graph still cannot reach submission capability.
- Extend prohibited-technique checks to every new source file so evasion, session export, request interception, private APIs, raw traces, and automatic challenge handling remain absent.
- Run `npm run build` and `npm test`. Then run the targeted compiled queue, diagnostics, CLI, and smoke-boundary tests.
- Run `npm run smoke:live` once only if the dedicated profile is already authenticated and available. Login absence, a manual challenge, or unavailable live access is recorded as unverified rather than treated as an implementation blocker; the command must never submit or consume credits.

## Risks

- Two concurrent pages increase account pressure and may receive an enforcement response concurrently; defaulting to one, capping at two, disabling enforcement retries, and stopping new dispatch limits exposure without claiming to prevent account action.
- Browser termination can interrupt multiple workers; pre-created durable records and the existing attempted-before-click marker preserve safe reruns without duplicate submission.
- Suno selector drift can make diagnostics incomplete; fixed booleans/counts intentionally trade rich page capture for session privacy and must fail closed as changed UI.
- A manifest contains private prompts; bounded exact parsing, ignored local state, restrictive writes, and identifier-only terminal output reduce accidental exposure, but the operator must protect the source manifest and `.suno-control`.
- A live smoke depends on external login/UI availability. Fixture coverage is the required verification; live execution is additional evidence only when safely available.

## Steps

1. Extend `src/job.ts` with exact, bounded batch-manifest and queue-limit parsing while preserving single-job commands.
2. Extend `src/runtime-paths.ts` with contained per-job diagnostic paths and atomic artifact destinations.
3. Add `src/diagnostics.ts` with fixed selector probes, sanitized location/category mapping, validation, and restrictive atomic persistence.
4. Refactor `src/browser.ts` and `src/cli.ts` so one persistent context can provide isolated worker pages without weakening dedicated-profile ownership.
5. Add `src/queue.ts` with all-state-before-launch enqueueing, sequential default scheduling, bounded opt-in concurrency, safe retry eligibility, enforcement dispatch stops, and aggregate status reporting.
6. Integrate queue execution into `src/cli.ts`, retaining deterministic resume behavior, one-click submission protection, stable per-job outcomes, and guaranteed cleanup.
7. Extend `src/smoke.ts` and `src/smoke-cli.ts` with the shared redacted structure probe while preserving the no-submission dependency boundary.
8. Add manifest, queue ordering/concurrency, retry exclusion, enforcement-stop, recovery, cleanup, diagnostics-redaction, and smoke-boundary tests.
9. Extend static guardrails and package test commands to cover every new queue and diagnostic source.
10. Update `README.md` with batch operation, limits, recovery, diagnostics, smoke, profile reset, challenge handling, safe local use, and account-enforcement risk.
11. Run the build, full test suite, targeted queue/diagnostic/CLI/smoke tests, and one non-submitting live smoke only when login state safely permits.
