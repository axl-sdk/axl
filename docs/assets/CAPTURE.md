# Visual assets — capture checklist

This folder holds the images, GIFs, and diagrams referenced from the READMEs.

All four flagship Studio panels are **already captured** (dark mode, real
`openai-responses:gpt-5.5` / multi-provider labels) as animated GIFs with static
`.png` first-frame fallbacks. Only the social-preview card remains.

## Captured ✅

| File | Used in | Notes |
| --- | --- | --- |
| `studio-trace-explorer.gif` (+ `.png`) | root README hero + Studio README | Selecting an execution → waterfall with per-step cost/duration. |
| `studio-cost-dashboard.gif` (+ `.png`) | root README "Axl Studio" section + Studio README | Time-window toggle; Cost-by-Agent / Cost-by-Model across providers. |
| `studio-eval-runner.gif` (+ `.png`) | Studio README | Eval Trends: By Scorer → By Model → Duration (gpt-5-mini → 5.4 → 5.5 upgrade story). |
| `studio-playground.gif` (+ `.png`) | Studio README | `streaming-structured-agent`: structured output streaming in char-by-char (spec/17 typewriter). |
| `architecture.svg` | root README + `docs/architecture.md` | Hand-authored diagram; ships as-is. |

To re-capture or refresh, see "How to record" below.

## Still to produce

| File (target) | Used in | What to capture | Status |
| --- | --- | --- | --- |
| `social-preview.png` | GitHub repo social preview (Settings → Social preview) and link unfurls | 1280×640 branded card: name, one-liner, a panel screenshot. `studio-cost-dashboard.png` is a good starting frame. | Set in repo settings; not referenced from markdown. |

## How to record

1. **Launch Studio with seeded data** (no API keys, no live calls — the dev
   fixtures register `MockProvider` instances under the real provider scheme
   names, so the UI shows production-real labels with zero network traffic):

   ```bash
   pnpm dev:studio          # builds @axlsdk/axl, then Vite on :4401 + server on :4400
   ```

   `packages/axl-studio/dev-fixtures/` seeds agents, tools, workflows, evals,
   executions, and costs, so every panel is already populated. Open
   **http://localhost:4401**. Switch to dark mode via the toggle at the bottom of
   the sidebar (System → Light → Dark).

   > **Tip:** the live-seed (`seedLive`) runs a burst of workflows at startup,
   > which makes the Trace Explorer's *Live Events* feed churn. Wait ~1 minute for
   > it to settle before capturing the Trace panel, or capture the other panels
   > first.

2. **Record short loops.** Use [Kap](https://getkap.co) or [Gifski](https://gif.ski).
   Keep each clip **≤ 10 s**, looping, **≤ 5 MB** (downscale to ~1280px wide,
   12–15 fps), cropped to the panel content.

3. **Drop the file in here** and point the README at it (`.gif`, with a `.png`
   first-frame fallback via `ffmpeg -i x.gif -vframes 1 x.png` if useful).

## Sizing reference

- README inline images render best at **≤ 960px** displayed width — set an
  explicit `width` attribute (`<img ... width="840">`) for consistency.
- GitHub may refuse to animate very large GIFs. Stay well under 5 MB (the current
  captures are 0.7–1.8 MB).
