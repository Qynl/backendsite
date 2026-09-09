#!/usr/bin/env node
/* ÆTHER Node — a replica that keeps the lattice warm. Not a data server.
   The files on disk are a capsule, same as a browser's IndexedDB.

   Usage:
     node node.js keep <namespace> [capsule.json]
     node node.js hitch <namespace>
*/
const fs = require('fs');
const path = require('path');
const Aether = require('./aether.js');

async function keep(ns, file) {
  file = path.resolve(file || 'aether-capsule.json');
  const db = await Aether.open(ns, { persist: false, meter: false });
  if (fs.existsSync(file)) {
    const n = await db.importCapsule(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log('rehydrated', n, 'events from', file);
  }
  let writing = false;
  let dirty = false;
  const flush = () => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    dirty = false;
    fs.writeFile(file, JSON.stringify(db.exportCapsule()), (err) => {
      writing = false;
      if (err) console.error(err);
      else process.stdout.write('·');
      if (dirty) flush();
    });
  };
  db.watch('', flush);
  db.onStatus((t) => {
    if (t === 'peer' || t === 'sync' || t === 'open') {
      const st = db.status();
      console.log('\n' + t, 'peers', st.peerCount, 'events', st.events, 'merkle', st.merkle);
    }
  });
  console.log('keeper replica', db.actor.id, 'ns', ns);
  console.log('this process is a peer, not an API. Ctrl-C writes a last capsule.');
  const bye = async () => {
    fs.writeFileSync(file, JSON.stringify(db.exportCapsule()));
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  return db;
}

async function hitch(ns) {
  const db = await Aether.open(ns, { persist: false, signal: true });
  console.log('hitched', ns, 'actor', db.actor.id);
  return db;
}

const cmd = process.argv[2];
const ns = process.argv[3];
if (require.main === module) {
  if (cmd === 'keep' && ns) keep(ns, process.argv[4]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
  else if ((cmd === 'hitch' || cmd === 'open') && ns) hitch(ns).catch((e) => {
    console.error(e);
    process.exit(1);
  });
  else {
    console.log('Æther', Aether.version);
    console.log('  node node.js keep <namespace> [capsule.json]');
    console.log('  node node.js hitch <namespace>');
    console.log('A Node replica is a peer. It does not become the origin.');
  }
}

module.exports = { keep, hitch, Aether };
