# ÆTHER

**A backend that is not a place.**

Firebase-shaped API. Zero origin servers. Zero accounts. Zero bill.

The database is a join-semilattice of signed CRDT replicas living in browsers. Public BitTorrent trackers and MQTT brokers are used as *matchmakers* (they exchange WebRTC offers, never your documents). After handshake, every write gossips peer-to-peer. Same-origin tabs also sync on `BroadcastChannel`. Each replica persists to IndexedDB. Encrypted snapshots can sleep as MQTT retained messages so a cold browser can wake the lattice even if nobody else is online. Capsules (downloadable JSON) are the full backup.

```
Ω = ⊔ { replica(p) | p ∈ swarm }
```

Capability = the namespace string. Any website that opens the same name **is the same backend**.

---

## Connect any website — exact steps

### 1. Get `aether.js`

It is one file. No npm. No build.

- Copy `aether.js` next to your HTML, **or**
- Hotlink it from wherever this exhibition is hosted (CORS is `*`).

```html
<script src="https://YOUR-HOST/aether.js"></script>
```

`YOUR-HOST` is the origin serving this repo (GitHub Pages, this preview, your CDN, a USB stick). It only serves a static file. It is not the backend.

### 2. Invent a namespace

The name **is** the API key, the database URL, and the access control root.

```
good:  acme-notes-9f3c-k7q2-never-publish-this
bad:   test, genesis, my-app
```

Anyone who knows the string can join the swarm. Treat it like a password. Do not put it in a public repo if the data is private.

Optional second lock: a passphrase encrypts every value with AES-GCM. Trackers still group by the name; lurkers without the passphrase only see ciphertext.

### 3. Open the backend (this replaces `initializeApp` + `getFirestore`)

```html
<script src="./aether.js"></script>
<script type="module">
  const db = await Aether.open('acme-notes-9f3c-k7q2-never-publish-this', {
    // optional:
    passphrase: 'second-secret',
    rules: {
      '*': { read: true, write: true },
      'users/:id': { read: true, write: 'owner' },
      'private/*': { read: true, write: 'owner' }
    }
  });
</script>
```

Classic scripts work too: wrap the `await` in an `async` IIFE.

```html
<script src="./aether.js"></script>
<script>
  (async () => {
    const db = await Aether.open('acme-notes-9f3c-k7q2-never-publish-this');
    window.db = db;
  })();
</script>
```

### 4. Use it like any backend

**Key-value (the primitive)**

```js
await db.set('config/theme', 'void');
db.get('config/theme');          // 'void'
await db.update('config/theme', { dark: true }); // if value is an object
await db.del('config/theme');
db.scan('config/');              // prefix scan
db.watch('config/', (key, value) => { /* live */ });
```

**Collections (Firestore-shaped)**

```js
const users = db.col('users');

await users.doc('ada').set({ name: 'Ada', year: 1843 });
await users.doc('ada').update({ year: 1852 });
users.doc('ada').get();
await users.add({ name: 'Grace' });          // auto id
await users.doc('ada').delete();

users.on((docs) => render(docs));            // live list
const found = users.where('year', '>=', 1800).orderBy('year', 'desc').limit(10).get();
users.where('name', '==', 'Ada').on((docs) => { /* live query */ });
```

**Counters, logs, presence**

```js
await db.inc('signups', 1);
db.count('signups');

await db.append('audit', { what: 'login', at: Date.now() });
db.tail('audit', 50);

db.presence();   // who is online in the last ~35s
```

**Auth (there is no password server)**

The replica keypair **is** the user. It is born in this browser and stored in IndexedDB.

```js
db.auth.me();                         // { id, pub }
await db.auth.claim('ada');           // first-writer-wins username
db.auth.name();                       // 'ada'
db.auth.whois('ada');                 // { id, pub }
const seed = db.auth.exportSeed();    // recover on another device
await db.auth.importSeed(seed);
```

**Rules (enforced by every honest replica)**

```js
await db.protect({
  '*': { read: true, write: true },
  'users/:id': { write: 'owner' },     // first writer owns the doc
  'admin/*': { write: 'founder' }
});
```

