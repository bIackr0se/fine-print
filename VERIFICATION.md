# Fine Print 0.1.0 verification

Verified on 2 October 2026 with Claude Code 2.1.287 and Claude Desktop 2.19675.0 on macOS, in a new local Code session.

## Consumer installation

The release ZIP was extracted into a permanent folder and installed with `install.sh local` from a fresh synthetic repository. The session loaded the installed plugin, without a session development mod. All 16 packaged files matched the extracted files byte for byte; the installed hook matched the packaged hook.

## Native behavior exercised

- A real Read/Edit turn changed a checkout calculation and a CI step, then ran the fixture test. The deliberately staged answer named only the checkout change. Fine Print opened the CI card and displayed its recorded diff.
- Full diff displayed the recorded hunk.
- Ask Claude appended its question to an existing draft, preserved that draft, and did not send anything.
- Close dismissed the card. One subsequent `/fineprint` reopened it visibly. The same immediate reopening worked after Ask Claude dismissed the card.
- `/fineprint off` and `/fineprint on` returned the expected mode changes.
- A later turn restored the CI step and named it in the answer. Fine Print cleared the previous finding and displayed its clean-turn state.

Native button activation was checked using focused keyboard activation as well as accessibility-driven controls. First-click mouse behavior has not been independently certified across desktop layouts. Other operating systems, terminal renderers, cloud sessions, and future Claude versions were not exercised.

## Deterministic checks

Plugin and marketplace validation passed. All 42 plugin tests passed. Two lifecycle regression tests failed against the previous implementation and passed against this release. The tests cover audit matching, turn isolation, draft preservation, reopening, deferred dismissal, and close-failure reporting.

## Scope

Fine Print checks recorded main-conversation tool events and bounded text patterns. It is not a complete account of every command, every claim, or every action. It makes no model, network, filesystem, or process calls of its own. Its question remains an editable draft until the user sends it.

The 30-second demo uses reconstructed UI and a synthetic repository. Its explanatory callout is part of the film; the installed card shows the recorded evidence.
