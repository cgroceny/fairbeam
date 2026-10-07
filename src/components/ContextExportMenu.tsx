import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Download } from "lucide-solid";
import { appMode } from "../workspace";
import { activeExportSurface, contextualExportActions, exportNotice } from "../components/exportContext";
import { t } from "../i18n";
export default function ContextExportMenu() {
  let trigger!:HTMLButtonElement,menu!:HTMLDivElement;
  const [open,setOpen]=createSignal(false),[pos,setPos]=createSignal({left:0,top:0});
  const actions=contextualExportActions;
  const close=(focus=true)=>{setOpen(false);if(focus)trigger.focus();};
  createEffect(on(()=>`${appMode()}:${activeExportSurface()}`,()=>close(false),{defer:true}));
  const toggle=()=>{if(open()){close(false);return;}const r=trigger.getBoundingClientRect();setPos({left:Math.max(8,r.right-280),top:r.bottom+4});setOpen(true);queueMicrotask(()=>{const r=menu.getBoundingClientRect();setPos({left:Math.max(8,Math.min(r.left,window.innerWidth-r.width-8)),top:Math.max(8,Math.min(r.top,window.innerHeight-r.height-8))});menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();});};
  onMount(()=>{const away=(e:PointerEvent)=>{if(open()&&!menu.contains(e.target as Node)&&!trigger.contains(e.target as Node))close(false);};const viewport=(event:Event)=>{if(event.type==="scroll"&&event.target!==document&&event.target!==window&&event.target!==document.documentElement&&event.target!==document.body)return;close(false);};document.addEventListener('pointerdown',away);window.addEventListener('resize',viewport);window.addEventListener('scroll',viewport,true);onCleanup(()=>{document.removeEventListener('pointerdown',away);window.removeEventListener('resize',viewport);window.removeEventListener('scroll',viewport,true);});});
  return <><button ref={trigger} class="btn header-cst" classList={{"btn-primary":appMode()!=="design","btn-ghost":appMode()==="design"}} hidden={appMode()==="home"} disabled={!actions().some(a=>!a.disabled)} aria-haspopup="menu" aria-expanded={open()} aria-label={t("contextExport.label")} title={actions().some(a=>!a.disabled)?t("contextExport.title"):(actions().find(a=>a.reason)?.reason??t("contextExport.noData"))} onClick={toggle} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();if(!open())toggle();}}}><Download size={14}/><span class="header-cst-label">{t("contextExport.label")}</span></button>
  <Show when={open()}><Portal><div ref={menu} class="menu context-export-menu" role="menu" aria-label={t("contextExport.label")} style={{left:`${pos().left}px`,top:`${pos().top}px`}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close();}else if(e.key==='Tab')close(false);else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const items=[...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],i=items.indexOf(document.activeElement as HTMLButtonElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}}}>
  {/* Action objects are fresh on every availability update; IDs preserve the focused DOM node. */}
  <For each={actions().map(a=>a.id)}>{id=>{
    const action=()=>actions().find(a=>a.id===id);
    return <button class="menu-item" role="menuitem" data-export-action={id} data-action={id==="geometry"?"export-geometry":undefined} disabled={action()?.disabled} title={action()?.disabled?action()?.reason:action()?.label} onClick={()=>{const a=action();close();if(a)void Promise.resolve(a.run()).catch(error=>exportNotice(t("contextExport.failed",{error:String(error)}),{tone:"error"}));}}>{action()?.label}</button>;
  }}</For></div></Portal></Show></>;
}
