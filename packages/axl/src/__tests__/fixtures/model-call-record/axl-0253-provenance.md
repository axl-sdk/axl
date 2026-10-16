# Legacy Axl v1 journal provenance

- Repository commit: `681b7317a0a156940dcc7702a0c1964120565595`
- Package: `@axlsdk/axl@0.25.3`
- Working tree: `/private/tmp/axl-capture-legacy`
- Generator: `legacy-journal-generator.ts` (untracked, local synthetic provider)
- Exact command, from the working-tree root: `pnpm --filter @axlsdk/eval exec tsx ../../legacy-journal-generator.ts`
- Output: `/tmp/axl-legacy-0253-journal.jsonl`, 7 JSONL lines emitted by the old `RequestCaptureChannel` sink without post-processing.
- Copied fixture: `axl-0253.jsonl`; SHA-256 `0402203230e5b879aae10da8631a3566b1ad1691073d6dccb6eb3e7f5e34df70`.
- Cases: caseIndex 0 successful chat; 1 provider 400 error; 2 stream closed by consumer after one text delta; 3 start-only chat with a never-settling local promise.
- The old v1 emitter records the stream close reason but no partial content. Its error projection also omits the synthetic error's request ID. Those absences are original emitter behavior.
- Network calls: zero. The provider is registered locally; no credentials are read.
