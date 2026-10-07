/**
 * Whether a viewport change should close a floating menu that is positioned in page coordinates.
 * A window resize always does: its target is the window, which is not a node and never inside the
 * menu. A scroll does unless it happened inside the menu itself (a long list in the menu scrolling).
 * Scroll events can target the document or the window, so the target is checked to be a Node before
 * asking the menu whether it contains it.
 */
export function viewportChangeCloses(menu: Node, event: Pick<Event, "type" | "target">): boolean {
  if (event.type !== "scroll") return true;
  const target = event.target;
  return !(typeof Node !== "undefined" && target instanceof Node && menu.contains(target));
}
