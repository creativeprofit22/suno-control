# suno-control

A local Windows CLI that submits bounded Suno job queues through the public, visible Create page and saves completed media. Authentication and interactive challenges remain manual.

## Requirements and setup

- Node.js 20 or newer
- Google Chrome installed

```sh
npm ci
npm run install-browser
```

Runtime automation uses installed Chrome with `.suno-control/chrome-profile`. The installed Playwright Chromium is only for fixture tests. Never use your normal Chrome profile.

## Authenticate and reset the dedicated profile

Open ordinary Chrome from PowerShell before the first run:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  "--user-data-dir=$PWD\.suno-control\chrome-profile" `
  "https://suno.com/create"
```

Sign into Suno, confirm Create loads, then close **every** window using this profile. Only one Chrome process can own it. If login or a challenge appears during automation, complete it manually in the visible browser, close that browser, then rerun the same job.

To reset a broken dedicated profile, close Chrome first, then move or delete only `.suno-control/chrome-profile`. This logs Suno out but preserves job state and downloaded outputs. Never delete all of `.suno-control` to reset login.

## Submit one job

```sh
npm start -- --prompt "a midnight train" --style "ambient" --model "v5" --instrumental
```

`--prompt` is required. `--style` and `--model` are optional non-blank strings. `--instrumental` is a boolean flag. Job contents are never printed. Submission clicks **Create song** once.

## Submit a batch

Create `jobs.json` as an array of 1–100 exact job objects:

```json
[
  {
    "prompt": "a midnight train",
    "options": { "instrumental": false, "style": "ambient", "model": "v5" }
  },
  {
    "prompt": "bright brass fanfare",
    "options": { "instrumental": true }
  }
]
```

Each object permits only `prompt` and `options`. `options` requires boolean `instrumental` and permits only optional non-blank `style` and `model`. The manifest must be a regular JSON file no larger than 1 MiB. Duplicate deterministic jobs are rejected.

```sh
npm start -- --jobs jobs.json
npm start -- --jobs jobs.json --concurrency 2 --retries 1
```

`--jobs` is mutually exclusive with generation fields. `--concurrency` defaults to `1` and accepts only `1` or `2`. `--retries` defaults to `0` and accepts only `0` or `1`.

Concurrency `2` opens two isolated Create pages in one persistent profile context. It increases account pressure; use the sequential default unless the extra pressure is understood.

A retry is allowed only for browser launch, navigation, or session failure while durable state proves no submission attempt. The CLI never retries a Create click or retries login, challenge, validation, changed UI, ambiguous acceptance, rate limiting, or account blocking. Rate-limit or account-block outcomes stop new dispatch; already running jobs settle and untouched jobs remain queued.

## Status, exits, and recovery

Every transition prints queue position, an eight-character deterministic identifier, retry attempt when applicable, and a stable status. The final line counts terminal statuses. It never prints prompts, styles, manifest data, or raw errors.

The aggregate exit is `0` only when every job completed. Otherwise the highest numeric action-priority exit is returned:

- `2` invalid command or manifest
- `3` login required before submission
- `4` browser or navigation failure
- `5` validation rejection
- `6` visible rate limit
- `7` changed or ambiguous submission UI
- `8` visible generation failure
- `9` blocked work or jobs left queued after enforcement
- `10` ambiguous or unsafe local state requiring review

Before Chrome opens, every batch entry gets validated durable state under `jobs/<sha256>/`. Rerunning identical normalized input resumes that state. Completed jobs with present outputs do not reopen Chrome. Confirmed work resumes observation. Attempted-but-unconfirmed work remains `unknown` and never clicks Create again.

## Redacted diagnostics

Incomplete jobs write `.suno-control/jobs/<sha256>/diagnostic.json`. Smoke writes `.suno-control/smoke/outcome.json`. Diagnostic failure never replaces the original job outcome.

Versioned diagnostic JSON contains only timestamp, stable identifier, fixed stage/category, a sanitized location classification, and fixed count/visibility entries for:

- Advanced tab, More Options, lyrics prompt, Styles field, Instrumental mode, and Create control;
- login marker, challenge marker, result container, and Download control.

It excludes raw URLs, query strings, page text/HTML/title, exception messages, screenshots, console/network data, cookies, headers, storage state, prompts, and account names. Writes are contained, atomic, and use restrictive local permissions where supported.

The selectors most likely to drift are the Advanced tab, More Options button, exact lyrics label, Styles `maxlength`, model menu, Create button, result groups, and Download control.

## Non-submitting live smoke check

Close all dedicated-profile windows, then run:

```sh
npm run smoke:live
```

Run smoke before submitting work after Suno changes its UI. It uses the same Create preparation and selector probe, but its dependency graph cannot reach submission and it never clicks Create or consumes credits. It may pause for manual challenge completion. Exit codes are `0` ready, `3` login required, `4` browser/artifact failure, and `7` changed UI.

Smoke saves `.suno-control/smoke/live-smoke.png` and the redacted `outcome.json`. The screenshot is intentionally local and may contain account details; the JSON does not.

## Local data and operating risk

`.suno-control/chrome-profile` stores the isolated session. `downloads/` is temporary staging. `jobs/<sha256>/state.json` stores private job inputs and recovery data. `jobs/<sha256>/outputs/` stores media. Existing output files are never overwritten.

Keep `.suno-control` private, avoid shared machines, and protect the source manifest. Never publish or copy the profile. The CLI does not export sessions, read cookies or tokens, intercept requests, call private Suno APIs, manipulate browser identity, use stealth or proxies, solve challenges, or capture traces/network traffic.

Browser automation may violate Suno terms or trigger rate limits, account blocks, suspension, or other enforcement. Concurrency increases that risk. This tool provides no guarantee against account action; use only an account and content you are authorized to operate.

## Development

```sh
npm run build
npm test
npm run test:queue
npm run test:limits
npm run test:diagnostics
npm run test:cli
npm run test:smoke
npm run test:docs
```

Fixture tests never submit to Suno production. `npm run smoke:live` is the only live check and remains non-submitting.
