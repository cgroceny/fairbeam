import regularUrl from "../assets/fonts/IBMPlexSans-Regular.woff?url";
import semiboldUrl from "../assets/fonts/IBMPlexSans-SemiBold.woff?url";
import { toBase64 } from "../drawing/font";
import { saveDownload } from "../lib/download";
import { downloadToast } from "../lib/toast";
import { exportNotice } from "./exportContext";
import { titledSvg } from "./figureTitle";
import { t } from "../i18n";
export function visibleFigureSvgs(root:HTMLElement|null):SVGSVGElement[] {
  return root ? [...root.querySelectorAll<SVGSVGElement>(".chart svg")].filter(svg=>svg.getBoundingClientRect().width>0 && svg.getBoundingClientRect().height>0 && !svg.closest("[hidden],[inert]")) : [];
}
/** Snapshot the actual plotted SVGs, including comparison traces and current quantity choices.
 * Resolve CSS roles in the light theme for a standalone figure on white paper. */
export function visibleFigureSvg(root:HTMLElement):string|null {
  const charts=visibleFigureSvgs(root);if(!charts.length)return null;
  const rect=root.getBoundingClientRect();
  const width=Math.max(...charts.map(s=>s.getBoundingClientRect().right-rect.left));
  const height=Math.max(...charts.map(s=>s.getBoundingClientRect().bottom-rect.top));
  const out=document.createElementNS("http://www.w3.org/2000/svg","svg");
  out.setAttribute("xmlns","http://www.w3.org/2000/svg");out.setAttribute("viewBox",`0 0 ${width} ${height}`);
  out.setAttribute("width",`${width/96*25.4}mm`);out.setAttribute("height",`${height/96*25.4}mm`);
  const paper=document.createElementNS("http://www.w3.org/2000/svg","rect");paper.setAttribute("width",String(width));paper.setAttribute("height",String(height));paper.setAttribute("fill","#fff");out.append(paper);
  // Read the light palette synchronously, then restore before the browser paints or any async work.
  const html=document.documentElement, theme=html.getAttribute("data-theme");
  html.setAttribute("data-theme","light");
  try {
    for(const svg of charts) {
      const clone=svg.cloneNode(true) as SVGSVGElement;
      const original=[svg,...svg.querySelectorAll<SVGElement>("*")],copies=[clone,...clone.querySelectorAll<SVGElement>("*")];
      original.forEach((node,k)=>{const style=getComputedStyle(node);for(const key of ["fill","fill-opacity","stroke","stroke-width","stroke-opacity","stroke-dasharray","font-family","font-size","font-weight","text-anchor","dominant-baseline","opacity","paint-order","stroke-linecap","stroke-linejoin"])copies[k].style.setProperty(key,style.getPropertyValue(key));});
      const box=svg.getBoundingClientRect();clone.setAttribute("x",String(box.left-rect.left));clone.setAttribute("y",String(box.top-rect.top));clone.setAttribute("width",String(box.width));clone.setAttribute("height",String(box.height));
      for(const text of clone.querySelectorAll(".c-tick")) {
        text.textContent=text.textContent?.replace(/(\d),(?=\d)/g,"$1.") ?? "";
      }
      out.append(clone);
    }
    // HTML legends occupy space reserved by the plotted SVG. Convert their keys and labels to vectors.
    for(const item of root.querySelectorAll<HTMLElement>(".chart .legend-item")) {
      const box=item.getBoundingClientRect();
      if(!box.width || !box.height || item.closest("[hidden],[inert]"))continue;
      const key=item.querySelector<HTMLElement>(".legend-key");
      const text=document.createElementNS("http://www.w3.org/2000/svg","text");
      const style=getComputedStyle(item);
      text.setAttribute("x",String((key?.getBoundingClientRect().right ?? box.left)+4-rect.left));
      text.setAttribute("y",String(box.top+box.height/2-rect.top));
      text.setAttribute("dominant-baseline","middle");text.setAttribute("fill",style.color);
      text.setAttribute("font-family",style.fontFamily);text.setAttribute("font-size",style.fontSize);
      text.textContent=item.textContent?.trim() ?? "";out.append(text);
      if(key) {
        const r=key.getBoundingClientRect(), st=getComputedStyle(key);
        const color=st.backgroundImage.match(/rgba?\([^)]+\)/)?.[0] ?? st.backgroundColor;
        if(key.classList.contains("legend-point")) {
          const symbol=document.createElementNS("http://www.w3.org/2000/svg",key.classList.contains("legend-point-diamond") ? "path" : "circle");
          const cx=r.left+r.width/2-rect.left,cy=r.top+r.height/2-rect.top;
          if(symbol.tagName==="circle") {symbol.setAttribute("cx",String(cx));symbol.setAttribute("cy",String(cy));symbol.setAttribute("r","4");}
          else symbol.setAttribute("d",`M${cx},${cy-4}l4,4l-4,4l-4,-4Z`);
          symbol.setAttribute("fill",color);out.append(symbol);continue;
        }
        const line=document.createElementNS("http://www.w3.org/2000/svg","line");
        line.setAttribute("x1",String(r.left-rect.left));line.setAttribute("x2",String(r.right-rect.left));
        line.setAttribute("y1",String(r.top+r.height/2-rect.top));line.setAttribute("y2",String(r.top+r.height/2-rect.top));
        line.setAttribute("stroke",color);line.setAttribute("stroke-width","2");
        if(st.backgroundImage!=="none")line.setAttribute("stroke-dasharray","4 3");out.append(line);
      }
    }
  } finally {if(theme===null)html.removeAttribute("data-theme");else html.setAttribute("data-theme",theme);}
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
export async function saveVisibleFigure(root:HTMLElement|null,base:string,format:"svg"|"png",title?:string) {
  let svg=root && visibleFigureSvg(root);if(!svg){exportNotice(t("contextExport.noChart"));return;}
  if(title)svg=titledSvg(svg,title);
  if(format==="svg")svg=svg.replace(/(<svg[^>]*>)/,`$1<style>${await embeddedFontFaces()}</style>`);
  const name=`${base.replace(/[^a-z0-9._+-]+/gi,"_")}.${format}`;
  const data=format==="svg" ? svg : await (await import("../drawing/render")).svgToPng(svg,300);
  downloadToast(await saveDownload(name,data,format==="svg"?"image/svg+xml":"image/png"));
}
