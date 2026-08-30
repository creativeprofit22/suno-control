# August 2026 implementation baseline

Verified on **2026-08-30**. This record is dated: re-check every source before changing the supported runtime or browser automation.

## Playwright and runtime evidence

| Item | Verified value | Evidence |
| --- | --- | --- |
| Latest stable Playwright | `1.62.1`, released 2026-07-30 | [Official GitHub release](https://github.com/microsoft/playwright/releases/tag/v1.62.1) and [official release notes](https://playwright.dev/docs/release-notes) |
| Playwright-supported Node.js lines | Latest `22.x`, `24.x`, or `26.x` | [Official installation system requirements](https://playwright.dev/docs/intro#system-requirements) |
| Project minimum Node.js | `22` | Chosen as the oldest Playwright-supported line |
| Bundled Chromium | Revision `1234`, version `151.0.7922.34` | [Official Playwright 1.62.1 browser manifest](https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/playwright-core/browsers.json) |
| Persistent profile behavior | Stores cookies and local storage; one browser instance per user-data directory; requires a dedicated profile | [Official Playwright 1.62.1 BrowserType source](https://github.com/microsoft/playwright/blob/v1.62.1/docs/src/api/class-browsertype.md#user-data-dir) |
| Local dependency lock | `playwright@1.62.1` | `package.json` and `package-lock.json`, confirmed by the commands below |

Installed confirmation commands run on 2026-08-30:

```text
npm ls playwright --depth=0
npx playwright --version
node -e "const p=require('./node_modules/playwright-core/browsers.json'); const c=p.browsers.find(x=>x.name==='chromium'); console.log(JSON.stringify(c))"
node --version
```

Observed local results: Playwright `1.62.1`; Chromium revision `1234`, browser `151.0.7922.34`; Node `v22.20.0`.

## Sanitized Suno UI inspection

This table records only fixed selector keys, bounded counts, route classes, and confidence. It never records page text, account details, prompts, raw URLs, cookies, storage, tokens, or network traffic. `absent` is evidence, not permission to invent a selector.

| UI state | Visible route class | Central selector key | Observed state | Inspection date | Confidence |
| --- | --- | --- | --- | --- | --- |
| Creation | `create` | `advancedTab`, `moreOptions`, `lyricsPrompt`, `stylePrompt`, `createButton` | `visible`, count `1` each | 2026-08-30 | High |
| Instrumental mode | `create` | `instrumentalMode` | `absent` before non-destructive More Options expansion; current radio label remains `Instrumental` | 2026-08-30 | High |
| Authentication | `create` | `loginMarker` | `absent` | 2026-08-30 | High for absence; authenticated state confirmed only by visible Create structure |
| Naturally occurring challenge | `create` | `challengeMarker` | `absent` | 2026-08-30 | High |
| Generation status | `create` | `resultContainer` | `visible`, count `20` | 2026-08-30 | High for this page view |
| Download controls | `create` | `downloadControl` | `absent` | 2026-08-30 | High for this page view |

Inspection safety record:

- `submitted=false`
- `creditsConsumed=false`
- The inspection classified the route as `create` and the hydrated structure as `structure-ready`.
- No login or challenge state was inferred beyond the visible markers and route classification.
- Only navigation, bounded visibility/count probes, screenshots, and non-destructive tabs are permitted.
- Filling fields, clicking Create, triggering challenges, modifying tracks, and downloading media are forbidden.
- Screenshots stay ignored under `.suno-control/` because they may contain account details.
