# iapetus-gather-1

**Written by the agent (Claude, 2026-10-07), to be corrected by Shaun.** The gold answers are a first judgement of
what a good gather curator should do with these cases. Change `gold.json` where you disagree; the scores follow.

`packet.json` is 12 cases from a gather packet of iapetus's records at `e851638`: 4 drift and 8 similar, three of
them loose groups. `gold.json` is the proposals file a good curator would write for it. Score curators with:

```sh
remembrancer curate --eval eval/iapetus-gather-1 --curator "CMD" [--curator "CMD2"]...
```

Run it from a checkout of iapetus at about that commit: a dry run of each proposed action checks it against the
project's records.

## The judgements

Seven of the twelve cases should be **left alone**: a curator that acts on them loses precision. A curator that does
nothing scores F1 0, since five cases need action.

| case | kind | gold | why |
|---|---|---|---|
| c1 | drift | leave alone | T176–T178 cite deleted files on purpose, "at `412f938`"; two ambiguous bare names are a hand fix, not a flag |
| c2 | drift | leave alone | done entries recording what was moved and deleted; history, not drift |
| c5 | drift | leave alone | A074 cites a test file that was later deleted; history |
| c9 | drift | leave alone | A191 extends A190 and already cites it; nothing shows A190's condition holds |
| c11 | similar (loose) | cluster T186, T187, T188, T225: "mass from the ledger" | T185, T236 and T201 share only references; T133 waits on the theme, borderline |
| c14 | similar (loose) | archive T122, low | dropped as superseded; T124 is unrelated beyond citing A007 |
| c16 | similar | leave alone | T136 and Q143 already cite each other |
| c21 | similar | cluster T227, T228, T229, T230: "jacobian and integrator reuse" | one line of work under A183 |
| c27 | similar (loose) | leave alone | a plan and a tooling task share only T263 |
| c29 | similar | leave alone | K005 and T238 already cite each other |
| c36 | similar | cluster A010, A134, Q114, T146: "half-turn crossings"; archive T146, low | T146 only restated Q114 |
| c39 | similar | cluster A156, T081, T135: "viewer camera"; archive A101–A105 and T132, low | the five stubs say they record no lasting decision; T132 was dropped |

Matching is by action and the IDs it names: a cluster's label and every `why` are not compared. Clusters also score
by overlap (the best Jaccard of each gold cluster's members against a proposed cluster), so one member off still
counts most of the way.
