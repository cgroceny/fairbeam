import regularUrl from "../assets/fonts/IBMPlexSans-Regular.woff?url";
import semiboldUrl from "../assets/fonts/IBMPlexSans-SemiBold.woff?url";
import { toBase64 } from "../drawing/font";
import { saveDownload, downloadMessage } from "../lib/download";
import { exportNotice } from "./exportContext";
import { titledSvg } from "./figureTitle";
import { t } from "../i18n";
export function visibleFigureSvgs(root:HTMLElement|null):SVGSVGElement[] {
  return root ? [...root.querySelectorAll<SVGSVGElement>(".chart svg")].filter(svg=>svg.getBoundingClientRect().width>0 && svg.getBoundingClientRect().height>0 && !svg.closest("[hidden],[inert]")) : [];
}
/** The styles a copy keeps: the colours, strokes and text of the plotted SVGs. */
const KEPT = ["fill","fill-opacity","stroke","stroke-width","stroke-opacity","stroke-dasharray","font-family","font-size","font-weight","text-anchor","dominant-baseline","opacity","paint-order"];

/** Read computed styles as the light theme draws them, whatever the screen's theme: a figure for a
 * paper or a slide is dark on white, not a capture of a dark screen. The theme attribute is switched and
 * restored within this call, so nothing is painted in between. */
function inLightTheme<T>(read:()=>T):T {
  const html=document.documentElement, before=html.getAttribute("data-theme");
  if(before==="light") return read();
  html.setAttribute("data-theme","light");
  try { return read(); } finally { if(before===null) html.removeAttribute("data-theme"); else html.setAttribute("data-theme",before); }
}

/** Snapshot the actual plotted SVGs, including comparison traces and current quantity choices, in the
 * light publication style (white paper, the light theme's colours). CSS roles resolve to computed
 * styles so the standalone file matches the chart. */
export function visibleFigureSvg(root:HTMLElement):string|null {
  const charts=visibleFigureSvgs(root);if(!charts.length)return null;
  const rect=root.getBoundingClientRect();
  const width=Math.max(...charts.map(s=>s.getBoundingClientRect().right-rect.left));
  const height=Math.max(...charts.map(s=>s.getBoundingClientRect().bottom-rect.top));
  const out=document.createElementNS("http://www.w3.org/2000/svg","svg");
  out.setAttribute("xmlns","http://www.w3.org/2000/svg");out.setAttribute("viewBox",`0 0 ${width} ${height}`);
  out.setAttribute("width",`${width/96*25.4}mm`);out.setAttribute("height",`${height/96*25.4}mm`);
  const paper=document.createElementNS("http://www.w3.org/2000/svg","rect");paper.setAttribute("width",String(width));paper.setAttribute("height",String(height));paper.setAttribute("fill","#fff");out.append(paper);
  inLightTheme(()=>{
    for(const svg of charts) {
      const clone=svg.cloneNode(true) as SVGSVGElement;
      const original=[svg,...svg.querySelectorAll<SVGElement>("*")],copies=[clone,...clone.querySelectorAll<SVGElement>("*")];
      original.forEach((node,k)=>{const style=getComputedStyle(node);for(const key of KEPT)copies[k].style.setProperty(key,style.getPropertyValue(key));});
      const box=svg.getBoundingClientRect();clone.setAttribute("x",String(box.left-rect.left));clone.setAttribute("y",String(box.top-rect.top));clone.setAttribute("width",String(box.width));clone.setAttribute("height",String(box.height));out.append(clone);
    }
  });
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
/** Save the visible chart as SVG or as a 300 dpi PNG, light publication style; a PNG carries `title`
 * (the run and the view) above the chart. */
export async function saveVisibleFigure(root:HTMLElement|null,base:string,format:"svg"|"png",title?:string) {
  let svg=root && visibleFigureSvg(root);if(!svg){exportNotice(t("contextExport.noChart"));return;}
  const name=`${base.replace(/[^a-z0-9._-]+/gi,"_")}.${format}`;
  let data:string|Blob;
  if(format==="svg") data=svg.replace(/(<svg[^>]*>)/,`$1<style>${await embeddedFontFaces()}</style>`);
  else data=await (await import("../drawing/render")).svgToPng(title ? titledSvg(svg,title) : svg,300);
  exportNotice(downloadMessage(await saveDownload(name,data,format==="svg"?"image/svg+xml":"image/png")));
}
