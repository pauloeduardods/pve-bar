// SPDX-License-Identifier: GPL-3.0-or-later
// install.sh in a throwaway HOME, with fake binaries and no systemd.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pve-bar-install-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    for (const name of ['pved', 'pvectl'])
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name}\n`, {mode: 0o755});
    const env = {...process.env, HOME: home, PVE_BAR_BIN_DIR: bin, PVE_BAR_NO_SYSTEMD: '1'};
    delete env.XDG_DATA_HOME;
    delete env.XDG_CONFIG_HOME;
    const run = (...args) => execFileSync(path.join(REPO, 'install.sh'), args, {env, encoding: 'utf8', stdio: 'pipe'});
    return {root, home, run};
}

/** Every path under dir, relative, sorted (node 18 has no recursive readdir). */
function listFiles(dir, prefix = '') {
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const rel = path.join(prefix, entry.name);
        return entry.isDirectory() ? [rel, ...listFiles(path.join(dir, entry.name), rel)] : [rel];
    }).sort();
}

test('installs everything under HOME and renders the binary path', t => {
    const {root, home, run} = sandbox();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    run();
    const pved = path.join(home, '.local/libexec/pve-bar/pved');
    assert.ok(fs.statSync(pved).mode & 0o100);
    assert.ok(fs.existsSync(path.join(home, '.local/bin/pvectl')));
    const unit = fs.readFileSync(path.join(home, '.config/systemd/user/pved.service'), 'utf8');
    assert.match(unit, new RegExp(`^ExecStart=${pved}$`, 'm'));
    assert.doesNotMatch(unit, /@PVED@/);
    const activation = fs.readFileSync(
        path.join(home, '.local/share/dbus-1/services/io.github.pauloeduardods.PveBar1.service'), 'utf8');
    assert.match(activation, /^SystemdService=pved\.service$/m);
    const ext = path.join(home, '.local/share/gnome-shell/extensions/pve-bar@paulo');
    assert.ok(fs.existsSync(path.join(ext, 'metadata.json')));
    assert.ok(fs.existsSync(path.join(ext, 'schemas/gschemas.compiled')));
});

test('reinstall works and uninstall removes exactly what it installed', t => {
    const {root, home, run} = sandbox();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    fs.mkdirSync(path.join(home, '.config/pve-bar'), {recursive: true});
    fs.writeFileSync(path.join(home, '.config/pve-bar/pved.conf'), '# mine\n');
    run();
    run();
    run('--uninstall');
    assert.deepEqual(listFiles(home), ['.config', '.config/pve-bar', '.config/pve-bar/pved.conf']);
});

test('refuses to overwrite a file it did not install', t => {
    const {root, home, run} = sandbox();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    fs.mkdirSync(path.join(home, '.local/bin'), {recursive: true});
    fs.writeFileSync(path.join(home, '.local/bin/pvectl'), 'someone else');
    assert.throws(() => run(), /already exists and was not installed by this script/);
    assert.equal(fs.readFileSync(path.join(home, '.local/bin/pvectl'), 'utf8'), 'someone else');
    assert.ok(!fs.existsSync(path.join(home, '.local/share/pve-bar')));
});

test('uninstall without an install is a no-op', t => {
    const {root, run} = sandbox();
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    assert.match(run('--uninstall'), /Nothing to uninstall/);
});
