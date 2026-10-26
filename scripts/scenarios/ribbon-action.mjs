// Follow the visible responsive ribbon, including a folded command group.
export async function clickRibbonAction(s, groupKey, actionSelector) {
  const group = `.rb:not([hidden]) .rb-group[aria-label=${JSON.stringify(await s.T(groupKey))}]`;
  const visible = await s.find(actionSelector, undefined, { within: group });
  if (visible) await visible.dispose();
  else await s.click(groupKey, { sel: '.rb-group-toggle', within: group, exact: true });
  await s.clickSel(actionSelector, { within: group });
}
