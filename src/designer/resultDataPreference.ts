import { createSignal } from "solid-js";

/** "plot": copy and CSV follow the plot (dB, or phase on a phase plot); the others are fixed formats. */
export const RESULT_DATA_FORMATS = ["plot", "db", "db_phase", "re_im", "mag_phase", "all", "gd", "phase_unwrapped"] as const;
export type ResultDataFormat = typeof RESULT_DATA_FORMATS[number];
export const RESULT_DATA_FORMAT_KEY = "fairbeam:result-data-format";

const [sharedFormat, setSharedFormat] = createSignal<ResultDataFormat>(readResultDataFormat());
export const resultDataFormat = sharedFormat;

export function readResultDataFormat(): ResultDataFormat {
  try {
    const value = localStorage.getItem(RESULT_DATA_FORMAT_KEY);
    if (RESULT_DATA_FORMATS.includes(value as ResultDataFormat)) return value as ResultDataFormat;
  } catch { /* Use the default when storage is unavailable. */ }
  return "plot";
}

export function writeResultDataFormat(value: ResultDataFormat): void {
  if (!RESULT_DATA_FORMATS.includes(value)) return;
  setSharedFormat(value);
  try { localStorage.setItem(RESULT_DATA_FORMAT_KEY, value); } catch { /* Preference remains usable for this session. */ }
}

/** The format for resultDataTable: undefined follows the plot. */
export const tableFormat = (value: ResultDataFormat) => (value === "plot" ? undefined : value);

/** The derived phase formats apply only to S-parameters; other views keep their normal data. */
export const formatForView = (value: ResultDataFormat, sparams: boolean): ResultDataFormat =>
  !sparams && (value === "gd" || value === "phase_unwrapped") ? "plot" : value;

export const GROUP_DELAY_APERTURES = [3, 5, 11, 21] as const;
export const GROUP_DELAY_APERTURE_KEY = "fairbeam:group-delay-aperture";
export function readGroupDelayAperture(): number {
  try {
    const value = Number(localStorage.getItem(GROUP_DELAY_APERTURE_KEY));
    if (GROUP_DELAY_APERTURES.some(n => n === value)) return value;
  } catch { /* Session default when storage is unavailable. */ }
  return 3;
}
const [aperture, setAperture] = createSignal(readGroupDelayAperture());
export const groupDelayAperture = aperture;
export function writeGroupDelayAperture(value: number): void {
  if (!GROUP_DELAY_APERTURES.some(n => n === value)) return;
  setAperture(value);
  try { localStorage.setItem(GROUP_DELAY_APERTURE_KEY, String(value)); } catch { /* Session preference remains usable. */ }
}