`write` may be `true`, `false`, `'owner'`, `'founder'`, `'auth'`.

P2P cannot hide a document from a malicious replica that already joined. For secrets, use `passphrase` and an unguessable namespace. Rules stop honest clients and drop forged/illegal events.

**Files (content-addressed blobs, ≤ 2MB)**

```js
const cid = await db.files.put(fileInput.files[0]);
const blob = await db.files.get(cid);
```

**Transactions**

```js
await db.batch([
  ['set', '@/users/ada', { name: 'Ada' }],
  ['set', 'stats/note', 1]
]);
```

**Backup / migrate / never lose the last copy**

```js
const capsule = db.exportCapsule();          // JSON object
download(JSON.stringify(capsule));           // you implement download
await db.importCapsule(capsule);             // restore on a fresh browser
await db.waitSync(4000);                     // wait for mesh / keeper
```

Keepers: every ~40s an encrypted-or-plain gzip snapshot is retained on public MQTT if it fits (~180KB). A brand-new browser that knows the namespace hydrates from that retain, then from peers.

### 5. Hitch a *second* website to the same backend

On a totally different origin (your shop, your game, your blog):

```html
<script src="https://YOUR-HOST/aether.js"></script>
<script>
  (async () => {
    const db = await Aether.open('acme-notes-9f3c-k7q2-never-publish-this');
    // same users, same counters, same files
    console.log(db.col('users').get());
  })();
</script>
```

WebRTC does not care about origin. Same name → same infohash → same swarm → same Ω.

Proof in this repo: `index.html` (the void) and `elsewhere.html` (a paper journal) share `æther://genesis`.

### 6. Verify it is not talking to “your server”

Open DevTools → Network.

You should see:

- `GET aether.js` (static)
- `wss://tracker…` (BitTorrent announce, SDP only)
- `wss://broker…` (MQTT, SDP + optional retained snapshot)
- STUN to Google/Cloudflare (ICE)
- **No** `fetch`/`XHR` to an API of yours

WebRTC datachannels often do not show as HTTP. `chrome://webrtc-internals` shows them.

### 7. Ship it

Host `aether.js` + your site as static files (GitHub Pages, nginx, S3, a phone). That is the whole deploy. There is no env var, no dashboard, no region.

---

## What you get vs a normal backend

| | Firebase / Supabase | ÆTHER |
|---|---|---|
| Documents / collections | yes | yes (`col`, `doc`, `where`, `orderBy`, `limit`, live `on`) |
| Auth | passwords, OAuth, their servers | ECDSA P-256 keypair = user. Claimable names. Portable seed |
| Rules | server-enforced | replica-enforced + passphrase cipher |
| Files | object storage | content-addressed chunks in the lattice |
| Realtime | websocket to vendor | WebRTC mesh + BroadcastChannel |
| Offline | persistence layer | the replica **is** the database |
| Counters / logs | you build them | `inc` / `append` |
| Backup | vendor export | `exportCapsule` / `importCapsule` + MQTT keepers |
| Cost | meters | 0 |
| Who can shut it down | the company | nobody. There is no address. |
| Cold start, zero peers | vendor disk | IndexedDB of last browser, MQTT retain, or a capsule file |

## Honest limits (still not fake)

- No TURN on purpose. Two peers both behind hostile symmetric NAT may not get a *direct* pipe. A third peer still gossips. MQTT keepers still hydrate.
- MQTT retained snapshots are best-effort public infrastructure (~180KB). Large lattices rely on the mesh + capsules + IndexedDB.
- A public namespace is a public database.
- Rules are not a military secret store. Passphrase + unguessable name is.

## Algebra

LWW-Map over a hybrid logical clock is a join-semilattice (commutative, associative, idempotent). `Aether.theorem()` runs the proof in the page.

Shapiro, Preguiça, Baquero, Zawirski — *Conflict-free Replicated Data Types*, 2011.

## License

Unlicense / public domain. A protocol, not a product.
