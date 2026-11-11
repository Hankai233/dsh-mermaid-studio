/**
 * register.js hands the browser half to the host's client-module loader.
 *
 * The host keys that module row by *package name* (client-modules:
 * `graphRow(packageName, ...)`) and matches it against the id the bundle passes
 * to `__ModuleLoader__.load()`. A shorter id therefore looks like "the script
 * loaded without registering", the loader re-executes the bundle from its
 * one-resource URL, and the second registration throws
 * `duplicate factory registration` — which surfaces as a web-boot activation
 * failure and a crash log. A package rename must move this id with it.
 *
 * The acceptance harness used to stub the loader without checking the id, so it
 * could not catch the mismatch; this test is the regression net for that.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

async function loadRegister() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const source = await readFile(path.join(ROOT, 'src', 'client', 'register.js'), 'utf8');
  const registrations = [];
  const sandbox = {
    console,
    __MMS__: { createApp: () => ({ start() {}, dispose() {} }) },
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
        // The real loader rejects the replay that follows an id mismatch.
        if (registrations.length > 1) {
          throw new Error(`client-modules: duplicate factory registration for "${registration.id}"`);
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'register.js' });
  return { pkg, registrations };
}

test('registers exactly once, under the package name', async () => {
  const { pkg, registrations } = await loadRegister();
  assert.equal(registrations.length, 1, 'the bundle must call __ModuleLoader__.load once per execution');
  assert.equal(
    registrations[0].id,
    pkg.name,
    'registration id must equal package.json "name" — that is the row key the host looks up'
  );
});

test('registered factory exports a Cordis plugin shape', async () => {
  const { registrations } = await loadRegister();
  const exports = registrations[0].factory(() => {
    throw new Error('register.js must not require anything');
  });
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual([...exports.inject], []);
});
