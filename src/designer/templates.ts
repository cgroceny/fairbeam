// The Start screen's starting points for a new design, grouped as the Start list shows them. The
// designs themselves are built by the run server: python/fairbeam/design.py TEMPLATES (the empty
// project and the patch) and python/fairbeam/starters.py (the others) use the same keys.
// The texts here are i18n keys (src/i18n/en.json), translated where they are shown; the designs the
// server writes (part and material names) stay in English.
import { t } from "../i18n";

export type TemplateKey = "empty" | "dipole" | "monopole" | "open-waveguide" | "patch" | "sleeve-dipole" | "microstrip";

export interface DesignTemplate {
  key: TemplateKey;
  /** i18n key of the name */
  name: string;
  /** i18n key of the one line under the name */
  sub: string;
  /** the note shown once the design is created and open (in the language of that moment) */
  created: (file: string) => string;
}

export interface TemplateGroup {
  /** i18n key of the heading over the group; the first group (the empty project) has none ("") */
  label: string;
  templates: DesignTemplate[];
}

export const TEMPLATE_GROUPS: TemplateGroup[] = [
  {
    label: "",
    templates: [
      { key: "empty", name: "templates.empty.name", sub: "templates.empty.sub",
        created: (file) => t("templates.empty.created", { file }) },
    ],
  },
  {
    label: "templates.group.basic",
    templates: [
      { key: "dipole", name: "templates.dipole.name", sub: "templates.dipole.sub",
        created: (file) => t("templates.dipole.created", { file }) },
      { key: "monopole", name: "templates.monopole.name", sub: "templates.monopole.sub",
        created: (file) => t("templates.monopole.created", { file }) },
      { key: "open-waveguide", name: "templates.openWaveguide.name", sub: "templates.openWaveguide.sub",
        created: (file) => t("templates.openWaveguide.created", { file }) },
    ],
  },
  {
    label: "templates.group.printed",
    templates: [
      { key: "patch", name: "templates.patch.name", sub: "templates.patch.sub",
        created: (file) => t("templates.patch.created", { file }) },
      { key: "sleeve-dipole", name: "templates.sleeveDipole.name", sub: "templates.sleeveDipole.sub",
        created: (file) => t("templates.sleeveDipole.created", { file }) },
    ],
  },
  {
    label: "templates.group.circuits",
    templates: [
      { key: "microstrip", name: "templates.microstrip.name", sub: "templates.microstrip.sub",
        created: (file) => t("templates.microstrip.created", { file }) },
    ],
  },
];

export const TEMPLATES: DesignTemplate[] = TEMPLATE_GROUPS.flatMap((g) => g.templates);

/** The note after creating `file` from `key`. */
export function createdNote(key: TemplateKey, file: string): string {
  return (TEMPLATES.find((tpl) => tpl.key === key) ?? TEMPLATES[0]).created(file);
}
