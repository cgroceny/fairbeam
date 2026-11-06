/** Settings files are data only; bound parsing before inspecting their schema. */
export const SETTINGS_FILE_LIMIT = 256 * 1024;
export function settingsData(text: string): Record<string, unknown> {
  if (text.length > SETTINGS_FILE_LIMIT) throw new Error('settingsFile.invalid');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('settingsFile.invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settingsFile.invalid');
  return value as Record<string, unknown>;
}
export function settingsObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw new Error('settingsFile.invalid');
}
