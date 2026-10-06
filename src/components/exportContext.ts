import { createSignal } from "solid-js";
import { appMode } from "../workspace";
import { bundle, centerView, setExportOpen } from "../state";
import { draft, exportPython, file } from "../designer/store";
import { activeMainResult } from "../designer/mainTabsState";
import { downloadMessage, saveDownload } from "../lib/download";
import { t } from "../i18n";
import { setRenderDialogOpen } from "../render/state";
export type ExportSurface = "viewport" | "drawing" | "design-result" | "examples-result";
export interface SurfaceExports { ready:()=>boolean; screenshot?:()=>Promise<void>|void; actions:()=>ContextAction[] }
export interface ContextAction { id:string; label:string; run:()=>Promise<void>|void; disabled?:boolean; reason?:string }
const [owners,setOwners]=createSignal<Partial<Record<ExportSurface,SurfaceExports>>>({});
/** A mounted view owns its real export handlers; stale/hidden views cannot be called by Header. */
export function registerSurfaceExports(surface:ExportSurface,owner:SurfaceExports):()=>void {
  setOwners(o=>({...o,[surface]:owner}));
  return ()=>setOwners(o=>{if(o[surface]!==owner)return o;const next={...o};delete next[surface];return next;});
}
export function exportNotice(text:string) { window.dispatchEvent(new CustomEvent("fairbeam:menu-notice",{detail:text})); }
export function activeExportSurface():ExportSurface|null {
  if(appMode()==="home")return null;
  if(appMode()==="design")return file() ? activeMainResult() ? "design-result" : "viewport" : null;
  return centerView()==="drawing" ? "drawing" : "viewport";
}
export function geometryAvailable():boolean {
  return appMode()==="design" ? !!file() && !!draft.parts?.some(p=>p.primitives.length) : !!bundle()?.parts.some(p=>p.primitives.length);
}
export function screenshotAvailable():boolean {
  const surface=activeExportSurface();
  return !!surface && !!owners()[surface]?.screenshot && !!owners()[surface]?.ready() && (surface!=="viewport"||geometryAvailable());
}
export const screenshotReason=()=>t(activeExportSurface()==="design-result" ? "contextExport.noChart" : "contextExport.noView");
export async function captureActiveSurface() {
  const surface=activeExportSurface();
  if(!surface || !screenshotAvailable()) { exportNotice(screenshotReason());return; }
  try { await owners()[surface]!.screenshot!(); } catch(error) { exportNotice(t("contextExport.failed",{error:String(error)})); }
}
export function contextualExportActions():ContextAction[] {
  const surface=activeExportSurface();if(!surface)return [];
  const owner=owners()[surface];
  const actions:ContextAction[] = surface === "viewport" ? [{id:"geometry",label:t("contextExport.geometry"),disabled:!geometryAvailable(),reason:t("contextExport.noGeometry"),run:()=>{if(geometryAvailable())setExportOpen(true);else exportNotice(t("contextExport.noGeometry"));}},
    {id:"render-image",label:t("render.menu.label"),disabled:!geometryAvailable(),reason:t("contextExport.noGeometry"),run:()=>{if(geometryAvailable())setRenderDialogOpen(true);else exportNotice(t("contextExport.noGeometry"));}}] : [];
  if(owner)actions.push(...owner.actions());
  if(appMode()==="results" && surface==="viewport")actions.push(...(owners()["examples-result"]?.actions()??[]));
  if(appMode()==="design" && surface==="viewport" && file()) {
    actions.push({id:"design-json",label:t("contextExport.designJson"),run:async()=>{
      const snapshot=JSON.stringify(draft,null,2),name=`${draft.model.id}.design.json`;
      exportNotice(downloadMessage(await saveDownload(name,snapshot,"application/json")));
    }},{id:"design-python",label:t("contextExport.designPython"),run:async()=>{
      const name=`${draft.model.id}.py`,text=await exportPython();if(text)exportNotice(downloadMessage(await saveDownload(name,text,"text/x-python")));
      else exportNotice(t("contextExport.pythonFailed"));
    }});
  }
  return actions;
}
