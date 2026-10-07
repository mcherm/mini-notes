model/ — pure note logic

  commands.js  the note write commands, and applying them to a note
  diff.js      computing, formatting and applying note diffs (ported to
               lambdas/api-v1/src/diff.rs; the two must stay in sync)

No DOM, no network, no storage: everything here runs under Node and is tested
in tests/. Modules here import only from model/.
