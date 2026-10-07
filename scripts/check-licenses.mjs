import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderNotices } from './licenses/render.mjs';
const fixture = {sections:[{title:'Viewer (npm)',packages:[{ecosystem:'npm',name:'example',version:'1.0.0',license:'MIT',source:'https://example.org',texts:[{name:'LICENSE',text:'Copyright Example\nPermission text'}]}]}]};
assert.match(renderNotices(fixture, {}, '1.0.0'), /Copyright Example\nPermission text/);
for (const license of [null, '', 'UNKNOWN', 'NOASSERTION']) {
 const data = structuredClone(fixture); data.sections[0].packages[0].license = license;
 assert.throws(() => renderNotices(data, {}, '1'), /Missing or unknown license/);
 assert.match(renderNotices(data, {'npm:example@1.0.0':'Reviewed upstream terms.'}, '1'), /Reviewed upstream terms/);
}
const missing = structuredClone(fixture); missing.sections[0].packages[0].texts = [];
assert.throws(() => renderNotices(missing, {}, '1'), /No license text/);
assert.throws(() => renderNotices(missing, {'npm:example@2.0.0':'Different release'}, '1'), /No license text/);
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json'));
assert.equal(config.bundle.resources['../THIRD-PARTY-NOTICES.md'], 'THIRD-PARTY-NOTICES.md');
assert.match(readFileSync('scripts/publish-release.mjs','utf8'), /checksums.set\(notices, sha256\(notices\)\)/);
for (const lang of ['en','tr']) assert.ok(JSON.parse(readFileSync(`src/i18n/${lang}.json`))['about.thirdPartyLicenses']);
const version = JSON.parse(readFileSync('package.json')).version;
assert.equal(config.version, version);
assert.match(readFileSync('landing/index.html','utf8'), /blob\/main\/THIRD-PARTY-NOTICES\.md/);
assert.match(readFileSync('src-tauri/src/main.rs','utf8'), /"licenses" => concat!\("https:\/\/github.com\/ismailakdag\/fairbeam\/blob\/v", env!\("CARGO_PKG_VERSION"\)/);
console.log('License checks: missing licenses/texts, exact-version exceptions, preserved notices and distribution wiring pass.');
