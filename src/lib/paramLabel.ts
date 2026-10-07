// The labels the app itself gives parameters (the design templates, python/fairbeam/design.py and
// starters.py, write "Design frequency" into the file in English), shown in the UI language. A label
// the user typed is shown as it is. The file keeps the English text.
import { t } from "../i18n/index.ts";

const DEFAULT_LABELS: Readonly<Record<string, string>> = {
  "Design frequency": "params.defaultLabel.designFrequency",
  "New parameter": "params.defaultLabel.newParameter",
};

export function paramLabelText<T extends string | undefined>(label: T): T | string {
  const key = label === undefined ? undefined : DEFAULT_LABELS[label];
  return key ? t(key) : label;
}

/** A parameter's tooltip: its description, else its (translated) label, and only without either its
 * key. A tooltip that repeats the raw key ("sub_h") tells a newcomer nothing the row does not. */
export function paramTooltip(p: { key: string; label?: string; description?: string }): string {
  return p.description?.trim() || paramLabelText(p.label)?.trim() || p.key;
}
