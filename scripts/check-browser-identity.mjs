import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserExecutableIdentity, hostedImageIdentity, windowsFileVersion } from './scenarios/browser-identity.mjs';

export async function browserIdentitySelfTest() {
  assert.deepEqual(hostedImageIdentity({ImageOS:'win25-vs2026',ImageVersion:'20261103.298.1',RUNNER_OS:'Windows',RUNNER_ARCH:'X64',TOKEN:'secret'}),
    {imageOS:'win25-vs2026',imageVersion:'20261103.298.1',runnerOS:'Windows',runnerArch:'X64'});
  assert.deepEqual(hostedImageIdentity({ImageOS:'https://example.test/?token=secret',ImageVersion:'secret\nvalue',RUNNER_OS:'x'.repeat(101)}),
    {imageOS:null,imageVersion:null,runnerOS:null,runnerArch:null});
  let invocations = 0;
  const literal = "C:\\browser's folder\\a & b.exe";
  const execute = (executable, args, options, callback) => {
    invocations++;
    assert.match(executable, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4096);
    assert.equal(options.env.FAIRBEAM_BROWSER_METADATA_PATH, literal);
    assert.equal(args.join(' ').includes(literal), false, 'No path interpolation into shell source');
    assert.match(args.at(-1), /Get-Item -LiteralPath \$env:FAIRBEAM_BROWSER_METADATA_PATH/);
    callback(null, '{"fileVersion":"142.0.1.2","productVersion":"142.0.1.2"}');
  };
  assert.deepEqual(await windowsFileVersion(literal,{execute,env:{SystemRoot:'C:\\Windows'}}), {fileVersion:'142.0.1.2',productVersion:'142.0.1.2'});
  assert.equal(invocations,1);
  for (const output of ['invalid secret', '{"fileVersion":"token=secret","productVersion":"142.0.0.0\nsecret"}', '{}', 'null'])
    assert.equal(await windowsFileVersion(literal,{execute:(_e,_a,_o,cb)=>cb(null,output)}),null);
  assert.equal(await windowsFileVersion(literal,{execute:(_e,_a,_o,cb)=>cb(new Error('secret'))}),null);
  assert.equal(await windowsFileVersion(literal,{execute:()=>{throw new Error('secret');}}),null);

  const root = await mkdtemp(join(tmpdir(),'fairbeam-browser-identity-'));
  try {
    const path=join(root,'not-an-executable.bin'), bytes=Buffer.from('fixture bytes, never execute');
    await writeFile(path,bytes);
    const expected=createHash('sha256').update(bytes).digest('hex');
    let probes=0;
    const readVersion=async value=>{probes++;assert.equal(value,path);return {fileVersion:'142.0.1.2',productVersion:'malformed secret'};};
    const result=await browserExecutableIdentity(path,{platform:'win32',readVersion});
    assert.equal(result.status,'recorded');assert.equal(result.stableDuringRead,true);
    assert.equal(result.sha256,expected);assert.equal(result.bytes,bytes.length);
    assert.equal(result.fileVersion,'142.0.1.2');assert.equal(result.productVersion,null);assert.equal(probes,1);
    assert.doesNotMatch(JSON.stringify(result),/secret|fixture bytes/);
    const other=await browserExecutableIdentity(path,{platform:'linux',readVersion:()=>{throw new Error('Must not run');}});
    assert.equal(other.sha256,expected);assert.equal(other.versionStatus,'not-collected');
    for (const target of [join(root,'missing'),null,42])
      assert.equal((await browserExecutableIdentity(target,{readVersion})).status,'unavailable');
    assert.equal((await browserExecutableIdentity(root,{readVersion})).status,'not-regular-file');
    assert.equal((await browserExecutableIdentity(path,{maxBytes:2,readVersion})).status,'size-limit');
    for (const maxBytes of [0,-1,NaN,Infinity,65*1024*1024])
      assert.equal((await browserExecutableIdentity(path,{maxBytes,readVersion})).status,'unavailable');
    assert.equal(probes,1,'Missing, invalid and oversized files do not launch version helpers');
    const changed=await browserExecutableIdentity(path,{platform:'win32',readVersion:async()=>{await writeFile(path,'changed');return null;}});
    assert.equal(changed.status,'changed-during-read');assert.equal(changed.stableDuringRead,false);
    assert.equal(changed.sha256,expected,'A captured digest is explicitly qualified when the selected file changes');
  } finally {
    assert.equal(resolve(dirname(root)),resolve(tmpdir()));assert(basename(root).startsWith('fairbeam-browser-identity-'));
    await rm(root,{recursive:true,force:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await browserIdentitySelfTest();console.log('Browser identity: bounded disk hash, file-version metadata, literal paths, changed files and environment allowlist passed; no browser launched.');
}
