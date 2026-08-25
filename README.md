# suno-control

A local Windows CLI that validates one Suno job and submits it through Suno's visible Create page. It uses Playwright locators only; authentication and interactive challenges remain manual.

## Requirements

- Node.js 20 or newer
- Google Chrome installed

## Setup

```sh
npm install
npm run install-browser
```

The bundled Chromium installed by `install-browser` is used only by controlled fixture tests. Runtime automation uses installed Google Chrome so the dedicated profile matches the browser used for manual authentication.

## Authenticate once

Google rejects sign-in inside Playwright-controlled browsers. Authenticate before running the CLI by opening ordinary Chrome with the dedicated project profile from PowerShell:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
  "--user-data-dir=$PWD\.suno-control\chrome-profile" `
  "https://suno.com/create"
```

Sign into Suno with the provider originally connected to the account. If Chrome offers to enable browser sync, choose **Use Chrome without an account**; Suno's site session is sufficient. Confirm Create loads, then close every window using this dedicated profile before running the CLI.

Never point the CLI at your normal Chrome profile.

## Submit a job

```sh
npm start -- --prompt "a midnight train" --style "ambient" --model "v5" --instrumental
```

`--prompt` is required. `--style` and `--model` are optional non-blank strings. `--instrumental` is a boolean flag. Job contents are never printed.

The CLI opens `https://suno.com/create`, selects **Advanced**, and uses the current visible controls:

- non-instrumental prompts use the exact **Prompt** lyrics mode;
- `--style` fills the confirmed 1,000-character Styles field;
- instrumental jobs select the exact **Instrumental** radio and combine prompt plus optional style in Styles;
- `--model` selects an exact visible model name from Suno's model menu;
- submission clicks **Create song** once without retries.

Confirmed model names at implementation time are `v5.5`, `v5`, `v4.5+`, `v4.5`, `v4.5-all`, `v4`, `v3.5`, and `v3`. Suno can change availability. Missing or ambiguous controls fail closed as `changed-ui`.

## Outcomes

The process prints one stable outcome and exits distinctly:

- `0` — submitted
- `3` — login required
- `4` — browser session failed
- `5` — Suno validation error
- `6` — Suno rate limit
- `7` — changed or unconfirmed UI

A post-click timeout never retries because Suno may have accepted the job already.

If CAPTCHA or another interactive challenge appears, automation pauses without touching the page. Complete it manually in Chrome and press Enter. Submission resumes only after that explicit continuation.

## Local browser data and privacy

All runtime material remains inside `.suno-control/`:

- `chrome-profile/` stores the isolated Suno session;
- `downloads/` stores accepted browser downloads.

Never copy, publish, or share `.suno-control/`. Deleting the profile logs it out. Only one Chrome process can own the profile at once.

The application does not export storage state, read cookies or tokens, intercept requests, expose remote debugging, modify browser-identifying signals, use stealth behavior, simulate human input, solve challenges, call private Suno APIs, or capture screenshots, traces, and network traffic.

## Development

```sh
npm run build
npm test
```

Tests use controlled local page fixtures and never submit to Suno production. CI installs the pinned Playwright Chromium build before running them.
