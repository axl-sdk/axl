---
name: prompt-iteration
description: Improve Axl-owned runtime model-facing behavior through zero-provider diagnosis, minimal decision-changing live probes, explicit spend approval, qualitative result mining, and one final evidence lock. Use when creating, changing, debugging, or tuning built-in runtime prompts, model-facing schema rendering, retry feedback, routing instructions, built-in tool descriptions, or LLM scorers. Do not auto-trigger for documentation-only examples or consumer application prompts.
---

# Prompt Iteration

Improve one model behavior without making adjacent provider, structured-output,
tool, or retry behavior brittle. Read `AGENTS.md`, `CLAUDE.md`, and every
path-matched rule, including `core-sdk.md`, `providers.md`, `eval.md`, and
`testing.md` when those surfaces are involved.

## Diagnose the whole model-facing path

1. Trace the assembled system and user messages, schema guidance, native
   structured-output or tool definitions, validation and retry feedback,
   provider mapping, returned value, events, and every public consumer.
   Prove each constant or instruction being changed is reachable from the
   production runtime path; an exported prompt with no production caller is not
   evidence of changed behavior.
2. Define the intended developer-visible behavior, representative cases, and
   counter-cases that must remain flexible.
3. Inspect the failing input, raw provider output, parsed result, retry/repair
   path, scorer reasoning, and a passing sibling before deciding where the
   defect belongs.
   Treat validator, repair, and retry messages returned to the model as prompts:
   audit their content, reachability, and interaction with the initial guidance.
4. Prefer types, Zod, deterministic validation, and code for structural,
   numeric, authorization, compatibility, and data-integrity requirements.
   Leave semantic interpretation to the model. Do not make prose compensate
   for a weak schema, provider mapping, parser, scorer, or consumer.

## Spend only when the next call can change a decision

Use the least expensive proving layer in order:

1. Mine retained artifacts and traces; inspect prompt assembly, schemas,
   adapters, retry paths, fixtures, and deterministic scorers; run
   provider-free tests with `MockProvider` where they prove the behavior.
2. If provider behavior remains uncertain, propose the smallest live probe: one
   failing case and at most one nearest passing counter-case, with only the
   scorers needed for the next decision.
3. Expand one dimension at a time only for a named unresolved uncertainty.
4. After convergence, run one complete affected evidence lock at the sample
   size justified by the acceptance criterion or existing owner contract.

Before pricing or running a live eval, prove that it will execute the changed
code. Axl's workspace package exports and `axl-eval` binary normally resolve to
compiled `dist`, so source edits are not live evidence by default.

- Run `node .claude/skills/prompt-iteration/scripts/check-eval-provenance.mjs`
  from the eval's working directory. Add `--package <name>` for every other
  workspace package in the evidence path. It resolves the package entries and
  the `axl-eval` target from `@axlsdk/eval`'s manifest, requires all of them to
  be inside the current checkout, and records `HEAD` plus a working-diff hash.
  Preserve its JSON output with the eval artifact.
- If an affected package resolves to `dist`, build every changed package the
  eval will load, in dependency order, before the paid run. Build
  `@axlsdk/axl` before `@axlsdk/eval`; build the eval package itself only when
  its CLI, runtime, loader, or scorer source is part of the evidence path.
- Treat `--conditions` as a source route only when the resolved package exports
  declare that condition and a post-resolution check proves it selects the
  intended source. Do not assume `--conditions development` bypasses `dist`.
- After building or selecting a verified source loader, rerun the checker and
  invoke the reported `cliTarget` directly with Node. Do not substitute a
  global binary or an unverified package-manager wrapper.
- Keep the evidence path quiescent from that final pre-run check through result
  capture. Write the result and logs to a gitignored or outside-worktree path so
  the evidence output does not change the code fingerprint. If another writer
  may touch the tree, use an isolated worktree. Run the checker again
  immediately after capture and require the fingerprints to match; otherwise
  invalidate the result and diagnose the change before any rerun.
- If exact provenance remains ambiguous or an affected build is stale, stop
  before the provider call. The checker proves location, not freshness: the
  targeted build immediately before it is the freshness proof. A paid result
  against old code is invalid evidence.

Before a paid probe, choose an explicit `--output` artifact path. Add
`--capture-traces` when failure diagnosis needs model-facing trace evidence, and
confirm rejected, failed, or timed-out items will retain enough input, output,
error, and trace context to diagnose the run rather than forcing a blind rerun.

Before the first paid command, obtain explicit user approval for a capped
budget. Before each paid command, state the exact provider/model, cases, runs,
expected generator and judge calls, maximum estimated cost, cumulative spend,
and the decision the run can change. Obtain fresh approval for the final lock,
scope expansion, or spend beyond the approved cap. Record actual generator and
judge cost after every run and stop at the cap.

Never rerun an unchanged prompt/model/effort/input/tool/scorer tuple; reuse its
artifact. `rescore` can still invoke paid LLM judges. After the provenance gate,
use the checker-reported `cliTarget` for eval files and read its current
`--help` or source instead of copying flags. Invoke
`live-api-verification` for provider-wire claims that the eval surface or
`MockProvider` cannot establish.

## Design coherent instructions

- State the outcome, priorities, and true invariants while leaving freedom over
  valid tactics and expression.
- Restructure existing guidance instead of appending exceptions. Re-read the
  full assembled prompt after each edit for conflicts, duplication, distance,
  and unclear precedence.
- Reserve absolute language for real safety, data-integrity, authorization, or
  compatibility boundaries. Provide an honest escape path when constraints can
  conflict.
- Use examples to demonstrate boundary judgment, not a hidden algorithm. Remove
  incidental wording, counts, providers, or tool choices the model may imitate.
- Do not duplicate enum values or shapes already enforced and rendered from
  Zod. Keep prose focused on semantics the schema cannot express.
- Keep provider-independent meaning above adapter-specific wire details.

## Iterate and inspect complete evidence

Change one behavior at a time. Update every relevant agent prompt version,
cache key, fixture provenance, or eval metadata needed to distinguish old and
new behavior; add a focused invalidation test when cached or persisted output is
involved.

After every candidate, inspect each scoped input, raw output, parsed public
result, tool path, retry feedback, trace, score, scorer error, and judge
rationale—not only aggregates. Confirm the target changed for the intended
reason; inspect minima, surprising perfect scores, silent fallbacks, omissions,
and unscored quality. Validate fixture premises from first principles and grade
the production-visible parsed path, keeping raw output as diagnostic evidence.

Treat a one-run probe as directional debugging evidence, not statistical proof.
Compare only artifacts with compatible cases, order, scorer sets, and
prompt/model provenance. If the evidence cannot explain why behavior changed,
improve the diagnostic or eval surface before stacking another instruction.

## Lock and report

For the final lock, run each complete affected eval or live scenario once at
its justified sample size, apply scorer-error and live-provider trust gates,
mine every item, and compare against provenance-matched evidence. If it exposes
a real defect, reject the artifact, return to scoped diagnosis, and replace the
lock only after reconvergence.

Report the behavioral change, prompt-design rationale, provider-free checks,
each paid probe and expansion decision, estimated versus actual spend, final
evidence, qualitative failures, and residual provider or sampling ambiguity.
