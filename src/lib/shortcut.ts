/** True on macOS (and iOS): ⌘ is the command modifier there, Ctrl everywhere else. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /Mac|iPhone|iPad/i.test(platform);
}

/** The platform command modifier is held (⌘ alone on macOS, Ctrl alone elsewhere). */
export const commandModifier = (e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, mac = isMacPlatform()) =>
  mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

/** Platform modifier used in shortcut labels. */
export const modifierShortcut = (key: string, mac = isMacPlatform()) => mac ? `⌘${key}` : `Ctrl+${key}`;
