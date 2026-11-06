// Run the existing pure check groups once per exact command. No shell, retries,
// cached test results or changed assertions; standalone npm groups still work.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const groups = ['check:designer', 'check:cst', 'check:exports', 'check:state-lifecycle'];

export function planChecks(scripts, selected = groups) {
  const commands = new Map();
  let occurrences = 0;
  const expand = (name, parents = []) => {
    if (parents.includes(name)) throw new Error(`Recursive npm check: ${[...parents, name].join(' -> ')}`);
    if (typeof scripts[name] !== 'string') throw new Error(`Missing npm check: ${name}`);
    for (const part of scripts[name].split('&&')) {
      const command = part.trim();
      const alias = /^npm run -s (check:[a-z0-9-]+)$/.exec(command);
      if (alias) { expand(alias[1], [...parents, name]); continue; }
      // Reject new shell syntax instead of silently omitting/reinterpreting a check.
      if (!/^node (?:[A-Za-z0-9_./=:-]+\s*)+$/.test(command)) throw new Error(`Unsupported check command: ${command}`);
      const args = command.split(/\s+/).slice(1);
      const key = JSON.stringify(args);
      occurrences++;
      if (!commands.has(key)) commands.set(key, {command, args, groups: []});
      commands.get(key).groups.push(name);
    }
  };
  selected.forEach(name => expand(name));
  return {checks: [...commands.values()], occurrences, duplicates: occurrences - commands.size};
}

export async function runChecks(plan, execute) {
  for (const check of plan.checks) await execute(check);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = planChecks(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts);
  console.log(`CI web checks: ${plan.checks.length} unique commands; ${plan.duplicates} identical repeats removed (${plan.occurrences} original occurrences).`);
  if (process.argv.includes('--list')) { for (const check of plan.checks) console.log(check.command); return; }
  await runChecks(plan, check => new Promise((ok, fail) => {
    console.log(`\n> ${check.command}`);
    const child = spawn(process.execPath, check.args, {cwd: root, env: process.env, stdio: 'inherit', windowsHide: true});
    child.once('error', fail);
    child.once('close', (code, signal) => code === 0 ? ok() : fail(new Error(`${check.command}: exit ${code}, signal ${signal}`)));
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
