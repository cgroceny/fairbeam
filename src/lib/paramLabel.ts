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
