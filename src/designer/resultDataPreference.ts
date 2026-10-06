import { createSignal } from "solid-js";

/** "plot": copy and CSV follow the plot (dB, or phase on a phase plot); the others are fixed formats. */
export const RESULT_DATA_FORMATS = ["plot", "db", "db_phase", "re_im", "mag_phase", "all"] as const;
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
