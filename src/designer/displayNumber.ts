// A number from the expression evaluator, as the interface shows it: the decimal separator of the
// language ("Follow the language": a comma in Turkish) and the typographic minus (U+2212). Display only:
// fields and files keep the decimal point and the ASCII "-" (expr.ts `fmt` is the machine form).
import { fmt as plain } from "./expr.ts";
import { decimalComma } from "../i18n/index.ts";

export function shown(v: number): string {
  const s = plain(v);
  return (decimalComma() ? s.replace(".", ",") : s).replace(/^-/, "−");
}
