import { lazy, type Component } from "solid-js";

/** Keep lazy resource ownership local to each mount. A shared Solid lazy wrapper
 * can reuse an unresolved resource owned by a departing workspace; disposing that
 * owner then strands the arriving workspace. Dynamic import still caches the
 * module, but each mount must own its own reactive loading state. */
export function instanceLazy<P extends object>(load: () => Promise<{ default: Component<P> }>): Component<P> {
  return props => lazy(load)(props);
}
