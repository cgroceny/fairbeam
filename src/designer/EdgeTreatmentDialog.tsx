import { createMemo, createSignal, Show } from "solid-js";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { draft, edit, names } from "./store";
import { ExprField, SelectField } from "./DesignPane";
import { tryEvaluate } from "./expr";
import { treatedBox } from "./edgeTreatment";
import type { Axis, Expr } from "./types";
import { t } from "../i18n";
export function EdgeTreatmentDialog(props: {i:number;j:number;close:()=>void}) {
  let box!: HTMLDivElement;
  useModal(()=>box,props.close);
  const p=draft.parts[props.i].primitives[props.j];
  const flat=p.kind === "box" ? "xyz"[[0,1,2].find(k=>tryEvaluate(p.start[k],names().names).value===tryEvaluate(p.stop[k],names().names).value) ?? 2] : "z";
  const [axis,setAxis]=createSignal<Axis>(flat as Axis);
  const [mode,setMode]=createSignal<"fillet"|"chamfer">("fillet");
  const [size,setSize]=createSignal<Expr>(1);
  const result=createMemo(()=>{try{return {primitive:treatedBox(draft.parts[props.i],props.j,axis(),mode(),tryEvaluate(size(),names().names).value ?? NaN,names().names),error:""};}catch(error){return {primitive:null,error:(error as Error).message};}});
  return <div class="scrim"><div class="dialog dialog-sm" role="dialog" aria-modal="true" aria-labelledby="edge-title" ref={box} tabindex={-1}>
    <div class="dialog-head"><div><h2 id="edge-title">{t("edgeTreatment.title")}</h2><p class="muted">{t("edgeTreatment.scope")}</p></div><button class="icon-btn" aria-label={t("common.close")} onClick={props.close}><X/></button></div>
    <div class="sd-body"><SelectField label={t("edgeTreatment.operation")} value={mode()} options={[{value:"fillet",label:t("edgeTreatment.fillet")},{value:"chamfer",label:t("edgeTreatment.chamfer")}]} onChange={v=>setMode(v as "fillet"|"chamfer")}/>
    <SelectField label={t("edgeTreatment.axis")} value={axis()} options={["x","y","z"] as Axis[]} onChange={setAxis}/>
    <ExprField label={t(mode()==="fillet"?"edgeTreatment.radius":"edgeTreatment.distance")} unit="mm" value={size()} path="__edge.size" offerParams={false} onChange={setSize}/>
    <p class="note">{t("edgeTreatment.nativeNote")}</p><Show when={result().error}><p class="note dz-bad" role="alert">{t(result().error)}</p></Show></div>
    <div class="dialog-foot"><div class="dialog-actions"><button class="btn btn-ghost" onClick={props.close}>{t("common.cancel")}</button><button class="btn btn-primary" disabled={!result().primitive} onClick={()=>{const primitive=result().primitive;if(!primitive)return;edit(d=>{d.parts[props.i].primitives[props.j]=primitive;},"",t("edgeTreatment.title"));props.close();}}>{t("common.apply")}</button></div></div>
  </div></div>;
}
