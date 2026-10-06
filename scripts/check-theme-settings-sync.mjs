import assert from 'node:assert/strict';
import { syncSavedTheme, readGeneralSettings, writeGeneralSettings, GENERAL_DEFAULTS, GENERAL_SETTINGS_KEY, THREADS_MIGRATED_KEY } from '../src/lib/generalSettings.ts';
const m=new Map([[GENERAL_SETTINGS_KEY,JSON.stringify({...GENERAL_DEFAULTS,theme:'light',threads:6,customAccent:'#123456',futureSetting:'keep'})],[THREADS_MIGRATED_KEY,'1'],['fairbeam.theme','dark']]);
const storage={getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)};
syncSavedTheme('dark',storage);
assert.deepEqual(JSON.parse(m.get(GENERAL_SETTINGS_KEY)),{...GENERAL_DEFAULTS,theme:'dark',threads:6,customAccent:'#123456',futureSetting:'keep'});
writeGeneralSettings({...readGeneralSettings(storage),chartWeight:3},storage);
assert.equal(m.get('fairbeam.theme'),'dark');
for(const malformed of ['{bad','null','[]']){m.set(GENERAL_SETTINGS_KEY,malformed);syncSavedTheme('light',storage);assert.equal(m.get(GENERAL_SETTINGS_KEY),malformed);}
m.delete(GENERAL_SETTINGS_KEY);syncSavedTheme('dark',storage);assert.equal(m.has(GENERAL_SETTINGS_KEY),false);
assert.doesNotThrow(()=>syncSavedTheme('dark',{getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}}));
assert.doesNotThrow(()=>syncSavedTheme('dark',{getItem:()=>JSON.stringify(GENERAL_DEFAULTS),setItem:()=>{throw new Error('quota');}}));
console.log('Header theme synchronization preserves settings, migration fallback and storage failures');
