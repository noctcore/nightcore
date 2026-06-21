# Debug Report: UI labels `done` as "Verified" while task.verified=false (research task)

**Date:** 2026-06-21
**Agent:** kirei-debug
**Status:** root cause confirmed

## Symptom
Persisted task `.nightcore/tasks/eb1307d6-52e7-4d1b-8bfa-3d662a7ffeea.json` ("Rust auto update system", kind=research, runMode=main) holds:
`status="done"`, `verified=false`, `review=null`, `branch=null`, `committed=true`, `merged=false`, `conflict=false`.

The UI renders that SAME task as:
- In the column whose header reads **"Verified"** (count 1).
- A green **"VERIFIED · $1.63"** badge in the detail-panel header.
- A **"Committed"** disabled state.
- A **"main"** chip on the card.

User complaint: "some fields feel not updated, like branch — it was one value earlier but now null," and broadly "UI says VERIFIED while JSON says verified=false / status=done."

## Expected
The user expected the green "Verified" wording to mean `verified===true`, and expected `branch` to retain a value it allegedly held mid-run.

## Repro
Deterministic, no live run needed: load any task with `status:"done", verified:false, runMode:"main", kind:"research", committed:true` into the board.
- It lands in the column titled "Verified" (`COLUMNS` entry `key:'done', title:'Verified'`).
- Detail header shows green "VERIFIED" because `STATUS_LABEL.done==='Verified'` + `STATUS_TEXT.done==='text-success'`.
- Card shows "main" chip + disabled "Committed".

**Reliability:** Always — purely status-derived rendering.

## Root Cause
This is a **UI labeling / semantics conflation**, NOT data corruption. Every persisted field is correct by design.

### 1. status vs verified mismatch (primary) — by-design data, misleading label
- `apps/web/src/components/board/status.ts:48-53` — the `done` status maps to a column literally titled **"Verified"**.
- `apps/web/src/components/board/status.ts:64-72` — `STATUS_LABEL.done = 'Verified'`; `:81-100` `STATUS_DOT_COLOR.done`/`STATUS_TEXT.done` are the green `success` tokens.
- `apps/web/src/components/board/Board/Board.hooks.ts:32-39` (`groupTasksByColumn`) places a task into a column **only** by `task.status`, never by `task.verified`.
- `apps/web/src/components/board/TaskDetail/TaskDetail.tsx:146-151` renders the header badge from `STATUS_LABEL[task.status]` + `STATUS_TEXT[task.status]` — green "VERIFIED" is driven by `status==='done'`, the `verified` boolean is not consulted.
- `apps/web/src/components/board/TaskDetail/TaskDetail.hooks.ts:42` — `isVerifiedColumn = task.status === 'done'` (again ignores `verified`).

Meanwhile `verified` is a *distinct* concept on the Rust side: true ONLY after an independent reviewer returns `VERDICT: PASS`.
- `apps/desktop/src-tauri/src/task.rs:150-153` — doc: "true only after an independent reviewer returned VERDICT: PASS. merge_task is gated on it."
- `apps/desktop/src-tauri/src/kind.rs:29,43-48` — for `TaskKind::Research`, `verify_after=false` (research carries no orchestration / no reviewer).
- `apps/desktop/src-tauri/src/sidecar.rs:287-302` (`handle_build_completed`) — when `!verify_after`, the task goes **straight to `TaskStatus::Done`** and `verified` is never touched (stays its run-start value of `false`, set at `sidecar.rs:869`). Only the verified-after PASS path (`sidecar.rs:372-373`) sets `task.verified = true`.

=> A research task is *supposed* to finish `status=done, verified=false`. The two fields are independent: `done` = terminal success; `verified` = a reviewer passed it. The UI calls the `done` column/badge "Verified", which is what makes them look contradictory.

**Conclusion:** (a) the UI is mislabeling — it conflates the terminal-success status with the reviewer-pass boolean. NOT (b) verified-never-set (it is correctly false because no reviewer ran) and NOT (c) done-treated-as-verified in the data model (the model keeps them separate; only the display label merges them).

### 2. branch=null — correct by design
- `apps/desktop/src-tauri/src/sidecar.rs:860-873` — at run start `is_worktree = runMode.is_worktree()`. For main mode `is_worktree=false` → `branch = None`, and `task.branch = branch.clone()` writes `None`, **intentionally clearing any stale prior branch** (comment at `:872`: "main mode clears any stale prior branch"). The `branch` field is the `nc/<taskId>` worktree branch, only ever set in worktree mode.
- `apps/web/src/components/board/TaskCard/TaskCard.tsx:79-90` — `showBranch = branch!==null && settled`; `showMainChip = mainMode && settled`. The **"main" chip is the runMode, not a git branch.**

=> The user's "branch was one value earlier, now null" is the documented main-mode clear. For `runMode="main"`, `branch=null` is required, not a lost value.

### 3. Other fields — all legitimate
- `committed=true`: `apps/desktop/src-tauri/src/merge.rs:52-74` — `commit_task` is a user-triggered command; main-mode path `worktree::commit_in` committed in the project root and set `committed=true, conflict=false`. Legit (user clicked Commit).
- `merged=false`, `conflict=false`: never merged; correct.
- `review=null`: no reviewer ran (research, `verify_after=false`); correct.
- `summary`: full final result text is present; not truncated.
- `updatedAt` (1782077077673) > `createdAt`: bumped on each persist; correct.
- `sessionId=1`, `sdkSessionId` present: run bookkeeping; correct.

