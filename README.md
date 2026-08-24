# suno-control

A local-only CLI foundation for validating one typed Suno job and opening Suno in a visible, bundled Chromium browser. This phase does not generate or submit music.

## Requirements

- Node.js 20 or newer

## Setup

```sh
npm install
npm run install-browser
```

## Usage

```sh
npm start -- --prompt "instrumental test" --style "ambient" --model "test-model" --instrumental
```

`--prompt` is required and must not be blank. `--style` and `--model` are optional non-blank strings. `--instrumental` is a boolean flag. Model names are intentionally accepted as opaque values because Suno controls model availability.

The CLI validates the job without printing its contents, opens `https://suno.com/create`, and waits. If sign-in controls are visible, authenticate manually in the open browser and press Enter to re-check. The check is a visible-page heuristic; a ready message does not claim that the account is authenticated. The CLI never automates login or challenges.

## Local browser data

All browser material is confined to `.suno-control/`:

- `browser-profile/` stores the dedicated Chromium profile and its session cookies.
- `downloads/` stores accepted browser downloads.

Never copy, publish, or share `.suno-control/`. Deleting it removes the automation profile and logs that profile out. Only one CLI browser can use the profile at once; close the other CLI browser before retrying.

The project does not attach to an installed browser profile, expose remote debugging, export or import browser state, read cookies or JWTs, load environment secrets, call private Suno APIs, use stealth behavior, or capture screenshots, traces, or network traffic. Generated profiles, downloads, build output, logs, local state, and secret files are ignored by version control.

## Development

```sh
npm run build
npm test
```
