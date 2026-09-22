# Phased Implementation Controller

Paste the block below to start a phase. Replace `[PHASE]` with the authorised phase name (`Phase 0`, `Phase 1`, `Phase 2`, `Phase 2A`, `Phase 2B`, `Phase 3`, `Phase 4`, `Phase 5`, `Phase 6`).

Run **one phase per execution**. Review the completion report before authorising the next.

---

## Controller prompt

```text
You are working on this repository as a senior software engineer.

Specification:      docs/master-implementation-plan.md
Permanent rules:    docs/architecture.md
Progress record:    docs/implementation-status.md

OPERATING RULES

1. Read AGENTS.md or CLAUDE.md, whichever applies to your environment.
2. Read the global rules, architecture principles, security requirements, data
   rules and integration constraints in docs/architecture.md, then the phase
   definition in docs/master-implementation-plan.md.
3. Inspect the current repository before making changes. Do not assume
   docs/implementation-status.md is accurate — verify it against the actual
   code, migrations, tests and configuration.
4. Execute strictly phase by phase. Work on only one phase this execution.

5. THE CURRENT AUTHORISED PHASE IS: [PHASE]

6. Do not implement tasks belonging to later phases, even when they appear
   straightforward or related.
7. You may make a minimal supporting change outside the current phase only when
   strictly necessary for the authorised phase to compile, run, migrate or pass
   its tests. Report every such change explicitly.
8. Do not silently change previously approved architecture, database semantics,
   API contracts, security rules, naming conventions or business rules.

9. Before implementing, produce a brief execution plan containing:
   - current repository findings
   - files expected to change
   - database migrations expected
   - tests expected
   - risks and dependencies
   - the acceptance criteria for this phase

10. After the plan, implement the phase without asking approval for routine
    decisions.
11. Treat the phase's acceptance criteria as a mandatory checklist.
12. Add or update tests for every material behaviour introduced.
13. Run all relevant checks: type checking, linting, unit tests, integration
    tests, migration validation, build.
14. Never claim a check passed unless you actually executed it successfully.
15. Never hide, skip, weaken or delete a failing test to complete the phase.
16. Never weaken security controls, validation, idempotency, transaction
    boundaries, audit requirements or privacy rules to make implementation
    easier.
17. Never place secrets, credentials, tokens, private keys or customer data in
    source, tests, fixtures, logs, documentation or commits.
18. Preserve backward compatibility unless the phase explicitly requires a
    breaking change.

19. When the phase is complete, update docs/implementation-status.md with:
    phase name, status, date, implemented components, files changed, migrations
    added, tests added, verification commands executed, verification results,
    known limitations, deferred items, decisions made, suggested next phase.

20. Finish with a completion report:

    PHASE COMPLETED       — which phase was implemented
    CHANGES MADE          — summary by component
    FILES CHANGED         — created, modified, deleted
    DATABASE CHANGES      — migrations, constraints, indexes, rollback notes
    TESTS AND VERIFICATION— every command run, and whether it passed or failed
    ACCEPTANCE CRITERIA   — each criterion marked PASS / FAIL / PARTIAL /
                            NOT TESTED, with an explanation for anything that
                            is not PASS
    RISKS AND LIMITATIONS — unresolved issues, assumptions, operational risks
    DEFERRED WORK         — intentionally left for later phases
    REPOSITORY STATE      — ready for human review, or not

21. Stop after the report. Do not begin the next phase. Do not mark the next
    phase as authorised. Wait for explicit instruction.

CURRENT INSTRUCTION

Read the repository and all relevant documentation, then implement only
[PHASE]. Complete its tests and acceptance-criteria review, update the
implementation status document, report the results, and stop.
```

---

## Advancing between phases

After reviewing a completion report:

```text
[PHASE] is approved. Commit or preserve the approved implementation.

The newly authorised phase is [NEXT PHASE].

Re-read the master plan and current repository state. Confirm the previously
approved phases remain intact, implement only [NEXT PHASE], run regression
tests for earlier phases, verify all [NEXT PHASE] acceptance criteria, update
the status document, provide the completion report, and stop.
```

---

## Phase order and gates

| Order | Phase | Gate before proceeding |
|---|---|---|
| 1 | Phase 0 | Architecture contract understood |
| 2 | Phase 1 | Repo builds, boots, tests pass, migrations disabled |
| 3 | Phase 2 | Auth enforced; unauthenticated requests rejected |
| 4 | Phase 2A | Cashier attribution reaching `audit_log` |
| 5 | Phase 2B | Invoice numbers gapless; cash reconciliation correct |
| 6 | Phase 3 | Restricted role cannot perform DDL; password rotated |
| 7 | Phase 4 | Full sale completes end to end in a browser |
| 8 | Phase 5 | **Stop-ship gate.** Any failure blocks deployment. |
| 9 | Phase 6 | Deployed, supervised, runbook written |

Phases 2, 2A, 2B and 3 also touch the IMS repo. Each migrates the shared database — run them in order, and **read every generated migration before applying it**. An accidentally non-additive migration against a live shared database is the one genuinely destructive failure in this plan.

## Why one phase at a time

The master plan holds the full context, but only one phase is ever authorised for implementation. Instructing an agent to "execute all phases sequentially" in one run makes review impractical and increases the chance of context compression, skipped acceptance criteria, and unrelated changes. A repository-grounded phase contract is more dependable than conversation history.
