# Multiple project sessions: implementation plan

The current editor owns one active draft. Cross-project comparison overlays do not create
independent editable sessions. The isolated designer and result-state factories below are
implemented and tested; project switching and additional native windows remain future work.

## Implemented foundation

`createDesignerSession` owns draft/file state, selection, history and coalescing, observed edits,
metadata revisions, status, save-note timers and async ownership. The existing default editor
uses this factory. Its storage, runner, preview and global UI adapters still serve only that
default editor. Constructing another core does not attach them or open another project.

`createResultFocusState` and `createMainTabsState` own result focus and tab state. Existing UI
wrappers use these factories; result loading and rendering are not yet separate project sessions.
Actual-source regressions exercise two cores with the same file ID, independent Undo/Redo,
owned history marks, delayed callbacks, disposal and independent reactive result observers.

Before exposing project tabs, bind network/preview adapters to their owner, scope backups to
the workspace and file identity captured at load, and retain camera/workplane state. The current
per-design backup key is insufficient for duplicate editors or different workspaces. Aggregate
close/recovery behavior must also cover inactive dirty drafts before shipping a switcher.

## Recommended sequence

1. Complete per-project adapters around the implemented factories without changing the interface.
   `designer/store.ts` must move file, draft, history, selection, conflict and save state together.
   Preserve history coalescing, saved metadata revisions and observed edits. Each context needs
   its own `DesignerAsyncState` plus a stable session identity and disposal guard.
2. Add an outer project tab strip. Existing 3D/result tabs remain inside each project. Opening
   an already open canonical file activates its session. Switching A/B retains independent
   drafts and Undo/Redo without a discard prompt; closing a dirty session still asks what to save.
3. Move result focus, result tabs and viewer state into those contexts. Dispose per-session
   effects from `runResults.ts`; capture camera, workplane and Drawing state before unmounting.
   Initially keep one active renderer, stop inactive animations and bound shared bundle caches.
4. Handle close, quit and recovery across all dirty sessions. Backups need workspace/file/session
   ownership; the current per-design key cannot coordinate duplicate editors. Reject stale
   hashes and late callbacks after disposal. A failed save or Cancel must keep its session open.
5. Add split panes or detached windows for genuinely simultaneous viewing. Native commands,
   close prompts, menu state and downloads must target their window; keep the shared server
   alive until the final window closes. Validate focus, Quit and file dialogs on each platform.

## Foundations and remaining risks

The [server ownership guard](SERVER-OWNERSHIP.md) protects the same jobs directory from
another updated CLI server. It is not duplicate-editor protection. Additional native windows
should share the existing server and serial solver queue, rather than start another server.

New HTTP declarative jobs now [capture their admitted input](QUEUED-DESIGN-INPUTS.md),
including run, sweep, optimization and convergence requests. Captured defaults, validation and
execution use that input, with hash verification before launch. Python and legacy/direct jobs
without a snapshot retain mutable paths. A copied Python entry file alone is not a complete
snapshot: relative imports, external data and `__file__` need a separate dependency contract.
For a single HTTP declarative run, admission builds the captured input with its validated
overrides once and uses that mesh count for memory preflight and Auto threads. Batch/Python
admission retains advisory estimates; every actual solve checks its built mesh against current
free memory immediately before entering the solver.

## Next adapter boundaries

- Extract owned load/save/close transport from `designer/store.ts`, keeping default wrappers.
  Capture the session and workspace/API identity before every await. Recheck `createDesign`
  ownership after its optional save before publishing checks or messages.
- Give preview debounce, animation frame, abort controller, checks and latest bundle an owner.
  `runner/store.ts` currently shares preview cancellation and visible-bundle restoration;
  only an active-session presenter may update `state.ts`. Keep one application-level unsaved
  query over the session registry rather than overwriting its singleton callback per project.
- Add a server-issued versioned scope based on the canonical models directory to the same
  GET/create response as the design. Capture it in the file and timer closures. Health alone
  cannot establish the owner of a concurrent load. Scope backups and last-opened state; retain
  unscoped legacy backups untouched because even matching content hashes cannot establish
  their workspace. Any migration requires explicit recovery rather than silent reassignment.
  Backup namespacing alone does not prevent a save reaching a changed backend workspace;
  that also needs a request-scope precondition.
- Capture the target of close/quit prompts. Closing an inactive session must not call the
  default close path's global Home/model transition. Boolean observers and renderer lifecycle
  also need explicit ownership before project switching.

## Acceptance checks

- Edit A and B, switch repeatedly, and verify each Undo/Redo, selection, camera and result focus.
- Hold A's load/save/preview response while activating B; release it without changing B.
- Exercise individual close and app Quit with dirty inactive projects, conflicts and offline saves.
- Verify crash recovery, canonical path aliases and attempts to open the same file twice.
- Export A's pattern and B's S-parameters; names, values and screenshots must match their owner.
- Close a project with pending loads; callbacks, keyboard handlers and render resources disappear.
- Measure memory after repeated open/close cycles and large field results; do not infer savings
  from a single renderer alone.

Keep existing EN/TR lifecycle, rename, export and result tests passing at every phase. Native window
and ownership-lock checks on macOS and Linux have not been run yet; the Windows results do not
cover them.
