import { FlipHorizontal2, Maximize2, Move, Repeat2, RotateCw } from "lucide-solid";
import { selection } from "./store";
import { openTransform } from "./transforms";
import type { DesignTransform } from "./types";

// Render inside any ribbon group; label and title are i18n keys (t() at render). Evaluate disabled() in JSX so selection stays reactive.
// The shared TransformDialogHost stays mounted once outside the ribbon's tab panels.
const noTarget = () => { const target = selection(); return target.type !== "part" && target.type !== "primitive"; };
const opItem = (type: DesignTransform["type"], icon: typeof Move, name: string) => ({
  icon, label: `ribbon.transform.${name}`, title: `ribbon.transform.${name}Title`, disabled: noTarget,
  onClick: () => { const target = selection(); if (target.type === "part" || target.type === "primitive") openTransform(type, target); },
});
export const TRANSFORM_RIBBON_ITEMS = [{
  icon: Move,
  label: "ribbon.transform.transform",
  title: "ribbon.transform.transformTitle",
  disabled: () => { const target = selection(); return target.type !== "part" && target.type !== "primitive"; },
  onClick: () => {
    const target = selection();
    if (target.type === "part" || target.type === "primitive") openTransform("move", target);
  },
},
opItem("rotate", RotateCw, "rotate"),
opItem("scale", Maximize2, "scale"),
opItem("mirror", FlipHorizontal2, "mirror"),
opItem("translate", Repeat2, "array"),
];
