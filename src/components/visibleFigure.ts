import regularUrl from "../assets/fonts/IBMPlexSans-Regular.woff?url";
import semiboldUrl from "../assets/fonts/IBMPlexSans-SemiBold.woff?url";
import { toBase64 } from "../drawing/font";
import { saveDownload, downloadMessage } from "../lib/download";
import { exportNotice } from "./exportContext";
import { cssVar } from "../lib/cssvar";
import { t } from "../i18n";
export function visibleFigureSvgs(root:HTMLElement|null):SVGSVGElement[] {
  return root ? [...root.querySelectorAll<SVGSVGElement>(".chart svg")].filter(svg=>svg.getBoundingClientRect().width>0 && svg.getBoundingClientRect().height>0 && !svg.closest("[hidden],[inert]")) : [];
}
/** Snapshot the actual plotted SVGs, including comparison traces and current quantity choices.
 * Resolve CSS roles to computed styles so the standalone file matches the visible chart. */
export function visibleFigureSvg(root:HTMLElement):string|null {
  const charts=visibleFigureSvgs(root);if(!charts.length)return null;
  const rect=root.getBoundingClientRect();
  const width=Math.max(...charts.map(s=>s.getBoundingClientRect().right-rect.left));
  const height=Math.max(...charts.map(s=>s.getBoundingClientRect().bottom-rect.top));
  const out=document.createElementNS("http://www.w3.org/2000/svg","svg");
  out.setAttribute("xmlns","http://www.w3.org/2000/svg");out.setAttribute("viewBox",`0 0 ${width} ${height}`);
  out.setAttribute("width",`${width/96*25.4}mm`);out.setAttribute("height",`${height/96*25.4}mm`);
  let parent:HTMLElement|null=root,background="";
  while(parent) {background=getComputedStyle(parent).backgroundColor;if(background && background!=="rgba(0, 0, 0, 0)" && background!=="transparent")break;parent=parent.parentElement;}
  const paper=document.createElementNS("http://www.w3.org/2000/svg","rect");paper.setAttribute("width",String(width));paper.setAttribute("height",String(height));paper.setAttribute("fill",background||cssVar("--al-surface"));out.append(paper);
  for(const svg of charts) {
    const clone=svg.cloneNode(true) as SVGSVGElement;
    const original=[svg,...svg.querySelectorAll<SVGElement>("*")],copies=[clone,...clone.querySelectorAll<SVGElement>("*")];
    original.forEach((node,k)=>{const style=getComputedStyle(node);for(const key of ["fill","fill-opacity","stroke","stroke-width","stroke-opacity","stroke-dasharray","font-family","font-size","font-weight","text-anchor","dominant-baseline","opacity","paint-order"])copies[k].style.setProperty(key,style.getPropertyValue(key));});
    const box=svg.getBoundingClientRect();clone.setAttribute("x",String(box.left-rect.left));clone.setAttribute("y",String(box.top-rect.top));clone.setAttribute("width",String(box.width));clone.setAttribute("height",String(box.height));out.append(clone);
  }
  return new XMLSerializer().serializeToString(out);
}
let fontFaces:Promise<string>|undefined;
function embeddedFontFaces():Promise<string> {
  return fontFaces ??= Promise.all([regularUrl,semiboldUrl].map(async(url,k)=>{
    const response=await fetch(url);if(!response.ok)throw new Error(`Font loading failed (${response.status})`);
    const bytes=new Uint8Array(await response.arrayBuffer());
    return `@font-face{font-family:'IBM Plex Sans';font-weight:${k===0?400:600};src:url(data:font/woff;base64,${toBase64(bytes)}) format('woff')}`;
  })).then(faces=>faces.join(""));
}
export async function saveVisibleFigure(root:HTMLElement|null,base:string,format:"svg"|"png") {
  let svg=root && visibleFigureSvg(root);if(!svg){exportNotice(t("contextExport.noChart"));return;}
  svg=svg.replace(/(<svg[^>]*>)/,`$1<style>${await embeddedFontFaces()}</style>`);
  const name=`${base.replace(/[^a-z0-9._-]+/gi,"_")}.${format}`;
  const data=format==="svg" ? svg : await (await import("../drawing/render")).svgToPng(svg,96);
  exportNotice(downloadMessage(await saveDownload(name,data,format==="svg"?"image/svg+xml":"image/png")));
}
