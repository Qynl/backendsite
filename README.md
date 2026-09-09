# ÆTHER

**A backend that is not a place.**

Convex-shaped queries. Firestore-shaped collections. Zero origin servers. Zero accounts. Zero bill.

The database is a join-semilattice of signed CRDT replicas living in browsers. Public BitTorrent trackers and MQTT brokers are used as *matchmakers* (they exchange WebRTC offers, never your documents). After handshake, every write gossips peer-to-peer. Same-origin tabs also sync on `BroadcastChannel`. Each replica persists to IndexedDB. Encrypted snapshots can sleep as MQTT retained messages so a cold browser can wake the lattice even if nobody else is online. Capsules (downloadable JSON) are the full backup.

```
Ω = ⊔ { replica(p) | p ∈ swarm }
```

Capability = the namespace string. Any website that opens the same name **is the same backend**.

---

## Connect any website — the easy way

**Easiest: generate a secret on the exhibition page (Plate V), copy the tag, paste it into every site.**

That tag is the whole backend.

### 1. One HTML tag (no JavaScript required)

```html
<script src="https://YOUR-HOST/aether.js" data-aether="ae-xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx"></script>
```

When the script loads it opens the namespace by itself.

- `window.db` is the backend
- `Aether.db` is the same object
- `document.addEventListener('aether-ready', e => { const db = e.detail })` if you want a callback
- `data-pass="…"` optional AES passphrase
- `data-as="backend"` if you want `window.backend` instead of `window.db`

`YOUR-HOST` is wherever `aether.js` is served as a **static file** (this preview, GitHub Pages, your own origin, a USB stick). CORS is already `*`. That host is not the database.

### 2. Or one function

```html
<script src="https://YOUR-HOST/aether.js"></script>
<script>
  Aether.hitch('ae-xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx').then(db => {
    db.set('hello', { from: location.host });
  });
</script>
```

`Aether.connect` and `Aether.open` do the same thing. A connection string also works:

```js
Aether.hitch('aether://ae-xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx#optional-pass')
```

Generate a secret with `Aether.secret()`.

### 3. Hitch a second website

Paste **the same tag** (same `data-aether` value) on the other origin. That is the entire sync setup. WebRTC does not care which domain you are on.

On this repo: `index.html`, `elsewhere.html`, and `hitch.html?ns=YOUR-SECRET` can all share one lattice.

### 4. Invent a namespace (if you are not using the generator)

The name **is** the API key, the database URL, and the lock.

```
good:  ae-9f3c2a10-k7q2b8c1-never-publish
bad:   test, genesis, my-app
```

Anyone who knows the string can join the swarm. Do not commit it if the data is private.

Optional second lock: `data-pass` / `{ passphrase }` encrypts every value with AES-GCM. Trackers still group by the name; lurkers without the passphrase only see ciphertext.

### 5. Use it like any backend

**Queries & mutations (Convex-shaped)**

Functions run on this replica, then writes gossip. There is no Convex cloud.

```js
Aether.define({
  messages: {
    list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),
    send: Aether.mutation(async (ctx, { body }) => {
      await ctx.db.insert('messages', { body, author: ctx.auth.id.slice(0, 8) });
    })
  }
});

db.live('messages.list', rows => render(rows));
await db.run('messages.send', { body: 'hello' });
```

Or after `define`, no further JS:

```html
<ul data-ae="messages.list"><template><li>{body}</li></template></ul>
<form data-ae-run="messages.send"><input name="body" /></form>
```

`ctx.db` has `insert`, `get`, `patch`, `replace`, `delete`, `query(table)`. Documents get `_id` (`table:id`) and `_creationTime`. Open `hitch.html?ns=YOUR-SECRET` for a live room.

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

## vs Convex

Convex is a hosted reactive database: TypeScript queries/mutations run on *their* servers, the client subscribes, the UI updates. Æther copies that **shape** (`define`, `query`, `mutation`, `live`, `run`, `ctx.db.insert`) and deletes the company.

| | Convex | ÆTHER |
|---|---|---|
| `query` / `mutation` | runs in Convex cloud | runs on every replica (your browser) |
| live UI | websocket to Convex | WebRTC mesh + BroadcastChannel |
| `ctx.db.insert/get/patch` | ACID on their cluster | LWW CRDT join (eventually consistent, mathematically unique Ω) |
| auth | Convex Auth | ECDSA keypair = user |
| cost / lock-in | metered, their region | zero, no address |
| server functions with secrets | yes (their RAM) | no — there is no secret server. Put secrets in the namespace/passphrase. |
| React `useQuery` | official | `db.live(...)` or `data-ae="messages.list"` |

Same feeling: write a function, subscribe, the room updates. Different physics: nothing to deploy but a static file.

```js
Aether.define({
  messages: {
    list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),
    send: Aether.mutation(async (ctx, { body }) => {
      await ctx.db.insert('messages', { body });
    })
  }
});
db.live('messages.list', render);
await db.run('messages.send', { body: 'hi' });
```

HTML with no further JS:

```html
<ul data-ae="messages.list"><template><li>{body}</li></template></ul>
<form data-ae-run="messages.send"><input name="body" /></form>
```

Open `hitch.html?ns=YOUR-SECRET` for a live room.

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
