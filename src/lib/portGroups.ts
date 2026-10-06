// Additional physical feeds of one logical discrete port (design and numeric bundle alike).
type Feed = { start: unknown; stop: unknown; direction: string; polarity?: number };
type GroupedFeed = Feed & { group?: { members: Feed[] } };

export function portFeedEntries<T extends GroupedFeed>(port: T, path: string): [string, T][] {
  const members = port.group?.members ?? [];
  return [[path, port], ...members.map((m, j) =>
    [`${path}.group.members[${j}]`, { ...port, ...m }] as [string, T])];
}

/** Same structural errors as design.check_port_group; coordinates may be expressions here. */
export function portGroupProblem(port: { type?: unknown; group?: unknown }, path: string): { path: string; message: string } | null {
  if (!("group" in port)) return null;
  const group = port.group as Record<string, unknown> | null;
  const w = `${path}.group`;
  const bad = (path: string, message: string) => ({ path, message });
  if ((port.type === undefined ? "lumped" : port.type) !== "lumped" || !group || typeof group !== "object" || Array.isArray(group))
    return bad(w, "group is an object on a lumped port");
  if (!["parallel", "series"].includes(group.connection as string)) return bad(`${w}.connection`, "connection must be parallel or series");
  if (!Array.isArray(group.members) || group.members.length < 1 || group.members.length > 15)
    return bad(`${w}.members`, "group needs 1 to 15 additional feeds");
  if ("priority" in group && !(typeof group.priority === "number" && Number.isInteger(group.priority) && group.priority >= 0))
    return bad(`${w}.priority`, "priority must be a nonnegative integer");
  if (Object.keys(group).some((key) => !["connection", "members", "priority"].includes(key)))
    return bad(w, "group contains connection, members and priority only");
  for (let j = 0; j < group.members.length; j++) {
    const member = group.members[j], wm = `${w}.members[${j}]`;
    if (!member || typeof member !== "object" || Array.isArray(member)) return bad(wm, "member must be an object");
    for (const key of ["start", "stop"]) if (!Array.isArray(member[key]) || member[key].length !== 3) return bad(`${wm}.${key}`, "expected three coordinates");
    if (!["x", "y", "z"].includes(member.direction)) return bad(`${wm}.direction`, "direction must be x, y or z");
    if (![1, -1].includes("polarity" in member ? member.polarity : 1)) return bad(`${wm}.polarity`, "polarity must be +1 or -1");
    if (Object.keys(member).some((key) => !["start", "stop", "direction", "polarity"].includes(key)))
      return bad(wm, "members contain coordinates, direction and polarity only");
  }
  return null;
}
