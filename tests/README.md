# Test scripts

Two kinds of scripts live here: headless test suites, and browser scripts that drive the demo.

## Headless suites

`test-ws.mjs` (the workspace: normalization, navigation, swaps, grouping, closing, placement, prompt columns…) and `test-drop.mjs` (drop logic) run without a browser. They load `src/` through Vite's SSR loader, so they need no build and no dev server. Each prints one line per check (`ok` or `FAIL`) and exits with 1 if any check fails.

```sh
npm test          # both suites
node tests/test-ws.mjs
```

They run in Node, without a DOM: they can import the model, the workspace, and DOM-free modules (`src/prompt.ts`), but not `src/view.ts`.

`squeeze.mjs` is headless too, but exploratory: it prints weights, and checks nothing.

## Browser scripts

All the other scripts drive the demo page with Playwright, at `http://localhost:5317`. They print what they observe (selections, rects, scroll positions…), and some take screenshots into `/tmp`. They check nothing by themselves: read their output, or the screenshots. Each one is about a feature or a past bug, as its name says (`prompt.mjs`, `sticky.mjs`, `float2.mjs`…), and sometimes a comment at the top.

They need the dev server on port 5317 (`--strictPort`: it fails rather than pick another port):

```sh
npm run serve:test                  # in one terminal
node tests/prompt.mjs         # in another
```

Most use Chromium; `repro2.mjs` uses WebKit. Install the browsers once with `npx playwright install chromium webkit`.

`allexamples.mjs` loads every example of the demo and reports page errors: a quick smoke test after a change.

Writing a new one: copy a similar script. The demo exposes `window.ws`, `window.view` and `window.nav` (see `demo/main.ts`), for scripts to inspect the state; the status line (`#status`) shows the selection and the maximization.
