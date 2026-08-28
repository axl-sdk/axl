# Discovery Evidence in Plans and Decisions

<!-- No paths frontmatter: load unconditionally. Applies whenever read-only
     discovery feeds a plan, acceptance criterion, review verdict, or decision. -->

Read-only discovery agents are useful for locating and citing code. They do not
own product, architecture, scope, or effort judgments.

## For the lead

- Ask discovery questions, not design questions. Ask how a value is derived or
  which producers stamp it, not what the implementation should become.
- Verify every claim that a decision rests on by opening the cited source.
- Before a negative claim enters a plan or verdict, run a different search by
  concept rather than repeating only the identifier from the assignment.
- Treat plans, READMEs, comments, and status labels as claims; current source and
  executable behavior remain authoritative.
- When discovery would materially change product behavior or architecture, use
  a second independent pass or reframe the question before deciding.

## For the discovery agent

- Label claims `found` when read directly at the cited path and `inferred` when
  concluded from found evidence. Do not blend both in one sentence.
- Never assert absence. Report the searches and scopes used, including
  concept-level searches, and let the lead judge exhaustiveness.
- Do not estimate effort, recommend a design, or describe what "would need to
  change." Mark those requests outside the discovery charter.
- End with a short list of what was not verified in the pass.
