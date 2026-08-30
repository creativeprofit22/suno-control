# Architecture

The dependency direction is deliberately one-way:

```text
main -> CLI/application -> domain/contracts
main -> local adapters -> contracts/domain/config
Suno Playwright adapter -> contracts/domain/config/output storage/selectors
```

Only `src/main.ts` selects concrete implementations. Application and CLI code therefore remain reusable if the browser transport changes.

## Modules and public contracts

### `src/domain/job.ts`

Owns `SunoJob`, normalized generation options, deterministic identifiers, tracked jobs and outputs, lifecycle transitions, resume decisions, and strict saved-state validation. It performs no filesystem, command-line, path, browser, or selector work.

### `src/application/contracts.ts`

Defines the browser-neutral boundaries:

- `JobRepository` loads, atomically saves, and reconciles outputs for validated job identifiers.
- `OutputStore` checks and collision-safely persists outputs beneath a job directory.
- `SunoAutomation.open()` returns a `SunoSession`.
- `SunoSession.submit()` requires a checkpoint callback immediately before submission; `observe()` returns semantic outcomes; `close()` releases the session.

Outcomes contain fixed status codes, bounded visible receipt identity, tracked outputs, and redacted facts. They never expose Playwright pages, locators, browser contexts, downloads, raw page text, account data, or session material.

### `src/application/run-jobs.ts`

Owns queue preparation, resume behavior, pre-submit persistence, semantic outcome mapping, and stable job transitions. It imports contracts and domain values, not Playwright or concrete adapters. An ambiguous attempted submission becomes `unknown` and is never submitted again.

### `src/cli/parse.ts` and `src/cli/presentation.ts`

Parse bounded arguments and manifests, then present stable redacted messages and exit codes. They depend on application contracts and domain values. Manifest bytes, queue length, concurrency, retries, fields, and duplicate jobs are bounded and validated before execution.

### `src/config.ts`

Owns supported runtime constants, public Suno origin and Create URL, bounded timing defaults, and contained runtime/job path resolution. It performs no browser actions.

### `src/persistence/local-job-repository.ts`

Implements `JobRepository` with strict JSON validation, contained output paths, restrictive directories/files, and atomic replacement. It does not import Playwright, Suno modules, or CLI code.

### `src/downloads/local-output-store.ts`

Implements `OutputStore`. It accepts only regular temporary files within the controlled download directory, sanitizes filenames, contains final paths, and preserves collisions through exclusive copies. It does not accept browser objects or overwrite media.

### `src/suno/selectors.ts`

Is the sole owner of Suno role, test-id, CSS, and URL-state locators. Absence is reported as evidence; runtime code does not broaden selectors by guessing.

### `src/suno/playwright-adapter.ts`

Implements `SunoAutomation` using a visible persistent Chrome context and dedicated profile. The Suno zone owns preparation, one guarded Create click, manual challenge pauses, completion observation, supported Playwright downloads, and redacted diagnostics. It does not inspect cookies, storage, tokens, or network traffic and does not call private APIs.

### `src/main.ts`

Is the composition root. It creates configuration, the local repository, local output store, and Playwright adapter, then invokes the browser-neutral CLI workflow.

## Enforced boundaries

`test/architecture.test.mjs` parses every relative static import, checks the complete source graph for cycles, and rejects:

- Playwright imports outside `src/suno/`;
- inward Suno or CLI imports from domain, persistence, or downloads;
- concrete adapter or selector imports from CLI/application code;
- Suno locator construction outside `src/suno/selectors.ts`;
- submission-capable dependencies reachable from the live inspection entry point;
- cookie/storage extraction, traffic interception, stealth, forced input, private APIs, and automated challenge behavior.

The test uses only Node's standard library and runs in `npm test` on Windows and Ubuntu.

## Future official API adapter

If Suno publishes a supported API, add an adapter implementing `SunoAutomation` and `SunoSession`. Keep API authentication, request/polling behavior, and response-to-semantic-outcome mapping inside that adapter. Select it only in `src/main.ts`.

No changes should be required in job normalization, lifecycle transitions, `run-jobs.ts`, CLI presentation, local persistence, or output storage. The API adapter must preserve the same pre-submit checkpoint and ambiguous-outcome rules; no speculative private API implementation belongs in this repository.
