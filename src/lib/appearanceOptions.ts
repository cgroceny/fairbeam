export const APPEARANCE_OPTIONS = {
  colorPreset: ["default", "ocean", "forest", "plum", "contrast"],
  accent: ["copper", "blue", "teal", "violet"],
  chartPalette: ["default", "accessible", "muted"],
  chartWeight: [2, 1.5, 3],
  viewportPalette: ["default", "slate", "paper", "blueprint"],
} as const;
export const CUSTOM_COLORS = ["customAccent", "traceColor", "viewportColor", "gridColor"] as const;
export const validCustomColor = (color: unknown) => color === undefined || color === "" || (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
export type ColorSettings = { colorPreset: "default" | "ocean" | "forest" | "plum" | "contrast"; accent: "copper" | "blue" | "teal" | "violet"; chartPalette: "default" | "accessible" | "muted"; chartWeight: 2 | 1.5 | 3; viewportPalette: "default" | "slate" | "paper" | "blueprint"; customAccent: string; traceColor: string; viewportColor: string; gridColor: string };
export const COLOR_DEFAULTS: ColorSettings = { colorPreset: "default", accent: "copper", chartPalette: "default", chartWeight: 2, viewportPalette: "default", customAccent:"", traceColor:"", viewportColor:"", gridColor:"" };
export function validColorSettings(v: Record<string, unknown>): boolean {
  return CUSTOM_COLORS.every(key=>validCustomColor(v[key])) && Object.entries(APPEARANCE_OPTIONS).every(([key, options]) => v[key] === undefined || (options as readonly unknown[]).includes(v[key]));
}
/** Default returns no overrides: existing light/dark tokens remain exact. */
export function appearanceTokens(v: ColorSettings, dark: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const surfaces = { ocean: dark?["#111820","#18212b","#202b36","#293541"]:["#eef2f5","#ffffff","#f3f6f8","#e8eef3"], forest:dark?["#111914","#19261e","#243128","#303d32"]:["#eef4ed","#fafdf8","#eff5ec","#e4eddf"], plum:dark?["#19131c","#241c29","#302637","#3b3042"]:["#f5eff6","#fdfafd","#f4edf5","#ede3ef"] };
  if(v.colorPreset!=="default" && v.colorPreset!=="contrast") {
    const palette=surfaces[v.colorPreset];
    ["--al-bg","--al-surface","--al-surface-2","--al-surface-3"].forEach((key,i)=>out[key]=palette[i]);
  }
  if (v.colorPreset === "contrast") Object.assign(out, dark ? { "--al-bg":"#080808", "--al-surface":"#101010", "--al-surface-2":"#171717", "--al-surface-3":"#222222", "--al-border":"#767676", "--al-border-strong":"#999999" } : { "--al-bg":"#ffffff", "--al-surface":"#ffffff", "--al-surface-2":"#f5f5f5", "--al-surface-3":"#eeeeee", "--al-border":"#767676", "--al-border-strong":"#666666" });
  if (v.accent !== "copper") {
    const ramp = { blue: dark ? ["#8bbcf2","#a8cdf5","#15273b","#263b53"] : ["#245a91","#184473","#edf4fb","#d7e7f7"], teal: dark ? ["#73cabb","#a0ded3","#142e29","#21423b"] : ["#246456","#184d41","#eaf5f1","#d1e9e0"], violet: dark ? ["#bba5ec","#d0bff4","#2b2239","#3b2e50"] : ["#684792","#513573","#f4effa","#e5d9f2"] }[v.accent];
    const [action,hover,soft,selection]=ramp;
    Object.assign(out,{ "--al-action":action,"--al-action-hover":hover,"--al-accent-text":hover,"--al-accent-soft":soft,"--al-accent-line":action,"--al-focus":action,"--al-selection":selection,"--al-brand-mark":action });
  }
  const palettes = { accessible: dark ? ["#79b7ef","#f3a252","#67cbbb","#e7cb6d","#d99ac8","#b1c981","#b1a8ec","#ee9591"] : ["#2166ac","#b35806","#168578","#9e7617","#995b8a","#5d7e29","#7358ac","#b94440"], muted: dark ? ["#8daecb","#d4a680","#8ebfb0","#c9bd8a","#bd9bb2","#a7b18d","#a9a0ca","#c49791"] : ["#486e91","#955b32","#467b69","#867126","#875a78","#67743c","#6f608e","#99554c"] };
  if(v.chartPalette!=="default") palettes[v.chartPalette].forEach((color,i)=>out[`--al-series-${i+1}`]=color);
  if(v.chartWeight!==2)out["--al-chart-line-weight"]=String(v.chartWeight);
  if(v.viewportPalette!=="default") {
    const colors={ slate:dark?["#151e29","#263344","#46566a"]:["#dce4eb","#c1cbd6","#9aa9ba"], paper:dark?["#211f1a","#333027","#504a3d"]:["#f7f3e9","#e0d9c9","#bcb29c"], blueprint:dark?["#0d2440","#183953","#365b7b"]:["#e4edf7","#c3d5e9","#90abc8"] }[v.viewportPalette];
    ["--al-viewport","--al-viewport-grid","--al-viewport-grid-major"].forEach((key,i)=>out[key]=colors[i]);
  }
  if(v.customAccent) {
    const color=v.customAccent;
    const channels=color.slice(1).match(/../g)!.map(x=>parseInt(x,16)/255);
    const lum=channels.map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
    const ink=lum>.179?"#000000":"#ffffff";
    // Custom action text always has >=4.5:1 contrast. Accent labels use readable foreground roles.
    Object.assign(out,{"--al-action":color,"--al-action-hover":color,"--al-action-text":ink,"--al-focus":"var(--al-text)","--al-accent-line":color,"--al-brand-mark":color,"--al-accent-text":"var(--al-text)"});
  }
  if(v.traceColor)out["--al-series-1"]=v.traceColor;
  if(v.viewportColor)out["--al-viewport"]=v.viewportColor;
  if(v.gridColor){out["--al-viewport-grid"]=v.gridColor;out["--al-viewport-grid-major"]=v.gridColor;}
  return out;
}
