/** Editing session of one table row whose cells apply every keystroke to the draft at once
 * (Parameters dock). `saved` is the last committed state of the row: what Escape returns to.
 *  - focusing a cell starts a session from the row as it is now (moving between cells, or leaving
 *    and coming back, commits what was typed before);
 *  - Enter commits (the typing so far becomes the state Escape returns to);
 *  - Escape hands back the state to restore, or null when nothing is uncommitted. */
export function createRowEdit<T>() {
  let saved: T | null = null;
  let dirty = false;
  return {
    /** A cell got focus: the row as it is now is committed. */
    begin(row: T) { saved = row; dirty = false; },
    /** Typing changed the row since the last commit. */
    typed() { dirty = true; },
    /** Enter: the row as it is now is committed. */
    commit(row: T) { saved = row; dirty = false; },
    /** Escape: the state to restore, or null when there is no uncommitted typing. Ends the session. */
    cancel(): T | null { const back = dirty ? saved : null; saved = null; dirty = false; return back; },
    /** Focus left the row. */
    end() { saved = null; dirty = false; },
  };
}
