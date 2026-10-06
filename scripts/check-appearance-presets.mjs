import assert from 'node:assert/strict';
import { APPEARANCE_OPTIONS, CUSTOM_COLORS, COLOR_DEFAULTS, appearanceTokens } from '../src/lib/appearanceOptions.ts';
import { GENERAL_DEFAULTS, GENERAL_SETTINGS_KEY, readGeneralSettings, writeGeneralSettings } from '../src/lib/generalSettings.ts';
import { APPEARANCE_DEFAULTS } from '../src/lib/appearance.ts';
const data=new Map();const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
for(const dark of [false,true])assert.deepEqual(appearanceTokens(COLOR_DEFAULTS,dark),{},'exact incumbent defaults');
for(const [key,options]of Object.entries(APPEARANCE_OPTIONS))for(const option of options){
 const changed={...GENERAL_DEFAULTS,[key]:option,threads:6,language:'tr'};writeGeneralSettings(changed,storage);assert.deepEqual(readGeneralSettings(storage),changed);
 data.set(GENERAL_SETTINGS_KEY,JSON.stringify({...changed,[key]:'invalid'}));assert.equal(readGeneralSettings(storage)[key],COLOR_DEFAULTS[key]);assert.equal(readGeneralSettings(storage).threads,6);
 assert.throws(()=>writeGeneralSettings({...changed,[key]:'invalid'},storage),/Invalid/);
}
writeGeneralSettings({...GENERAL_DEFAULTS,threads:6,accent:'blue',chartWeight:3,...APPEARANCE_DEFAULTS},storage);
assert.equal(readGeneralSettings(storage).threads,6);assert.equal(readGeneralSettings(storage).accent,'copper');
// Verify foreground contrast for every nondefault accent against its action background.
function luminance(hex){const rgb=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];}
function ratio(a,b){const values=[luminance(a),luminance(b)].sort((x,y)=>x-y);return(values[1]+.05)/(values[0]+.05);}
for(const dark of [false,true])for(const accent of ['blue','teal','violet']){
 const t=appearanceTokens({...COLOR_DEFAULTS,accent},dark);assert.ok(ratio(t['--al-action'],dark?'#1a1917':'#ffffff')>=4.5,`${accent} button contrast`);
 for(const colorPreset of APPEARANCE_OPTIONS.colorPreset){const surfaces=appearanceTokens({...COLOR_DEFAULTS,colorPreset},dark);const bg=surfaces['--al-surface']??(dark?'#1a1917':'#f9f8f4');assert.ok(ratio(t['--al-accent-text'],bg)>=4.5,`${accent} ${colorPreset} text contrast`);}
}
for(const key of CUSTOM_COLORS){writeGeneralSettings({...GENERAL_DEFAULTS,[key]:'#1234ab',threads:6},storage);assert.equal(readGeneralSettings(storage)[key],'#1234ab');data.set(GENERAL_SETTINGS_KEY,JSON.stringify({...GENERAL_DEFAULTS,[key]:'url(bad)',threads:6}));assert.equal(readGeneralSettings(storage)[key],'');assert.equal(readGeneralSettings(storage).threads,6);assert.throws(()=>writeGeneralSettings({...GENERAL_DEFAULTS,[key]:'#123'},storage),/Invalid/);}
for(const customAccent of ['#ffffff','#000000','#777777','#ffff00','#00ff00','#0000ff']){const tokens=appearanceTokens({...COLOR_DEFAULTS,customAccent},false);assert.ok(ratio(customAccent,tokens['--al-action-text'])>=4.5);}
console.log('Appearance presets: exact defaults, independent recovery, persistence/reset and accent contrast passed');