**Location of the actual defect:** `apps/web/src/components/board/status.ts` (label tables + COLUMNS) and consumers (`TaskDetail.tsx:146-151`, `TaskDetail.hooks.ts:42`).
**Mechanism:** the display label for `status==='done'` is hardcoded to the word "Verified" (green success), independent of `task.verified`, so a legitimately-done-but-unverified research task reads as "VERIFIED".
**Introduced by:** the "Verified" column label — `git blame` on `status.ts:47-53` → commit `bb09e6b4` (Shirone, 2026-06-21). The status/verified split is the M4 design; the label collision is the UI choice.

## Evidence
- `kind.rs:43-48`: `Research => { verify_after: false }` proves no reviewer runs → `verified` stays false legitimately.
- `sidecar.rs:290-302`: `!verify_after` branch sets `status=Done` and does NOT set `verified` → confirms on/off: research/review/decompose finish done+unverified; only a build that PASSes review finishes done+verified=true.
- `status.ts:49` `title:'Verified'` + `STATUS_LABEL.done='Verified'` + `STATUS_TEXT.done='text-success'`: the green "VERIFIED" wording is status-keyed.
- `Board.hooks.ts:33-38` and `TaskDetail.hooks.ts:42`: column placement & `isVerifiedColumn` key on `status`, never `verified`.
- `sidecar.rs:872-873`: comment + assignment prove main mode deliberately nulls `branch`.
- Reverse-test (by code inspection): a `build` task that PASSes review takes `sidecar.rs:372-373` → `verified=true` with `status=done`; a `research` task takes `sidecar.rs:294` → `verified` untouched. The label "Verified" is identical for both — exactly the conflation. The on/off condition is fully predicted.

## Recommended Fix
**Approach:** Decouple the displayed label from the `done` status so the word "Verified" reflects `task.verified` (or kind), not merely `status==='done'`. Rename the terminal-success status's user-facing label to "Done"/"Complete", and reserve "Verified"/green-success for `verified===true`.

Two viable shapes (pick one with the user):
- **Minimal/label-only:** change `status.ts` `COLUMNS[done].title` and `STATUS_LABEL.done` from "Verified" to "Done"; add a per-card/per-header "VERIFIED" pill gated on `task.verified` (reuse `VERDICT_*` tokens). Lowest risk.
- **Semantic:** introduce a derived display state `verified ? 'Verified' : 'Done'` consumed by the column title, `STATUS_LABEL`, the detail badge, and `isVerifiedColumn` consumers.

**Files to change:**
- `apps/web/src/components/board/status.ts:49` — `COLUMNS` `done` `title:'Verified'` → `'Done'` (or derive).
- `apps/web/src/components/board/status.ts:70` — `STATUS_LABEL.done:'Verified'` → `'Done'`.
- `apps/web/src/components/board/TaskDetail/TaskDetail.tsx:146-151` — header badge: show green "VERIFIED" only when `task.verified`, else "DONE".
- (optional) `apps/web/src/components/board/TaskDetail/TaskDetail.hooks.ts:42` — rename `isVerifiedColumn` → `isDoneColumn`; ensure merge/gauntlet gating stays on `task.verified`/`canMerge`.
- `apps/web/src/components/board/TaskCard/TaskCard.tsx` — gate any "Verified" wording for `done` on `task.verified`.

Do NOT change the Rust data model — `status`/`verified` are correctly independent.

## Regression Test to Promote
- **Test file:** `apps/web/src/components/board/TaskDetail/TaskDetail.test.tsx`
- **Test body (adapt to chosen wording):**
```tsx
test('a done-but-unverified task is not labeled "Verified" (research kind)', () => {
  const task = makeTask({
    status: 'done', verified: false, kind: 'research',
    runMode: 'main', committed: true, costUsd: 1.63,
  });
  const screen = render(<TaskDetail task={task} /* ...required props... */ />);
  expect(screen.queryByText(/^verified$/i)).toBeNull();
  expect(screen.getByText(/done|complete/i)).toBeInTheDocument();
});

test('a done AND verified task shows the green Verified badge', () => {
  const task = makeTask({ status: 'done', verified: true, kind: 'build', runMode: 'worktree' });
  const screen = render(<TaskDetail task={task} /* ... */ />);
  expect(screen.getByText(/verified/i)).toBeInTheDocument();
});
```
Plus a `Board.test.tsx` test asserting a `done` task with `verified:false` still groups into the terminal column (placement correct; only the label changes).

## Instrumentation to Remove
None — diagnosed entirely from existing source + the persisted task JSON. No temporary instrumentation was added.

## Risks
- Renaming the `done` column/label touches existing tests/stories asserting "Verified" for done tasks (`TaskCard.stories.tsx`, `TaskDetail.stories.tsx`, `*.test.tsx`). Update in lockstep.
- `isVerifiedColumn` feeds the gauntlet/merge UI; if renamed, audit references so merge gating (correctly on `canMerge`/`task.verified`, `TaskDetail.hooks.ts:50-53`) is not weakened.
- A `build` task that PASSes review (`verified=true`) must still show green "Verified"; only the unverified-done case changes wording.
- Out of scope for the fix: the main-mode `branch` clear at `sidecar.rs:873` is by design; preserving a previously-set worktree branch across a main-mode re-run would be a behavior change — flag for product, do not silently alter the clear.

## How to Verify the Fix
1. Apply the label-decoupling fix in `status.ts` + `TaskDetail.tsx`.
2. (No instrumentation to remove.)
3. Run the new regression tests — must pass.
4. Re-load task `eb1307d6-...`: it stays in the terminal column, but the header no longer shows green "VERIFIED" — it shows "Done". `branch=null` + "main" chip + "Committed" remain (always correct).
5. Confirm a real verified build task (status=done, verified=true) still shows green "Verified".
