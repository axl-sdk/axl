# Eval import samples

Sample `EvalResult` JSON files for manually testing Studio's **Import result** button on the Evals panel. Each file exercises a different branch of the import flow.

Start the dev studio (which auto-seeds qa-eval history) from the repo root:

```bash
pnpm --filter @axlsdk/studio dev
```

Then open the Evals panel and click **Import result** in the header. Pick one of the files below.

## A note on imports and the Rescore button

Today, imported files land in history under the result's workflow name, **not** the original registered eval name. That's because `axl-eval --output` writes a raw `EvalResult` which has no eval-name field — the eval name only exists on the history entry, not in the result itself. So Rescore is disabled for imported entries because their derived eval name (`qa-workflow`, `external-system`, etc.) never matches a registered eval (`qa-eval`).

This is a known tradeoff — see `sample-native.json` below. To verify the **Rescore enabled** path, rescore a natively-run entry instead (e.g. any of the seeded `qa-eval` Group A/B runs in the History tab).

## A note on the `workflow` field shape

- **0.14+ artifacts** carry workflow names in `metadata.workflows: string[]` (plus `metadata.workflowCounts`). This is the shape `axl-eval --output` produces today. `sample-native.json` uses this shape.
- **Pre-0.14 artifacts** carried a single-string `workflow` at the top level of the result. `sample-external.json` uses this legacy shape to exercise Studio's backward-compatibility fallback — the import handler reads `metadata.workflows[0]` first, then falls back to the top-level field.

## Files

### `sample-native.json`

A valid `EvalResult` in the **modern shape** (post-0.14): `metadata.workflows: ["qa-workflow"]` instead of a top-level `workflow` field. Same `dataset` (`qa-basics`) and same scorer set as the registered `qa-eval`.

- Appears in **History** under the eval name `qa-workflow` (derived from `metadata.workflows[0]`)
- **Rescore** button is **disabled** (the derived eval name doesn't match a registered eval — expected limitation, see above)
- **Can be compared** against seeded Group A/B runs because the dataset and scorer set match

Use this to test: the modern import path, cross-source compare (native-seeded vs imported), and the "Rescore unavailable" tooltip.

### `sample-external.json`

A valid `EvalResult` in the **legacy pre-0.14 shape** — single-string top-level `workflow: "external-system"` and no `metadata.workflows`. Studio's import handler falls back to the legacy field. Dataset is still `qa-basics` and scorer set still matches, so compare works.

- Appears in **History** under the eval name `external-system`
- **Rescore** button is **disabled** with the tooltip explaining why
- Can be compared against seeded qa-eval runs

Use this to test: the visual distinction between native-seeded and imported entries in the history table, and the rescore disabled tooltip.

### `sample-dataset-mismatch.json`

A valid `EvalResult` with `dataset: "different-dataset"`. Importable without error, but attempting to compare it against any seeded qa-eval run triggers the server's `COMPARE_FAILED` path.

- Imports successfully
- Pick it as baseline or candidate in the Compare tab, select any seeded run on the other side, click Compare
- Expected: global error banner appears below the tabs bar with a message about mismatched datasets
- Dismiss the banner with the × button

Use this to test: structured compare error surfacing via the new global error banner.

### `sample-invalid-shape.json`

**Not** a valid `EvalResult` — missing `items`, `summary`, and `dataset`. The server rejects it with a 400 `BAD_REQUEST` and a message naming the first missing field.

Use this to test: server-side shape validation and the global error banner on the Evals panel.

## Testing `--read-only` mode

Run the dev server in read-only mode:

```bash
pnpm --filter @axlsdk/studio dev:read-only
```

Verify on the Evals panel:

- ✅ **Import result** button is **hidden** in the header
- ✅ **Run** button, eval selector, and runs counter are **hidden**
- ✅ **Rescore** button in the History tab is **disabled** with a tooltip that says "Studio is mounted in read-only mode"
- ✅ **Delete** button (trash icon) in the History tab is **disabled** with the same tooltip
- ✅ **Export** button (download icon) in the History tab is **still enabled** — exporting is a read-only operation and never gets blocked
- ✅ **Compare** tab still works end-to-end on the seeded history — compare is pure computation and remains available
- ✅ `GET /api/health` returns `{ readOnly: true }` (check via browser devtools or `curl http://localhost:4400/api/health`)

## Testing Export / Delete (standard mode)

```bash
pnpm --filter @axlsdk/studio dev
```

- **Export**: History tab → click the download icon on any row → verify a file `<eval>-<short-id>-<iso-date>.json` downloads. Open it — should be a full valid `EvalResult` (you can re-import it via **Import result** to round-trip).
- **Delete**: History tab → click the trash icon on any row → confirm the native dialog → verify the entry disappears from the list and the Compare tab's picker. If you had the entry selected as baseline or candidate, that selection clears automatically.
- **Delete + Compare edge case**: select a run as baseline in the Compare tab, go to History, delete that same run, return to Compare — the baseline selector has cleared and the picker only shows remaining entries.

## Testing client-side JSON parse errors

Click **Import result** and select any non-JSON file (e.g. this README). The client catches the `JSON.parse` error and displays it in the global error banner with a filename-specific message.
