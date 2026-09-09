/*  ÆTHER  —  the backend that is not a place.
    ──────────────────────────────────────────
    A join-semilattice of signed CRDT replicas that inhabit browsers.
    No origin server holds data. Public BitTorrent trackers and MQTT
    brokers are matchmakers (SDP) and optional keepers (encrypted
    retained snapshots). After handshake, mutations gossip over WebRTC.
    Same-origin tabs sync on BroadcastChannel. Persistence is IndexedDB
    plus capsule export. Ω is the least upper bound of all replicas.

    Capability = the namespace string. Any origin that opens the same
    name is the same backend.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Aether = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.6.0';
  const CHAN = 'aether';
  const MAX_PEERS = 24;
  const CHUNK = 12000;
  const EVENT_CAP = 8000;
  const KEEP_MAX = 180000;
  const GATE_NS = 'æther://gate';
  const GENESIS_NS = 'æther://genesis';
  const FOUNDER_EMAIL = 'qynlden@tutamail.com';
  const TICKET_KEY = 'aether.ticket';
  const PENDING_KEY = 'aether.pendingLogin';
  const PLANS = {
    anon: {
      ns: 1,
      keys: 24,
      writes: 40,
      peers: 4,
      files: 8 * 1024,
      eur: 0,
      label: 'anon',
      blurb: 'No email yet. Tiny room.'
    },
    spark: {
      ns: 1,
      keys: 80,
      writes: 200,
      peers: 8,
      files: 2e6,
      eur: 0,
      label: 'spark',
      blurb: 'Email-proven. Free. Enough to hitch a site.'
    },
    braid: {
      ns: 20,
      keys: 8000,
      writes: 20000,
      peers: 24,
      files: 2e6,
      eur: 9,
      label: 'braid',
      blurb: 'Twenty namespaces. Real apps.'
    },
    loom: {
      ns: 100,
      keys: 100000,
      writes: Infinity,
      peers: 24,
      files: 2e6,
      eur: 29,
      label: 'loom',
      blurb: 'Wide limits. Still no server of yours.'
    },
    void: {
      ns: Infinity,
      keys: Infinity,
      writes: Infinity,
      peers: Infinity,
      files: Infinity,
      eur: 0,
      label: 'void',
      blurb: 'Admin. Infinite. Full control.'
    }
  };
  const DEFAULT_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.novage.com.ua:8000/announce'
  ];
  const DEFAULT_MQTT = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };

  const te = new TextEncoder();
  const td = new TextDecoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => {
    const u = new Uint8Array(h.length / 2);
    for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
    return u;
  };
  const randBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
  const binary20 = (u8) => {
    let s = '';
    for (let i = 0; i < 20; i++) s += String.fromCharCode(u8[i]);
    return s;
  };
  const binToHex20 = (s) => {
    if (!s) return '';
    if (typeof s !== 'string') s = String(s);
    if (/^[0-9a-f]{40}$/i.test(s)) return s.toLowerCase();
    let h = '';
    const n = Math.min(s.length, 20);
    for (let i = 0; i < n; i++) h += s.charCodeAt(i).toString(16).padStart(2, '0');
    return h;
  };
  const sha256 = async (data) => {
    const buf = typeof data === 'string' ? te.encode(data) : data;
    return hex(await crypto.subtle.digest('SHA-256', buf));
  };
  const canonical = (obj) => {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  };
  const uid = () => hex(randBytes(8));
  function u8b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
  }
  function b64u8(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function cmp(a, op, b) {
    if (op === '==') return a === b;
    if (op === '!=') return a !== b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === 'in') return Array.isArray(b) && b.indexOf(a) !== -1;
    if (op === 'contains') return String(a).indexOf(String(b)) !== -1;
    return false;
  }
  async function deriveAes(pass, saltHex) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: te.encode(saltHex.slice(0, 32)), iterations: 80000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function gzipU8(u8) {
    if (typeof CompressionStream === 'undefined') return u8;
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    await w.write(u8);
    await w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function gunzipU8(u8) {
    if (typeof DecompressionStream === 'undefined') return u8;
    try {
      const ds = new DecompressionStream('gzip');
      const w = ds.writable.getWriter();
      await w.write(u8);
      await w.close();
      return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    } catch {
      return u8;
    }
  }

  class HLC {
    constructor(actor) {
      this.actor = actor;
      this.pt = 0;
      this.l = 0;
    }
    stamp() {
      const t = Date.now();
      if (t > this.pt) {
        this.pt = t;
        this.l = 0;
      } else this.l++;
      return this.fmt();
    }
    observe(ts) {
      const o = HLC.parse(ts);
      if (!o) return;
      const t = Date.now();
      const pt = Math.max(t, this.pt, o.pt);
      let l;
      if (pt === t && t > this.pt && t > o.pt) l = 0;
      else if (this.pt === o.pt) l = Math.max(this.l, o.l) + 1;
      else if (this.pt > o.pt) l = pt === this.pt ? this.l + 1 : 1;
      else l = pt === o.pt ? o.l + 1 : 1;
      this.pt = pt;
      this.l = l;
    }
    fmt() {
      return `${String(this.pt).padStart(15, '0')}:${String(this.l).padStart(6, '0')}:${this.actor}`;
    }
    static parse(ts) {
      if (!ts || typeof ts !== 'string') return null;
      const p = ts.split(':');
      if (p.length < 3) return null;
      return { pt: +p[0], l: +p[1], actor: p.slice(2).join(':') };
    }
  }

  class Lattice {
    constructor() {
      this.state = new Map();
      this.events = new Map();
      this.order = [];
    }
    has(id) {
      return this.events.has(id);
    }
    apply(ev) {
      if (!ev || !ev.id || this.events.has(ev.id)) return false;
      this.events.set(ev.id, ev);
      this.order.push(ev.id);
      if (ev.op === 'batch' && Array.isArray(ev.value)) {
        for (const item of ev.value) {
          if (!item || !item.length) continue;
          this._op(item[0], item[1], item[2], ev.ts, ev.actor);
        }
      } else if (ev.op === 'set' || ev.op === 'del') {
        this._op(ev.op, ev.key, ev.value, ev.ts, ev.actor);
      }
      if (this.order.length > EVENT_CAP) this._gc();
      return true;
    }
    _op(op, key, value, ts, actor) {
      if (!key) return;
      const fww = key === '#genesis' || key.startsWith('~name/') || key.startsWith('~mail/');
      const cur = this.state.get(key);
      if (fww && cur && !cur.del) return;
      if (!cur || ts > cur.ts || (ts === cur.ts && actor > cur.actor)) {
        this.state.set(key, {
          value: op === 'del' ? undefined : value,
          ts,
          actor,
          del: op === 'del',
          owner: (cur && cur.owner) || actor
        });
      }
    }
    owner(key) {
      const c = this.state.get(key);
      return c ? c.owner : undefined;
    }
    get(key) {
      const c = this.state.get(key);
      if (!c || c.del) return undefined;
      return c.value;
    }
    scan(prefix) {
      const out = [];
      for (const [k, c] of this.state) {
        if (c.del) continue;
        if (!prefix || k.startsWith(prefix)) out.push([k, c.value, c.ts, c.actor, c.owner]);
      }
      out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return out;
    }
    merkle() {
      if (!this.order.length) return '∅';
      const ids = this.order.slice().sort();
      let h = 0;
      for (const id of ids) for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, '0') + ':' + this.order.length;
    }
    missing(ids) {
      const miss = [];
      for (const id of ids) if (!this.events.has(id)) miss.push(id);
      return miss;
    }
    dump(ids) {
      const out = [];
      for (const id of ids) {
        const e = this.events.get(id);
        if (e) out.push(e);
      }
      return out;
    }
    allIds() {
      return this.order.slice();
    }
    _gc() {
      const keep = new Set();
      for (const [k, c] of this.state) keep.add(k + '\0' + c.ts + '\0' + c.actor);
      const next = [];
      const nEv = new Map();
      for (const id of this.order) {
        const e = this.events.get(id);
        if (!e) continue;
        if (e.op === 'batch' || keep.has(e.key + '\0' + e.ts + '\0' + e.actor) || e.op === 'del') {
          next.push(id);
          nEv.set(id, e);
        }
      }
      if (next.length > EVENT_CAP) {
        const cut = next.length - EVENT_CAP;
        for (let i = 0; i < cut; i++) nEv.delete(next[i]);
        this.order = next.slice(cut);
      } else this.order = next;
      this.events = nEv;
    }
    snapshot() {
      const o = {};
      for (const [k, c] of this.state) if (!c.del) o[k] = c.value;
      return o;
    }
  }

  async function generateIdentity() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
    const jwkPub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const fp = (await sha256(raw)).slice(0, 16);
    return { id: fp, pub: hex(raw), jwkPub, jwkPriv };
  }
  async function importIdentity(rec) {
    const publicKey = await crypto.subtle.importKey('jwk', rec.jwkPub, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'verify'
    ]);
    const privateKey = await crypto.subtle.importKey('jwk', rec.jwkPriv, { name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign'
    ]);
    return { id: rec.id, pub: rec.pub, publicKey, privateKey, jwkPub: rec.jwkPub, jwkPriv: rec.jwkPriv };
  }
  async function signBytes(priv, msg) {
    return hex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, te.encode(msg)));
  }
  async function verifyBytes(pubHex, msg, sigHex) {
    try {
      const key = await crypto.subtle.importKey('raw', unhex(pubHex), { name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'verify'
      ]);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unhex(sigHex), te.encode(msg));
    } catch {
      return false;
    }
  }
  function bodyOf(ev) {
    return canonical({ op: ev.op, key: ev.key, value: ev.value, ts: ev.ts, actor: ev.actor, pub: ev.pub });
  }

  function idbOpen(name) {
    return new Promise((resolve, reject) => {
      const q = indexedDB.open(name, 1);
      q.onupgradeneeded = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
      };
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }
  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function mqttLen(n) {
    const b = [];
    do {
      let d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 0x80;
      b.push(d);
    } while (n > 0);
    return b;
  }
  function mqttStr(s) {
    const u = te.encode(s);
    const out = new Uint8Array(2 + u.length);
    out[0] = (u.length >> 8) & 0xff;
    out[1] = u.length & 0xff;
    out.set(u, 2);
    return out;
  }
  function concatU8(parts) {
    const n = parts.reduce((a, p) => a + p.length, 0);
    const u = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      u.set(p, o);
      o += p.length;
    }
    return u;
  }

  class MqttBus {
    constructor(url, log) {
      this.url = url;
      this.log = log;
      this.ws = null;
      this.alive = false;
      this.ping = null;
      this.cid = 'ae' + uid();
      this.handlers = new Map();
      this.pkt = 1;
    }
    connect() {
      return new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        try {
          this.ws = new WebSocket(this.url, 'mqtt');
        } catch (e) {
          this.log('mqtt fail ' + this.url);
          return done(false);
        }
        this.ws.binaryType = 'arraybuffer';
        const t = setTimeout(() => {
          try {
            this.ws.close();
          } catch {}
          done(false);
        }, 8000);
        this.ws.onopen = () => {
          const proto = mqttStr('MQTT');
          const hdr = new Uint8Array([4, 0x02, 0x00, 0x3c]);
          const cid = mqttStr(this.cid);
          const vh = concatU8([proto, hdr, cid]);
          this.ws.send(concatU8([new Uint8Array([0x10, ...mqttLen(vh.length)]), vh]));
        };
        this.ws.onmessage = (ev) => {
          const u = new Uint8Array(ev.data);
          if (!u.length) return;
          const type = u[0] >> 4;
          if (type === 2) {
            clearTimeout(t);
            this.alive = true;
            this.ping = setInterval(() => {
              if (this.ws && this.ws.readyState === 1) this.ws.send(new Uint8Array([0xc0, 0]));
            }, 40000);
            this.log('mqtt up ' + this.url.replace(/^wss:\/\//, ''));
            done(true);
          } else if (type === 3) this._pubin(u);
        };
        this.ws.onerror = () => {
          clearTimeout(t);
          done(false);
        };
        this.ws.onclose = () => {
          this.alive = false;
          clearInterval(this.ping);
        };
      });
    }
    subscribe(topic, fn) {
      this.handlers.set(topic, fn);
      if (!this.alive || !this.ws || this.ws.readyState !== 1) return;
      const id = new Uint8Array([(this.pkt >> 8) & 255, this.pkt & 255]);
      this.pkt = (this.pkt + 1) & 0xffff || 1;
      const t = mqttStr(topic);
      const vh = concatU8([id, t, new Uint8Array([0])]);
      this.ws.send(concatU8([new Uint8Array([0x82, ...mqttLen(vh.length)]), vh]));
    }
    publish(topic, obj, retain) {
      if (!this.alive || !this.ws || this.ws.readyState !== 1) return false;
      const t = mqttStr(topic);
      const payload = te.encode(JSON.stringify(obj));
      const vh = concatU8([t, payload]);
      this.ws.send(concatU8([new Uint8Array([retain ? 0x31 : 0x30, ...mqttLen(vh.length)]), vh]));
      return true;
    }
    _pubin(u) {
      let i = 1;
      while (i < u.length) {
        const d = u[i++];
        if ((d & 128) === 0) break;
      }
      const qos = (u[0] & 0x06) >> 1;
      const tlen = (u[i] << 8) | u[i + 1];
      i += 2;
      const topic = td.decode(u.slice(i, i + tlen));
      i += tlen;
      if (qos > 0) i += 2;
      try {
        const msg = JSON.parse(td.decode(u.slice(i)));
        const fn = this.handlers.get(topic);
        if (fn) fn(msg);
      } catch {}
    }
    close() {
      this.alive = false;
      clearInterval(this.ping);
      try {
        this.ws && this.ws.close();
      } catch {}
    }
  }

  function waitIce(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve(pc.localDescription);
    return new Promise((resolve) => {
      const done = () => resolve(pc.localDescription);
      const t = setTimeout(done, ms || 3500);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          done();
        }
      });
    });
  }

  class Query {
    constructor(db, prefix) {
      this.db = db;
      this.prefix = prefix;
      this._filters = [];
      this._order = null;
      this._lim = null;
    }
    where(field, op, value) {
      const q = this._clone();
      q._filters.push({ field, op, value });
      return q;
    }
    orderBy(field, dir) {
      const q = this._clone();
      q._order = { field, dir: dir || 'asc' };
      return q;
    }
    limit(n) {
      const q = this._clone();
      q._lim = n;
      return q;
    }
    _clone() {
      const q = new Query(this.db, this.prefix);
      q._filters = this._filters.slice();
      q._order = this._order;
      q._lim = this._lim;
      return q;
    }
    get() {
      return this._run();
    }
    on(fn) {
      fn(this._run());
      return this.db.watch(this.prefix, () => fn(this._run()));
    }
    _run() {
      let rows = this.db.scan(this.prefix).map(([k, v, ts, actor]) => ({
        id: k.slice(this.prefix.length),
        key: k,
        data: v,
        ts,
        actor
      }));
      for (const f of this._filters) rows = rows.filter((r) => cmp(r.data && r.data[f.field], f.op, f.value));
      if (this._order) {
        const { field, dir } = this._order;
        rows.sort((a, b) => {
          const x = a.data && a.data[field];
          const y = b.data && b.data[field];
          if (x < y) return dir === 'desc' ? 1 : -1;
          if (x > y) return dir === 'desc' ? -1 : 1;
          return 0;
        });
      }
      if (this._lim != null) rows = rows.slice(0, this._lim);
      return rows;
    }
  }

  class DocRef {
    constructor(db, path, id) {
      this.db = db;
      this.path = path;
      this.id = id;
    }
    async set(data) {
      await this.db.set(this.path, data);
      return this.id;
    }
    async update(patch) {
      const cur = this.db.get(this.path);
      const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
      await this.db.set(this.path, Object.assign({}, base, patch));
      return this.id;
    }
    get() {
      return this.db.get(this.path);
    }
    async delete() {
      await this.db.del(this.path);
    }
    on(fn) {
      fn(this.get());
      return this.db.watch(this.path, (_k, v) => fn(v));
    }
  }

  class Collection {
    constructor(db, name) {
      this.db = db;
      this.name = name;
      this.prefix = '@/' + name + '/';
    }
    doc(id) {
      return new DocRef(this.db, this.prefix + id, id);
    }
    async add(data) {
      const id = uid();
      await this.doc(id).set(data);
      return id;
    }
    where(field, op, value) {
      return new Query(this.db, this.prefix).where(field, op, value);
    }
    orderBy(field, dir) {
      return new Query(this.db, this.prefix).orderBy(field, dir);
    }
    limit(n) {
      return new Query(this.db, this.prefix).limit(n);
    }
    get() {
      return new Query(this.db, this.prefix).get();
    }
    on(fn) {
      return new Query(this.db, this.prefix).on(fn);
    }
  }

  class CQuery {
    constructor(db, table) {
      this.db = db;
      this.table = table;
      this._eq = {};
      this._order = '_creationTime';
      this._dir = 'asc';
      this._lim = null;
    }
    filter(obj) {
      this._eq = obj || {};
      return this;
    }
    order(field, dir) {
      if (field === 'asc' || field === 'desc') this._dir = field;
      else {
        this._order = field || '_creationTime';
        if (dir) this._dir = dir;
      }
      return this;
    }
    take(n) {
      this._lim = n;
      return this;
    }
    collect() {
      let rows = this.db.col(this.table).get();
      for (const k of Object.keys(this._eq))
        rows = rows.filter((r) => r.data && r.data[k] === this._eq[k]);
      const field = this._order;
      const dir = this._dir;
      rows.sort((a, b) => {
        const x = a.data && a.data[field];
        const y = b.data && b.data[field];
        if (x < y) return dir === 'desc' ? 1 : -1;
        if (x > y) return dir === 'desc' ? -1 : 1;
        if (a.ts < b.ts) return dir === 'desc' ? 1 : -1;
        if (a.ts > b.ts) return dir === 'desc' ? -1 : 1;
        return 0;
      });
      if (this._lim != null) rows = rows.slice(0, this._lim);
      return rows.map((r) => Object.assign({ _id: this.table + ':' + r.id }, r.data || {}));
    }
    first() {
      const rows = this.take(1).collect();
      return rows[0] || null;
    }
  }

  function splitId(id) {
    if (!id || typeof id !== 'string') return null;
    const i = id.indexOf(':');
    if (i < 1) return null;
    return { table: id.slice(0, i), id: id.slice(i + 1) };
  }

  class Replica {
    constructor(ns, opts) {
      this.ns = ns;
      this.opts = opts || {};
      this.lattice = new Lattice();
      this.watchers = new Set();
      this.statusWatch = new Set();
      this.peers = new Map();
      this.pcs = new Map();
      this.pendingOffers = new Map();
      this.seenSignal = new Set();
      this.actor = null;
      this.hlc = null;
      this.idb = null;
      this.nsHash = '';
      this.infoHashBin = '';
      this.peerIdBin = '';
      this.peerIdHex = '';
      this.trackers = [];
      this.mqtt = [];
      this.bc = null;
      this.closed = false;
      this.ready = false;
      this.stats = { events: 0, gossip: 0, tracker: 0, webrtc: 0, mqtt: 0, keep: 0, started: Date.now() };
      this.logLines = [];
      this._chunkBuf = new Map();
      this._announceTimer = null;
      this._presenceTimer = null;
      this._keepTimer = null;
      this._plain = new Map();
      this.aes = null;
      this.rules = this.opts.rules || { '*': { read: true, write: true } };
      this.sigTopic = '';
      this.keepTopic = '';
      this._fns = { q: {}, m: {} };
      this.account = null;
      this.meter = false;
      const self = this;
      this.files = {
        put: (x) => self._filePut(x),
        get: (h) => self._fileGet(h)
      };
      this.auth = {
        me: () => (self.actor ? { id: self.actor.id, pub: self.actor.pub } : null),
        name: () => {
          const r = self.get('~actor/' + (self.actor && self.actor.id));
          return r && r.name;
        },
        claim: (n) => self._claim(n),
        exportSeed: () =>
          JSON.stringify({
            id: self.actor.id,
            pub: self.actor.pub,
            jwkPub: self.actor.jwkPub,
            jwkPriv: self.actor.jwkPriv
          }),
        importSeed: (s) => self._importSeed(s),
        whois: (n) => self.get('~name/' + String(n).toLowerCase()),
        founder: () => {
          const g = self.get('#genesis');
          return g && g.founder;
        }
      };
    }

    log(msg) {
      const line = { t: Date.now(), msg: String(msg) };
      this.logLines.push(line);
      if (this.logLines.length > 200) this.logLines.shift();
      this._emitStatus('log', line);
    }
    _emitStatus(type, extra) {
      const snap = this.status();
      for (const fn of this.statusWatch) {
        try {
          fn(type, snap, extra);
        } catch {}
      }
    }
    status() {
      const live = [...this.peers.values()].filter((p) => p.open);
      return {
        version: VERSION,
        ns: this.ns,
        actor: this.actor && this.actor.id,
        peers: live.map((p) => ({ id: p.actor || p.trackerId, via: p.via, open: p.open })),
        peerCount: live.length,
        events: this.lattice.order.length,
        keys: [...this.lattice.state.values()].filter((c) => !c.del).length,
        merkle: this.lattice.merkle(),
        servers: 0,
        encrypted: !!this.aes,
        theorem: 'Ω = ⊔ replicas  (join-semilattice)',
        stats: Object.assign({}, this.stats),
        log: this.logLines.slice(-40)
      };
    }
    onStatus(fn) {
      this.statusWatch.add(fn);
      return () => this.statusWatch.delete(fn);
    }
    watch(prefix, fn) {
      const w = { prefix: prefix || '', fn };
      this.watchers.add(w);
      return () => this.watchers.delete(w);
    }

    async open() {
      this.nsHash = await sha256('aether:ns:' + this.ns);
      this.infoHashBin = binary20(unhex(this.nsHash.slice(0, 40)));
      const pid = randBytes(20);
      pid[0] = '-'.charCodeAt(0);
      pid[1] = 'A'.charCodeAt(0);
      pid[2] = 'E'.charCodeAt(0);
      pid[3] = '0'.charCodeAt(0);
      pid[4] = '1'.charCodeAt(0);
      pid[5] = '-'.charCodeAt(0);
      this.peerIdBin = binary20(pid);
      this.peerIdHex = hex(pid);
      this.sigTopic = 'aether/v1/' + this.nsHash.slice(0, 40) + '/sig';
      this.keepTopic = 'aether/v1/' + this.nsHash.slice(0, 40) + '/keep';

      if (this.opts.passphrase) {
        this.aes = await deriveAes(this.opts.passphrase, this.nsHash);
        this.log('passphrase cipher on');
      }

      if (this.opts.persist !== false && typeof indexedDB !== 'undefined') {
        try {
          this.idb = await idbOpen('aether:' + this.nsHash.slice(0, 24));
        } catch (e) {
          this.log('idb unavailable');
        }
      }
      if (this.idb) {
        const rec = await idbReq(this.idb.transaction('kv').objectStore('kv').get('identity'));
        if (rec && rec.jwkPriv) {
          try {
            this.actor = await importIdentity(rec);
          } catch {
            this.actor = null;
          }
        }
      }
      if (!this.actor) {
        const gen = await generateIdentity();
        this.actor = await importIdentity(gen);
        if (this.idb) {
          this.idb.transaction('kv', 'readwrite').objectStore('kv').put(
            { id: gen.id, pub: gen.pub, jwkPub: gen.jwkPub, jwkPriv: gen.jwkPriv },
            'identity'
          );
        }
      }
      this.hlc = new HLC(this.actor.id);
      this.log('identity ' + this.actor.id);

      if (this.idb) {
        const all = await idbReq(this.idb.transaction('events').objectStore('events').getAll());
        if (all && all.length) {
          all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
          for (const ev of all) await this._ingest(ev, true, true);
          this.log('rehydrated ' + all.length + ' events from this browser');
        }
      }

      this._bindBroadcast();
      if (this.opts.signal !== false) {
        this._bindTrackers(this.opts.trackers || DEFAULT_TRACKERS);
        this._bindMqtt(this.opts.mqtt || DEFAULT_MQTT);
      }
      this.ready = true;
      this.meter =
        this.opts.meter != null
          ? !!this.opts.meter
          : this.ns !== GATE_NS && this.ns !== GENESIS_NS;
      if (this.opts.ticket) this.bindAccount(this.opts.ticket);
      this._presenceTimer = setInterval(() => this._beat(), 12000);
      this._keepTimer = setInterval(() => this._publishKeep(), 40000);
      await this._beat();
      if (!this.get('#genesis')) {
        await this.set('#genesis', { founder: this.actor.id, at: Date.now(), v: VERSION });
      }
      if (this.meter && this.account && this.account.eh && !this.get('#lease')) {
        try {
          await this.set('#lease', {
            eh: this.account.eh,
            plan: this.account.plan,
            actor: this.actor.id,
            at: Date.now()
          });
        } catch (e) {}
      }
      const published = this.get('#rules');
      if (published && typeof published === 'object') this.rules = Object.assign({}, this.rules, published);
      this._emitStatus('open');
      return this;
    }

    _bindBroadcast() {
      if (typeof BroadcastChannel === 'undefined') return;
      try {
        this.bc = new BroadcastChannel('aether::' + this.nsHash.slice(0, 32));
        this.bc.onmessage = (e) => {
          const msg = e.data;
          if (!msg || msg.from === this.actor.id) return;
          this._onWire(msg, { via: 'broadcast', actor: msg.from, open: true, send: (m) => this._bcSend(m) });
        };
        this.peers.set('bc:' + this.actor.id, {
          id: 'local-tabs',
          via: 'broadcast',
          open: true,
          actor: 'tabs',
          send: (m) => this._bcSend(m)
        });
        this._bcSend({
          t: 'HELLO',
          from: this.actor.id,
          pub: this.actor.pub,
          have: this.lattice.allIds(),
          merkle: this.lattice.merkle()
        });
      } catch {}
    }
    _bcSend(msg) {
      if (!this.bc) return;
      try {
        this.bc.postMessage(Object.assign({}, msg, { from: this.actor.id }));
      } catch {}
    }

    _bindTrackers(urls) {
      for (const url of urls) this._tracker(url);
      this._announceTimer = setInterval(() => {
        for (const tr of this.trackers) this._announce(tr, false);
      }, 55000);
    }
    _tracker(url) {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }
      const tr = { url, ws, ready: false };
      this.trackers.push(tr);
      ws.onopen = () => {
        tr.ready = true;
        this.stats.tracker++;
        this.log('tracker ' + url.replace(/^wss:\/\//, ''));
        this._announce(tr, true);
        this._emitStatus('tracker');
      };
      ws.onmessage = (ev) => {
        let data = ev.data;
        if (data instanceof ArrayBuffer) data = td.decode(data);
        try {
          this._onTracker(tr, JSON.parse(data));
        } catch {}
      };
      ws.onclose = () => {
        tr.ready = false;
        if (this.closed) return;
        setTimeout(() => {
          if (this.closed) return;
          this.trackers = this.trackers.filter((t) => t !== tr);
          this._tracker(url);
        }, 4000 + Math.random() * 4000);
      };
      ws.onerror = () => {};
    }
    async _announce(tr, started) {
      if (!tr.ready || tr.ws.readyState !== 1) return;
      const live = [...this.peers.values()].filter((p) => p.open && p.via === 'webrtc').length;
      const want = Math.max(0, Math.min(8, MAX_PEERS - live));
      const offers = [];
      if (want > 0) {
        const n = started ? Math.min(5, want) : Math.min(2, want);
        for (let i = 0; i < n; i++) {
          try {
            const off = await this._makeOffer();
            if (off) offers.push({ offer_id: off.offerIdBin, offer: { type: 'offer', sdp: off.sdp } });
          } catch {}
        }
      }
      const payload = {
        action: 'announce',
        info_hash: this.infoHashBin,
        peer_id: this.peerIdBin,
        numwant: Math.max(1, want),
        uploaded: 0,
        downloaded: 0,
        left: 0
      };
      if (started) payload.event = 'started';
      if (offers.length) payload.offers = offers;
      try {
        tr.ws.send(JSON.stringify(payload));
      } catch {}
    }
    async _makeOffer() {
      if (this.pcs.size >= MAX_PEERS + 6) return null;
      const pc = new RTCPeerConnection(this.opts.rtcConfig || ICE);
      const offerId = randBytes(20);
      const offerIdBin = binary20(offerId);
      const offerIdHex = hex(offerId);
      const ch = pc.createDataChannel(CHAN, { ordered: true });
      this._setupPc(pc, ch, offerIdHex, null);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIce(pc);
      const sdp = pc.localDescription && pc.localDescription.sdp;
      if (!sdp) {
        pc.close();
        return null;
      }
      this.pendingOffers.set(offerIdHex, pc);
      this.pendingOffers.set(offerIdBin, pc);
      return { offerIdHex, offerIdBin, sdp, pc };
    }
    _setupPc(pc, ch, tag, trackerPeer) {
      const rec = {
        pc,
        ch: ch || null,
        open: false,
        via: 'webrtc',
        actor: null,
        trackerId: trackerPeer,
        send: (m) => this._dcSend(rec, m)
      };
      this.pcs.set(tag, rec);
      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'closed' ||
          pc.connectionState === 'disconnected'
        ) {
          this._dropPc(tag, rec);
        }
      };
      const attach = (channel) => {
        rec.ch = channel;
        channel.onopen = () => {
          rec.open = true;
          this.stats.webrtc++;
          this.log('webrtc open');
          this.peers.set(tag, rec);
          rec.send({
            t: 'HELLO',
            from: this.actor.id,
            pub: this.actor.pub,
            have: this.lattice.allIds(),
            merkle: this.lattice.merkle()
          });
          this._emitStatus('peer');
        };
        channel.onclose = () => this._dropPc(tag, rec);
        channel.onerror = () => {};
        channel.onmessage = (ev) => this._onDc(rec, ev.data);
      };
      if (ch) attach(ch);
      pc.ondatachannel = (e) => attach(e.channel);
    }
    _dropPc(tag, rec) {
      rec.open = false;
      this.peers.delete(tag);
      this.pcs.delete(tag);
      try {
        rec.pc && rec.pc.close();
      } catch {}
      this._emitStatus('peer');
    }
    _dcSend(rec, msg) {
      if (!rec.ch || rec.ch.readyState !== 'open') return;
      const s = JSON.stringify(msg);
      if (s.length <= CHUNK) {
        rec.ch.send(s);
        return;
      }
      const id = uid();
      const n = Math.ceil(s.length / CHUNK);
      for (let k = 0; k < n; k++)
        rec.ch.send(JSON.stringify({ t: '_chk', id, k, n, d: s.slice(k * CHUNK, (k + 1) * CHUNK) }));
    }
    _onDc(rec, data) {
      let msg;
      try {
        msg = typeof data === 'string' ? JSON.parse(data) : JSON.parse(td.decode(data));
      } catch {
        return;
      }
      if (msg.t === '_chk') {
        let b = this._chunkBuf.get(msg.id);
        if (!b) {
          b = { n: msg.n, p: [] };
          this._chunkBuf.set(msg.id, b);
        }
        b.p[msg.k] = msg.d;
        if (b.p.filter(Boolean).length === b.n) {
          this._chunkBuf.delete(msg.id);
          try {
            this._onWire(JSON.parse(b.p.join('')), rec);
          } catch {}
        }
        return;
      }
      this._onWire(msg, rec);
    }
    async _onTracker(tr, msg) {
      if (msg.info_hash && binToHex20(msg.info_hash) !== this.nsHash.slice(0, 40) && msg.info_hash !== this.infoHashBin)
        return;
      if (msg.offer && msg.offer_id != null && msg.peer_id) {
        if (msg.peer_id === this.peerIdBin) return;
        try {
          await this._acceptOffer(tr, msg);
        } catch {
          this.log('offer fail');
        }
      }
      if (msg.answer && msg.offer_id != null) {
        const pc = this.pendingOffers.get(msg.offer_id) || this.pendingOffers.get(binToHex20(msg.offer_id));
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        } catch {}
      }
    }
    async _acceptOffer(tr, msg) {
      if (this.pcs.size >= MAX_PEERS + 8) return;
      const pc = new RTCPeerConnection(this.opts.rtcConfig || ICE);
      const tag = 'ans-' + uid();
      this._setupPc(pc, null, tag, msg.peer_id);
      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIce(pc);
      const payload = {
        action: 'announce',
        info_hash: this.infoHashBin,
        peer_id: this.peerIdBin,
        to_peer_id: msg.peer_id,
        offer_id: msg.offer_id,
        answer: { type: 'answer', sdp: pc.localDescription.sdp }
      };
      if (tr.ws.readyState === 1) tr.ws.send(JSON.stringify(payload));
    }

    _bindMqtt(urls) {
      for (const url of urls) {
        const bus = new MqttBus(url, (s) => this.log(s));
        bus.connect().then((ok) => {
          if (!ok) return;
          this.mqtt.push(bus);
          this.stats.mqtt++;
          bus.subscribe(this.sigTopic, (msg) => this._onMqttSig(msg, bus));
          bus.subscribe(this.keepTopic, (msg) => this._onKeep(msg));
          this._mqttOffer(bus);
          this._publishKeep();
          this._emitStatus('mqtt');
        });
      }
    }
    async _mqttOffer(bus) {
      try {
        const off = await this._makeOffer();
        if (!off) return;
        bus.publish(this.sigTopic, {
          k: 'offer',
          from: this.peerIdHex,
          actor: this.actor.id,
          offer_id: off.offerIdHex,
          sdp: off.sdp
        });
      } catch {}
    }
    async _onMqttSig(msg, bus) {
      if (!msg || msg.from === this.peerIdHex) return;
      const sigId = msg.k + ':' + (msg.offer_id || '') + ':' + (msg.from || '');
      if (this.seenSignal.has(sigId)) return;
      this.seenSignal.add(sigId);
      if (this.seenSignal.size > 500) this.seenSignal.clear();
      if (msg.k === 'offer' && msg.sdp) {
        try {
          const pc = new RTCPeerConnection(this.opts.rtcConfig || ICE);
          const tag = 'mqtt-' + uid();
          this._setupPc(pc, null, tag, msg.from);
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitIce(pc);
          for (const m of this.mqtt)
            m.publish(this.sigTopic, {
              k: 'answer',
              from: this.peerIdHex,
              to: msg.from,
              offer_id: msg.offer_id,
              sdp: pc.localDescription.sdp
            });
        } catch {}
      }
      if (msg.k === 'answer' && msg.to === this.peerIdHex && msg.sdp) {
        const pc = this.pendingOffers.get(msg.offer_id);
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        } catch {}
      }
    }
    async _publishKeep() {
      if (!this.mqtt.length || this.closed) return;
      const merkle = this.lattice.merkle();
      if (merkle === this._keepMerkle) return;
      const events = [...this.lattice.events.values()];
      const raw = te.encode(JSON.stringify({ v: 1, ns: this.ns, merkle, events }));
      let body;
      try {
        body = { k: 'keep', from: this.actor.id, merkle, z: u8b64(await gzipU8(raw)) };
      } catch {
        body = { k: 'keep', from: this.actor.id, merkle, events };
      }
      const s = JSON.stringify(body);
      if (s.length > KEEP_MAX) {
        this.log('keeper skip (lattice too large for public retain)');
        return;
      }
      for (const m of this.mqtt) m.publish(this.keepTopic, body, true);
      this._keepMerkle = merkle;
      this.stats.keep++;
      this.log('keeper snapshot ' + merkle);
    }
    async _onKeep(msg) {
      if (!msg || msg.k !== 'keep') return;
      if (msg.from === this.actor.id) return;
      if (msg.merkle && msg.merkle === this.lattice.merkle()) return;
      let events = msg.events;
      if (!events && msg.z) {
        try {
          events = JSON.parse(td.decode(await gunzipU8(b64u8(msg.z)))).events;
        } catch {
          return;
        }
      }
      if (!events || !events.length) return;
      this.log('keeper hydrate ' + events.length);
      for (const ev of events) await this._ingest(ev, false);
      this._emitStatus('sync');
    }

    async _onWire(msg, rec) {
      if (!msg || !msg.t) return;
      if (msg.t === 'HELLO') {
        rec.actor = msg.from;
        rec.pub = msg.pub;
        this.stats.gossip++;
        const miss = this.lattice.missing(msg.have || []);
        const theyNeed = (this.lattice.allIds() || []).filter((id) => !(msg.have || []).includes(id));
        if (theyNeed.length) rec.send({ t: 'EVENTS', es: this.lattice.dump(theyNeed.slice(0, 500)) });
        if (miss.length) rec.send({ t: 'WANT', ids: miss.slice(0, 500) });
        this._emitStatus('peer');
        return;
      }
      if (msg.t === 'WANT') {
        rec.send({ t: 'EVENTS', es: this.lattice.dump(msg.ids || []) });
        return;
      }
      if (msg.t === 'EVENTS') {
        for (const ev of msg.es || []) await this._ingest(ev, false);
        this._emitStatus('sync');
        return;
      }
      if (msg.t === 'EVENT') {
        await this._ingest(msg.e, false);
        return;
      }
      if (msg.t === 'PING') rec.send({ t: 'PONG', n: msg.n });
    }

    _match(pat, key) {
      const keys = key.startsWith('@/') ? [key, key.slice(2)] : [key];
      for (const k of keys) {
        if (pat === k || pat === '*') return true;
        if (pat.endsWith('/*') && k.startsWith(pat.slice(0, -1))) return true;
        const a = pat.split('/');
        const b = k.split('/');
        if (a.length !== b.length) continue;
        let ok = true;
        for (let i = 0; i < a.length; i++) {
          if (a[i][0] === ':' || a[i] === '*') continue;
          if (a[i] !== b[i]) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
      return false;
    }
    _ruleFor(key) {
      const rules = Object.assign({}, this.rules, this.get('#rules') || {});
      let best = rules['*'] || { read: true, write: true };
      let bestLen = -1;
      for (const [pat, rule] of Object.entries(rules)) {
        if (pat === '*') continue;
        if (this._match(pat, key) && pat.length > bestLen) {
          best = rule;
          bestLen = pat.length;
        }
      }
      return best;
    }
    _adminActor(actor) {
      const cfg = this.get('~cfg/admin');
      return !!(cfg && cfg.actor === actor);
    }
    _canWrite(key, actor) {
      if (key.startsWith('#p/') || key.startsWith('#c/') || key.startsWith('#l/') || key.startsWith('#f/')) return true;
      if (key === '#genesis' || key.startsWith('~name/') || key.startsWith('~actor/')) return true;
      if (key.startsWith('~otp/') || key.startsWith('~sess/')) return true;
      if (key.startsWith('~mail/')) return true;
      if (key.startsWith('~acct/')) {
        const eh = key.slice(6);
        const mail = this.get('~mail/' + eh);
        if (mail && mail.actor === actor) return true;
        if (this._adminActor(actor)) return true;
        return !this.get(key);
      }
      if (key.startsWith('~inv/')) {
        if (!this.get(key)) return true;
        return this._adminActor(actor);
      }
      if (key.startsWith('~ban/') || key.startsWith('~cfg/') || key.startsWith('~ns/')) {
        if (key === '~cfg/admin' && !this.get(key)) return true;
        if (key.startsWith('~ns/') && !this.get(key)) return true;
        const cur = this.get(key);
        if (key.startsWith('~ns/') && cur && cur.actor === actor) return true;
        return this._adminActor(actor);
      }
      if (key === '#rules') {
        const g = this.get('#genesis');
        return !g || g.founder === actor;
      }
      const rule = this._ruleFor(key);
      const w = rule.write;
      if (w === false) return false;
      if (w === true || w == null) return true;
      if (w === 'auth') return !!actor;
      if (w === 'founder') {
        const g = this.get('#genesis');
        return g && g.founder === actor;
      }
      if (w === 'owner') {
        const own = this.lattice.owner(key);
        return !own || own === actor;
      }
      return true;
    }
    async _encrypt(v) {
      if (!this.aes) return v;
      const iv = randBytes(12);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.aes, te.encode(JSON.stringify(v)));
      return { _enc: true, iv: hex(iv), ct: hex(ct) };
    }
    async _decrypt(v) {
      if (!v || !v._enc) return v;
      if (!this.aes) return v;
      try {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(v.iv) }, this.aes, unhex(v.ct));
        return JSON.parse(td.decode(pt));
      } catch {
        return v;
      }
    }
    async _cachePlain(key) {
      const raw = this.lattice.get(key);
      if (raw === undefined) this._plain.delete(key);
      else this._plain.set(key, await this._decrypt(raw));
    }

    async _ingest(ev, local, fromStore) {
      if (!ev || !ev.id) return false;
      if (this.lattice.has(ev.id)) return false;
      if (!local && !fromStore) {
        if (!ev.sig || !ev.pub || !ev.actor) return false;
        const ok = await verifyBytes(ev.pub, bodyOf(ev), ev.sig);
        if (!ok) {
          this.log('drop unsigned/forged event');
          return false;
        }
        const keys = ev.op === 'batch' && Array.isArray(ev.value) ? ev.value.map((x) => x[1]) : [ev.key];
        for (const k of keys) {
          if (k && !this._canWrite(k, ev.actor)) {
            this.log('drop rule-denied ' + k);
            return false;
          }
        }
      }
      if (ev.ts) this.hlc.observe(ev.ts);
      const applied = this.lattice.apply(ev);
      if (!applied) return false;
      this.stats.events = this.lattice.order.length;
      if (ev.op === 'batch' && Array.isArray(ev.value)) {
        for (const item of ev.value) if (item && item[1]) await this._cachePlain(item[1]);
      } else if (ev.key) await this._cachePlain(ev.key);
      if (ev.key === '#rules') {
        const r = this.get('#rules');
        if (r && typeof r === 'object') this.rules = Object.assign({}, this.rules, r);
      }
      if (this.idb && !fromStore) {
        try {
          this.idb.transaction('events', 'readwrite').objectStore('events').put(ev);
        } catch {}
      }
      for (const w of this.watchers) {
        const keys = ev.op === 'batch' && Array.isArray(ev.value) ? ev.value.map((x) => x[1]) : [ev.key];
        for (const k of keys) {
          if (!w.prefix || (k && k.startsWith(w.prefix))) {
            try {
              w.fn(k, ev.op === 'del' ? undefined : this.get(k), ev);
            } catch {}
          }
        }
      }
      this._emitStatus('change', ev);
      return true;
    }
    _gossip(ev) {
      const msg = { t: 'EVENT', e: ev, from: this.actor.id };
      this._bcSend(msg);
      for (const rec of this.peers.values()) if (rec.via === 'webrtc' && rec.open) rec.send(msg);
    }

    _plan() {
      if (!this.meter) return PLANS.void;
      const t = this.account;
      if (t && (t.role === 'admin' || t.plan === 'void')) return PLANS.void;
      if (t && t.plan && PLANS[t.plan]) return PLANS[t.plan];
      return PLANS.anon;
    }
    bindAccount(ticket) {
      this.account = ticket || null;
      if (ticket)
        this.log(
          'account ' + (ticket.plan || 'anon') + (ticket.role === 'admin' ? ' · admin void' : '')
        );
      return this;
    }
    meteredKeys() {
      let n = 0;
      for (const [k, c] of this.lattice.state) {
        if (c.del) continue;
        if (k.startsWith('#p/') || k.startsWith('#c/')) continue;
        n++;
      }
      return n;
    }
    writesToday() {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const t0 = start.getTime();
      const me = this.actor && this.actor.id;
      let n = 0;
      for (const id of this.lattice.order) {
        const e = this.lattice.events.get(id);
        if (!e || e.actor !== me) continue;
        const o = HLC.parse(e.ts);
        if (o && o.pt >= t0) n++;
      }
      return n;
    }
    checkQuota(op, key) {
      if (!this.meter) return;
      const t = this.account;
      if (t && t.banned) throw new Error('account banned');
      const plan = this._plan();
      if (plan.writes === Infinity && plan.keys === Infinity) return;
      const k = String(key || '');
      if (k.startsWith('#p/') || k.startsWith('#c/') || k === '#genesis' || k === '#lease') return;
      if (this.writesToday() >= plan.writes)
        throw new Error(
          'Æther limit: ' +
            (t && t.plan ? t.plan : 'anon') +
            ' allows ' +
            plan.writes +
            ' writes/day. Pay for more: #/account'
        );
      if ((op === 'set' || op === 'batch') && this.meteredKeys() >= plan.keys)
        throw new Error(
          'Æther limit: ' +
            (t && t.plan ? t.plan : 'anon') +
            ' allows ' +
            plan.keys +
            ' keys. Pay for more: #/account'
        );
    }
    async mutate(op, key, value) {
      if (!this.ready && op !== 'set') {
        /* genesis during open */
      }
      this.checkQuota(op, key);
      if (key && !this._canWrite(String(key), this.actor.id)) throw new Error('write denied by rules: ' + key);
      if (op === 'batch' && Array.isArray(value)) {
        for (const item of value) {
          if (item[1] && !this._canWrite(String(item[1]), this.actor.id))
            throw new Error('write denied by rules: ' + item[1]);
        }
        const next = [];
        for (const item of value) {
          if (item[0] === 'set' && this.aes) next.push(['set', item[1], await this._encrypt(item[2])]);
          else next.push(item);
        }
        value = next;
      } else if (op === 'set' && this.aes) value = await this._encrypt(value);
      const ts = this.hlc.stamp();
      const ev = {
        op,
        key: String(key),
        value: op === 'del' ? null : value,
        ts,
        actor: this.actor.id,
        pub: this.actor.pub
      };
      ev.id = await sha256(bodyOf(ev));
      ev.sig = await signBytes(this.actor.privateKey, bodyOf(ev));
      await this._ingest(ev, true);
      this._gossip(ev);
      return ev;
    }
    async set(key, value) {
      await this.mutate('set', key, value);
      return value;
    }
    async update(key, patch) {
      const cur = this.get(key);
      const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
      return this.set(key, Object.assign({}, base, patch));
    }
    async del(key) {
      await this.mutate('del', key);
    }
    get(key) {
      if (this._plain.has(key)) return this._plain.get(key);
      return this.lattice.get(key);
    }
    has(key) {
      return this.get(key) !== undefined;
    }
    keys(prefix) {
      return this.scan(prefix).map((x) => x[0]);
    }
    scan(prefix) {
      return this.lattice.scan(prefix).map(([k, v, ts, actor, owner]) => [
        k,
        this._plain.has(k) ? this._plain.get(k) : v,
        ts,
        actor,
        owner
      ]);
    }
    all() {
      const o = {};
      for (const [k] of this.scan()) o[k] = this.get(k);
      return o;
    }
    async inc(key, n) {
      const n0 = typeof n === 'number' ? n : 1;
      const ck = '#c/' + key + '/' + this.actor.id;
      const cur = Number(this.get(ck) || 0);
      await this.set(ck, cur + n0);
      return this.count(key);
    }
    count(key) {
      let s = 0;
      for (const [, v] of this.scan('#c/' + key + '/')) s += Number(v) || 0;
      return s;
    }
    async append(key, value) {
      const k = '#l/' + key + '/' + Date.now().toString(36) + '-' + uid();
      await this.set(k, value);
      return k;
    }
    tail(key, n) {
      const rows = this.scan('#l/' + key + '/');
      const m = n == null ? rows.length : n;
      return rows.slice(-m).map(([k, v, ts, actor]) => ({ key: k, value: v, ts, actor }));
    }
    col(name) {
      return new Collection(this, name);
    }
    table(name) {
      return this.col(name);
    }
    query(prefixOrTable) {
      if (prefixOrTable && prefixOrTable.indexOf('/') === -1 && prefixOrTable.charAt(0) !== '@' && prefixOrTable.charAt(0) !== '#')
        return new CQuery(this, prefixOrTable);
      return new Query(this, prefixOrTable || '');
    }
    q(table) {
      return new CQuery(this, table);
    }
    ctx() {
      const self = this;
      return {
        db: {
          insert: (t, d) => self.insert(t, d),
          get: (id) => self.docGet(id),
          patch: (id, p) => self.docPatch(id, p),
          replace: (id, d) => self.docReplace(id, d),
          delete: (id) => self.docDelete(id),
          query: (t) => self.q(t)
        },
        auth: self.auth.me(),
        account: self.account,
        now: () => Date.now()
      };
    }
    async insert(table, data) {
      const id = uid();
      const doc = Object.assign({}, data, {
        _id: table + ':' + id,
        _creationTime: Date.now(),
        _author: this.actor && this.actor.id
      });
      await this.col(table).doc(id).set(doc);
      return doc._id;
    }
    docGet(id) {
      const p = splitId(id);
      if (!p) return null;
      return this.col(p.table).doc(p.id).get() || null;
    }
    async docPatch(id, patch) {
      const p = splitId(id);
      if (!p) throw new Error('bad id');
      await this.col(p.table).doc(p.id).update(patch);
      return id;
    }
    async docReplace(id, data) {
      const p = splitId(id);
      if (!p) throw new Error('bad id');
      const prev = this.col(p.table).doc(p.id).get() || {};
      await this.col(p.table)
        .doc(p.id)
        .set(Object.assign({}, data, { _id: id, _creationTime: prev._creationTime || Date.now() }));
      return id;
    }
    async docDelete(id) {
      const p = splitId(id);
      if (!p) throw new Error('bad id');
      await this.col(p.table).doc(p.id).delete();
    }
    define(mods) {
      if (!this._fns) this._fns = { q: {}, m: {} };
      for (const mod of Object.keys(mods || {})) {
        const spec = mods[mod];
        for (const name of Object.keys(spec || {})) {
          const fn = spec[name];
          const key = mod + '.' + name;
          const kind = fn && fn._aeKind;
          const isMut =
            kind === 'mutation' ||
            (kind !== 'query' && fn && fn.constructor && fn.constructor.name === 'AsyncFunction');
          if (isMut) this._fns.m[key] = fn;
          else this._fns.q[key] = fn;
        }
      }
      return this;
    }
    live(name, args, cb) {
      if (typeof args === 'function') {
        cb = args;
        args = {};
      }
      if (!this._fns) this._fns = { q: {}, m: {} };
      const q = this._fns.q[name];
      if (!q) throw new Error('unknown query ' + name);
      const fire = () => {
        try {
          const r = q(this.ctx(), args || {});
          if (r && typeof r.then === 'function')
            r.then(cb, function (e) {
              console.error(e);
            });
          else cb(r);
        } catch (e) {
          console.error(e);
        }
      };
      fire();
      return this.watch('@/', fire);
    }
    async run(name, args) {
      const m = this._fns.m[name];
      if (!m) throw new Error('unknown mutation ' + name);
      return await m(this.ctx(), args || {});
    }
    async batch(ops) {
      return this.mutate('batch', '#batch/' + uid(), ops);
    }
    async protect(rules) {
      await this.set('#rules', rules);
      this.rules = Object.assign({}, this.rules, rules);
      return rules;
    }
    async _claim(name) {
      const n = String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_\-.]/g, '')
        .slice(0, 32);
      if (!n) throw new Error('bad name');
      const k = '~name/' + n;
      const cur = this.get(k);
      if (cur && cur.id !== this.actor.id) throw new Error('name taken');
      await this.set(k, { id: this.actor.id, pub: this.actor.pub });
      await this.set('~actor/' + this.actor.id, { name: n });
      return n;
    }
    async _importSeed(s) {
      const rec = typeof s === 'string' ? JSON.parse(s) : s;
      this.actor = await importIdentity(rec);
      this.hlc = new HLC(this.actor.id);
      if (this.idb)
        this.idb.transaction('kv', 'readwrite').objectStore('kv').put(
          { id: rec.id, pub: rec.pub, jwkPub: rec.jwkPub, jwkPriv: rec.jwkPriv },
          'identity'
        );
      this.log('imported identity ' + this.actor.id);
      return this.actor.id;
    }
    async _filePut(input) {
      let buf;
      let type = 'application/octet-stream';
      let name = 'blob';
      if (typeof Blob !== 'undefined' && input instanceof Blob) {
        buf = new Uint8Array(await input.arrayBuffer());
        type = input.type || type;
        name = input.name || name;
      } else if (typeof input === 'string') {
        buf = te.encode(input);
        type = 'text/plain';
      } else {
        buf = te.encode(JSON.stringify(input));
        type = 'application/json';
      }
      const cap = this.meter ? this._plan().files : 2000000;
      if (buf.length > cap) throw new Error('file too large for this plan (' + cap + ' bytes)');
      const hash = await sha256(buf);
      const size = 8000;
      const n = Math.ceil(buf.length / size) || 1;
      const ops = [['set', '#f/' + hash + '/_', { n, type, size: buf.length, name }]];
      for (let i = 0; i < n; i++) ops.push(['set', '#f/' + hash + '/' + i, u8b64(buf.subarray(i * size, (i + 1) * size))]);
      await this.batch(ops);
      return hash;
    }
    async _fileGet(hash) {
      const meta = this.get('#f/' + hash + '/_');
      if (!meta) return null;
      const parts = [];
      for (let i = 0; i < meta.n; i++) {
        const b64 = this.get('#f/' + hash + '/' + i);
        if (b64 == null) return null;
        parts.push(b64u8(b64));
      }
      const u = concatU8(parts);
      if (typeof Blob === 'undefined') return { bytes: u, type: meta.type, name: meta.name };
      const blob = new Blob([u], { type: meta.type });
      blob.name = meta.name;
      return blob;
    }
    exportCapsule() {
      return {
        v: 1,
        ns: this.ns,
        merkle: this.lattice.merkle(),
        events: [...this.lattice.events.values()]
      };
    }
    async importCapsule(c) {
      const cap = typeof c === 'string' ? JSON.parse(c) : c;
      if (!cap || !cap.events) throw new Error('bad capsule');
      let n = 0;
      for (const ev of cap.events) if (await this._ingest(ev, false)) n++;
      this._gossip && this._emitStatus('sync');
      this.log('capsule ingested ' + n);
      return n;
    }
    waitSync(ms) {
      const timeout = ms == null ? 5000 : ms;
      const start = this.lattice.merkle();
      return new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          const m = this.lattice.merkle();
          const peers = this.presence().length;
          if ((m !== start && Date.now() - t0 > 800) || Date.now() - t0 > timeout || peers > 1) {
            clearInterval(iv);
            resolve(this.status());
          }
        }, 250);
      });
    }
    async _beat() {
      if (this.closed || !this.actor) return;
      await this.set('#p/' + this.actor.id, {
        at: Date.now(),
        origin: typeof location !== 'undefined' ? location.host : '',
        v: VERSION
      });
    }
    presence(ms) {
      const windowMs = ms || 35000;
      const now = Date.now();
      const out = [];
      for (const [k, v] of this.scan('#p/')) {
        if (v && typeof v.at === 'number' && now - v.at < windowMs)
          out.push({ actor: k.slice(3), at: v.at, origin: v.origin });
      }
      return out;
    }
    async close() {
      this.closed = true;
      clearInterval(this._announceTimer);
      clearInterval(this._presenceTimer);
      clearInterval(this._keepTimer);
      try {
        this.bc && this.bc.close();
      } catch {}
      for (const tr of this.trackers) {
        try {
          tr.ws.close();
        } catch {}
      }
      for (const m of this.mqtt) m.close();
      for (const rec of this.pcs.values()) {
        try {
          rec.pc.close();
        } catch {}
      }
    }
  }

  function cloneLat(src) {
    const L = new Lattice();
    for (const ev of src.events.values()) L.apply(JSON.parse(JSON.stringify(ev)));
    return L;
  }
  function mergeLat(a, b) {
    const L = cloneLat(a);
    for (const ev of b.events.values()) L.apply(ev);
    return L;
  }
  function snapEq(a, b) {
    return canonical(a.snapshot()) === canonical(b.snapshot());
  }
  function theorem() {
    const e = (id, key, value, ts, actor) => ({
      id,
      op: 'set',
      key,
      value,
      ts,
      actor,
      pub: actor,
      sig: 'local'
    });
    const A = new Lattice();
    const B = new Lattice();
    const C = new Lattice();
    A.apply(e('1', 'x', 1, '000000000000001:000000:a', 'a'));
    B.apply(e('2', 'x', 7, '000000000000002:000000:b', 'b'));
    C.apply(e('3', 'y', 'q', '000000000000003:000000:c', 'c'));
    A.apply(e('4', 'y', 'p', '000000000000001:000001:a', 'a'));
    const AB = mergeLat(A, B);
    const BA = mergeLat(B, A);
    const commutative = snapEq(AB, BA);
    const ABC = mergeLat(AB, C);
    const A_BC = mergeLat(A, mergeLat(B, C));
    const associative = snapEq(ABC, A_BC);
    const idempotent = snapEq(mergeLat(A, A), A);
    return {
      commutative,
      associative,
      idempotent,
      holds: commutative && associative && idempotent,
      lub: ABC.snapshot(),
      note: 'LWW-Map is a join-semilattice on (timestamp, actor). Ω = ⊔ replicas.'
    };
  }

  async function open(ns, opts) {
    if (!ns || typeof ns !== 'string') throw new Error('Aether.open(namespace) requires a string capability');
    const r = new Replica(ns, opts || {});
    await r.open();
    return r;
  }

  function parseLink(s) {
    if (!s) return { ns: '', passphrase: '' };
    s = String(s).trim();
    if (/^aether:\/\//i.test(s)) s = s.replace(/^aether:\/\//i, '');
    let passphrase = '';
    const hash = s.indexOf('#');
    if (hash !== -1) {
      passphrase = decodeURIComponent(s.slice(hash + 1));
      s = s.slice(0, hash);
    }
    const q = s.indexOf('?');
    if (q !== -1) {
      const qs = new URLSearchParams(s.slice(q + 1));
      passphrase = passphrase || qs.get('p') || qs.get('pass') || qs.get('passphrase') || '';
      s = s.slice(0, q);
    }
    return { ns: decodeURIComponent(s), passphrase };
  }

  function secret() {
    const h = hex(randBytes(16));
    return 'ae-' + h.slice(0, 8) + '-' + h.slice(8, 16) + '-' + h.slice(16, 24) + '-' + h.slice(24);
  }

  function link(ns, passphrase) {
    let s = 'aether://' + encodeURIComponent(ns);
    if (passphrase) s += '#' + encodeURIComponent(passphrase);
    return s;
  }

  function snippet(scriptSrc, ns, opts) {
    opts = opts || {};
    const as = opts.as || 'db';
    const pass = opts.passphrase || '';
    let tag = '<script src="' + scriptSrc + '" data-aether="' + ns + '"';
    if (pass) tag += ' data-pass="' + pass + '"';
    if (as !== 'db') tag += ' data-as="' + as + '"';
    tag += '></script>';
    return tag;
  }

  function page(scriptSrc, ns, opts) {
    opts = opts || {};
    const title = opts.title || 'Æther room';
    const safeNs = escapeHtml(ns);
    return (
      '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      '<title>' +
      escapeHtml(title) +
      '</title><style>' +
      'html,body{margin:0;background:#090a07;color:#f1e6d0;font:18px/1.45 Georgia,serif}' +
      'main{max-width:720px;margin:0 auto;padding:28px 18px 90px}' +
      'h1{font:800 42px/1 Arial,sans-serif;letter-spacing:-.04em;margin:8px 0 18px}' +
      '.meta{font:12px ui-monospace,monospace;color:#8e9486;letter-spacing:.14em;text-transform:uppercase}' +
      '#log{min-height:42vh}article{border-top:1px solid #222;padding:10px 0}' +
      '.who{font:12px ui-monospace,monospace;color:#ddf35a}' +
      'form{display:flex;gap:8px;position:sticky;bottom:0;padding:12px 0;background:#090a07}' +
      'input{flex:1;background:transparent;border:1px solid #333;color:#f1e6d0;padding:12px;font:inherit}' +
      'button{background:#ddf35a;border:0;padding:12px 16px;font-weight:800;cursor:pointer}' +
      '</style></head><body><main>' +
      '<p class="meta">Æther · 0 servers · ' +
      safeNs +
      '</p><h1>the room is the backend</h1><div id="log"></div>' +
      '<form id="f"><input name="body" maxlength="400" placeholder="into the mesh…" autocomplete="off"/><button>send</button></form>' +
      '</main>' +
      snippet(scriptSrc, ns, opts) +
      '\n<script>\n' +
      'Aether.define({messages:{' +
      'list:Aether.query(function(ctx){return ctx.db.query("messages").order("_creationTime").collect();}),' +
      'send:Aether.mutation(async function(ctx,a){var t=String(a.body||"").trim();if(!t)return;' +
      'await ctx.db.insert("messages",{body:t.slice(0,400),author:((ctx.auth&&ctx.auth.id)||"anon").slice(0,8)});})' +
      '}});\n' +
      "document.addEventListener('aether-ready',function(e){" +
      'var db=e.detail;db.live("messages.list",function(rows){var el=document.getElementById("log");el.innerHTML="";' +
      '(rows||[]).forEach(function(r){var a=document.createElement("article");var w=document.createElement("div");' +
      'w.className="who";w.textContent=r.author||"anon";var b=document.createElement("div");b.textContent=r.body||"";' +
      'a.appendChild(w);a.appendChild(b);el.appendChild(a);});' +
      'if(!rows||!rows.length){var p=document.createElement("p");p.className="meta";p.textContent="empty. the first write creates the room.";el.appendChild(p);}' +
      '});document.getElementById("f").onsubmit=function(ev){ev.preventDefault();var v=this.body.value;this.body.value="";db.run("messages.send",{body:v});};' +
      '});\n</script>\n</body></html>\n'
    );
  }

  function loadTicket() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const t = JSON.parse(localStorage.getItem(TICKET_KEY) || 'null');
      if (!t || (t.exp && t.exp < Date.now())) return null;
      return t;
    } catch {
      return null;
    }
  }
  function saveTicket(t) {
    api.ticket = t || null;
    if (typeof localStorage === 'undefined') return;
    try {
      if (!t) localStorage.removeItem(TICKET_KEY);
      else localStorage.setItem(TICKET_KEY, JSON.stringify(t));
    } catch {}
  }
  function loadPending() {
    try {
      if (typeof sessionStorage === 'undefined') return null;
      const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
      if (!p || (p.at && Date.now() - p.at > 20 * 60 * 1000)) return null;
      return p;
    } catch {
      return null;
    }
  }
  function savePending(p) {
    try {
      if (typeof sessionStorage === 'undefined') return;
      if (!p) sessionStorage.removeItem(PENDING_KEY);
      else sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
    } catch {}
  }
  function magicUrl(nonce, eh) {
    if (typeof location === 'undefined') return '';
    const base = location.origin + (location.pathname || '/');
    return (
      base.replace(/index\.html$/i, '') +
      '?otp=' +
      encodeURIComponent(nonce) +
      '&eh=' +
      encodeURIComponent(eh) +
      '#/in'
    );
  }
  function shareUrl(ns, passphrase) {
    if (typeof location === 'undefined') return link(ns, passphrase);
    let u = location.origin + '/#/room?ns=' + encodeURIComponent(ns);
    if (passphrase) u += '&p=' + encodeURIComponent(passphrase);
    return u;
  }
  function kit(ns, opts) {
    opts = opts || {};
    const src =
      opts.src ||
      (typeof location !== 'undefined' ? location.origin.replace(/\/$/, '') + '/aether.js' : './aether.js');
    const pass = opts.passphrase || '';
    const passArg = pass ? ', { passphrase: ' + JSON.stringify(pass) + ' }' : '';
    const tag = snippet(src, ns, opts);
    const js =
      '<script src="' +
      src +
      '"></script>\n<script>\n' +
      'Aether.define({\n' +
      '  messages: {\n' +
      "    list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),\n" +
      '    send: Aether.mutation(async (ctx, { body }) => {\n' +
      "      await ctx.db.insert('messages', { body, author: (ctx.auth && ctx.auth.id || 'anon').slice(0, 8) });\n" +
      '    })\n' +
      '  }\n' +
      '});\n' +
      'Aether.hitch(' +
      JSON.stringify(ns) +
      passArg +
      ').then(db => {\n' +
      "  db.live('messages.list', console.log);\n" +
      '});\n' +
      '</script>';
    const vite =
      "import Aether from './aether.js'\n" +
      "import { AetherProvider, useQuery, useMutation } from './react.js'\n\n" +
      'Aether.define({\n' +
      '  messages: {\n' +
      "    list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),\n" +
      "    send: Aether.mutation(async (ctx, { body }) => ctx.db.insert('messages', { body }))\n" +
      '  }\n' +
      '})\n\n' +
      'await Aether.hitch(' +
      JSON.stringify(ns) +
      passArg +
      ')\n';
    const react =
      "import Aether from './aether.js'\n" +
      "import { AetherProvider, useQuery, useMutation } from './react.js'\n\n" +
      'Aether.define({\n' +
      '  messages: {\n' +
      "    list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),\n" +
      "    send: Aether.mutation(async (ctx, { body }) => ctx.db.insert('messages', { body }))\n" +
      '  }\n' +
      '})\n\n' +
      'function Room() {\n' +
      "  const rows = useQuery('messages.list')\n" +
      "  const send = useMutation('messages.send')\n" +
      '  return /* your UI */\n' +
      '}\n\n' +
      '<AetherProvider ns={' +
      JSON.stringify(ns) +
      '}><Room /></AetherProvider>\n';
    return {
      ns: ns,
      src: src,
      link: link(ns, pass),
      share: shareUrl(ns, pass),
      tag: tag,
      page: page(src, ns, opts),
      js: js,
      vite: vite,
      react: react,
      node: 'node node.js keep ' + ns + ' ./capsule.json',
      html: tag
    };
  }
  function normEmail(e) {
    return String(e || '')
      .trim()
      .toLowerCase();
  }
  async function hashEmail(e) {
    return (await sha256('aether:mail:' + normEmail(e))).slice(0, 32);
  }
  async function founderEh() {
    return hashEmail(FOUNDER_EMAIL);
  }
  let gateReady = null;
  function openGate(opts) {
    if (api.gate && !api.gate.closed) return Promise.resolve(api.gate);
    if (gateReady) return gateReady;
    gateReady = open(GATE_NS, Object.assign({ meter: false }, opts || {})).then(function (db) {
      api.gate = db;
      return db;
    });
    return gateReady;
  }
  async function sendMagicMail(email, url, code) {
    const message =
      'Someone (hopefully you) asked to enter Æther. There is no password.\n\nOpen this link:\n' +
      url +
      '\n\nOr type this code on the site (Email in):\n' +
      code +
      '\n\nExpires in 20 minutes. If this was not you, ignore the letter.';
    try {
      const r = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(email), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: 'Æther login — no password exists',
          _template: 'box',
          _captcha: 'false',
          name: 'Æther',
          message: message
        })
      });
      const raw = await r.text();
      let ok = r.ok;
      try {
        const j = JSON.parse(raw);
        if (j.success === 'false' || j.success === false) ok = false;
      } catch {}
      return { hop: 'formsubmit', ok: ok, status: r.status, raw: raw };
    } catch (e) {
      return { hop: 'formsubmit', ok: false, error: String(e.message || e) };
    }
  }
  async function sendLogin(email) {
    email = normEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('that is not an email');
    const eh = await hashEmail(email);
    const gate = await openGate();
    const nonce = hex(randBytes(16));
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const codeHash = await sha256(code);
    await gate.set('~otp/' + nonce, { eh: eh, codeHash: codeHash, exp: Date.now() + 20 * 60 * 1000, at: Date.now() });
    const url = magicUrl(nonce, eh);
    const mailto =
      'mailto:' +
      email +
      '?subject=' +
      encodeURIComponent('Your Æther login (no password)') +
      '&body=' +
      encodeURIComponent('Open this to enter Æther:\n\n' + url + '\n\nOr type this code: ' + code + '\n');
    const mailed = await sendMagicMail(email, url, code);
    const pending = {
      email: email,
      eh: eh,
      nonce: nonce,
      code: code,
      url: url,
      mailto: mailto,
      mailed: mailed,
      at: Date.now()
    };
    savePending(pending);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('aether.lastEmail', email);
    } catch {}
    return pending;
  }

  async function findOtp(gate, otp, code) {
    const codeHash = code ? await sha256(String(code).trim()) : null;
    if (otp) {
      const rec = gate.get('~otp/' + otp);
      if (rec) return { otp: otp, rec: rec };
    }
    if (codeHash) {
      for (const row of gate.scan('~otp/')) {
        const rec = row[1];
        if (rec && rec.codeHash === codeHash && rec.exp > Date.now())
          return { otp: String(row[0]).slice(5), rec: rec };
      }
    }
    return null;
  }
  async function waitForOtp(gate, otp, code, ms) {
    const until = Date.now() + (ms == null ? 6000 : ms);
    let hit = await findOtp(gate, otp, code);
    if (hit) return hit;
    try {
      await gate.waitSync(Math.min(4000, Math.max(600, until - Date.now())));
    } catch (e) {}
    hit = await findOtp(gate, otp, code);
    if (hit) return hit;
    return await new Promise(function (resolve, reject) {
      const un = gate.watch('~otp/', async function () {
        const h = await findOtp(gate, otp, code);
        if (h) {
          un();
          clearTimeout(t);
          resolve(h);
        }
      });
      const t = setTimeout(function () {
        un();
        reject(new Error('unknown or spent link — the gate lattice may still be warming. send again, or wait and type the code'));
      }, Math.max(400, until - Date.now()));
    });
  }
  async function proveLogin(opts) {
    opts = opts || {};
    const pending = loadPending() || {};
    if (!opts.otp) opts.otp = pending.nonce;
    if (!opts.eh) opts.eh = pending.eh;
    if (!opts.email) opts.email = pending.email;
    const gate = await openGate();
    const hit = await waitForOtp(gate, opts.otp, opts.code, 7000);
    opts.otp = hit.otp;
    const rec = hit.rec;
    if (!rec) throw new Error('unknown or spent link');
    if (rec.exp < Date.now()) throw new Error('link expired — ask for a new letter');
    const email = opts.email ? normEmail(opts.email) : '';
    const eh = opts.eh || rec.eh || (email ? await hashEmail(email) : '');
    if (!eh || rec.eh !== eh) throw new Error('email mismatch');
    if (opts.code) {
      const ch = await sha256(String(opts.code).trim());
      if (ch !== rec.codeHash) throw new Error('bad code');
    }
    const mailKey = '~mail/' + eh;
    if (!gate.get(mailKey)) {
      await gate.set(mailKey, { eh: eh, actor: gate.actor.id, pub: gate.actor.pub, at: Date.now() });
    }
    await gate.set('~sess/' + gate.actor.id, { eh: eh, at: Date.now() });
    const isFounder = eh === (await founderEh());
    let acct = gate.get('~acct/' + eh);
    if (!acct) {
      acct = {
        eh: eh,
        plan: isFounder ? 'void' : 'spark',
        role: isFounder ? 'admin' : 'user',
        at: Date.now(),
        actor: gate.actor.id
      };
      await gate.set('~acct/' + eh, acct);
    } else if (isFounder && (acct.plan !== 'void' || acct.role !== 'admin')) {
      acct = Object.assign({}, acct, { plan: 'void', role: 'admin' });
      await gate.set('~acct/' + eh, acct);
    }
    if (isFounder && !gate.get('~cfg/admin')) {
      await gate.set('~cfg/admin', { eh: eh, actor: gate.actor.id, at: Date.now(), email: FOUNDER_EMAIL });
    }
    if (gate.get('~ban/' + eh)) throw new Error('this account is banned');
    try {
      await gate.del('~otp/' + opts.otp);
    } catch (e) {}
    const ticket = {
      v: 1,
      email: email || undefined,
      eh: eh,
      plan: acct.plan,
      role: acct.role,
      actor: gate.actor.id,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
      at: Date.now()
    };
    saveTicket(ticket);
    savePending(null);
    if (api.db && api.db.bindAccount) api.db.bindAccount(ticket);
    return ticket;
  }
  async function refreshAccount() {
    const t = loadTicket();
    if (!t) return null;
    const gate = await openGate();
    if (gate.get('~ban/' + t.eh)) {
      saveTicket(null);
      if (api.db) api.db.bindAccount(null);
      throw new Error('this account is banned');
    }
    const acct = gate.get('~acct/' + t.eh);
    if (acct) {
      t.plan = acct.plan;
      t.role = acct.role;
      saveTicket(t);
      if (api.db && api.db.bindAccount) api.db.bindAccount(t);
    }
    return t;
  }
  function logout() {
    saveTicket(null);
    if (api.db && api.db.bindAccount) api.db.bindAccount(null);
  }
  async function checkout(plan) {
    if (plan !== 'braid' && plan !== 'loom') throw new Error('pick braid or loom');
    const t = loadTicket();
    if (!t) throw new Error('log in with email first');
    const gate = await openGate();
    const id = uid();
    const inv = { id: id, eh: t.eh, plan: plan, eur: PLANS[plan].eur, status: 'open', at: Date.now() };
    await gate.set('~inv/' + id, inv);
    const pay = gate.get('~cfg/pay') || {};
    return { invoice: inv, pay: pay, mail: FOUNDER_EMAIL };
  }
  async function markPaid(id) {
    const t = loadTicket();
    if (!t) throw new Error('log in first');
    const gate = await openGate();
    const inv = gate.get('~inv/' + id);
    if (!inv) throw new Error('no invoice');
    if (inv.eh !== t.eh && t.role !== 'admin') throw new Error('not your invoice');
    await gate.set('~inv/' + id, Object.assign({}, inv, { status: 'pending', claimed: Date.now() }));
    return gate.get('~inv/' + id);
  }
  function needAdmin() {
    const t = loadTicket();
    if (!t || t.role !== 'admin') throw new Error('admin only');
    return t;
  }
  async function adminConfirm(id) {
    needAdmin();
    const gate = await openGate();
    const inv = gate.get('~inv/' + id);
    if (!inv) throw new Error('no invoice');
    await gate.set('~inv/' + id, Object.assign({}, inv, { status: 'paid', paid: Date.now() }));
    const acct = gate.get('~acct/' + inv.eh) || { eh: inv.eh, at: Date.now() };
    await gate.set('~acct/' + inv.eh, Object.assign({}, acct, { plan: inv.plan }));
    return gate.get('~acct/' + inv.eh);
  }
  async function adminSetPlan(eh, plan) {
    needAdmin();
    if (!PLANS[plan]) throw new Error('unknown plan');
    const gate = await openGate();
    const acct = gate.get('~acct/' + eh) || { eh: eh, at: Date.now() };
    const role = plan === 'void' ? 'admin' : acct.role === 'admin' && plan !== 'void' ? 'user' : acct.role || 'user';
    await gate.set('~acct/' + eh, Object.assign({}, acct, { plan: plan, role: role }));
    return gate.get('~acct/' + eh);
  }
  async function adminBan(eh, reason) {
    needAdmin();
    const gate = await openGate();
    await gate.set('~ban/' + eh, { at: Date.now(), reason: String(reason || '') });
    return true;
  }
  async function adminUnban(eh) {
    needAdmin();
    const gate = await openGate();
    await gate.del('~ban/' + eh);
    return true;
  }
  async function adminSetPay(cfg) {
    needAdmin();
    const gate = await openGate();
    await gate.set('~cfg/pay', cfg || {});
    return cfg;
  }
  function listAccounts() {
    const g = api.gate;
    if (!g) return [];
    const out = [];
    for (const [k, v] of g.scan('~mail/')) {
      const eh = k.slice(6);
      const acct = g.get('~acct/' + eh) || {};
      const ban = g.get('~ban/' + eh);
      out.push({
        eh: eh,
        actor: v && v.actor,
        plan: acct.plan || 'spark',
        role: acct.role || 'user',
        banned: !!ban,
        reason: ban && ban.reason,
        at: (acct.at || v.at) | 0
      });
    }
    return out;
  }
  function listInvoices() {
    const g = api.gate;
    if (!g) return [];
    return g.scan('~inv/').map(function (row) {
      return row[1];
    });
  }
  async function claimNamespace(ns, ticket) {
    ticket = ticket || loadTicket();
    if (!ticket) throw new Error('connections need an account — log in at #/in');
    const gate = await openGate();
    if (gate.get('~ban/' + ticket.eh)) throw new Error('banned');
    const nsHash = (await sha256('aether:ns:' + ns)).slice(0, 24);
    const key = '~ns/' + nsHash;
    const cur = gate.get(key);
    if (cur && cur.eh !== ticket.eh && ticket.role !== 'admin') throw new Error('namespace owned by another account');
    const owned = gate.scan('~ns/').filter(function (row) {
      return row[1] && row[1].eh === ticket.eh;
    }).length;
    const plan = PLANS[ticket.plan] || PLANS.spark;
    if (ticket.role !== 'admin' && !cur && owned >= plan.ns)
      throw new Error('Æther limit: ' + ticket.plan + ' allows ' + plan.ns + ' namespace(s). Pay: #/account');
    if (!cur) await gate.set(key, { eh: ticket.eh, ns: ns, actor: gate.actor.id, at: Date.now() });
    return gate.get(key);
  }
  async function ownedNamespaces() {
    const t = loadTicket();
    if (!t) return [];
    const gate = await openGate();
    try {
      await gate.waitSync(2500);
    } catch (e) {}
    return gate
      .scan('~ns/')
      .filter(function (row) {
        return row[1] && row[1].eh === t.eh;
      })
      .map(function (row) {
        return row[1];
      });
  }
  function myInvoices() {
    const t = loadTicket();
    if (!t) return [];
    return listInvoices().filter(function (i) {
      return i && i.eh === t.eh;
    });
  }

  const waiters = [];
  const pendingDefine = [];

  function markQuery(fn) {
    fn._aeKind = 'query';
    return fn;
  }
  function markMutation(fn) {
    fn._aeKind = 'mutation';
    return fn;
  }
  function define(mods) {
    pendingDefine.push(mods);
    if (api.db && api.db.define) api.db.define(mods);
    return mods;
  }
  function installDefines(db) {
    pendingDefine.forEach(function (m) {
      db.define(m);
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function interpolate(tpl, row) {
    return tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, k) {
      return escapeHtml(row[k] == null ? '' : row[k]);
    });
  }
  function mount(root) {
    if (typeof document === 'undefined') return;
    root = root || document;
    if (!api.db) {
      when(function () {
        mount(root);
      });
      return;
    }
    const db = api.db;
    root.querySelectorAll('[data-ae]').forEach(function (el) {
      if (el.getAttribute('data-ae-bound')) return;
      el.setAttribute('data-ae-bound', '1');
      const name = el.getAttribute('data-ae');
      const tplEl = el.querySelector('template');
      const tpl = tplEl ? tplEl.innerHTML : el.getAttribute('data-ae-tpl') || '<div>{body}</div>';
      try {
        db.live(name, {}, function (rows) {
          const items = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
          const html = items
            .map(function (r) {
              return interpolate(tpl, r);
            })
            .join('');
          const keep = tplEl ? '<template>' + tplEl.innerHTML + '</template>' : '';
          el.innerHTML = keep + html;
        });
      } catch (e) {
        el.setAttribute('data-ae-error', String(e && e.message ? e.message : e));
      }
    });
    root.querySelectorAll('[data-ae-run]').forEach(function (el) {
      if (el.getAttribute('data-ae-bound')) return;
      el.setAttribute('data-ae-bound', '1');
      el.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = el.getAttribute('data-ae-run');
        const fd = new FormData(el);
        const args = {};
        fd.forEach(function (v, k) {
          args[k] = v;
        });
        db.run(name, args).then(function () {
          if (typeof el.reset === 'function') el.reset();
        });
      });
    });
  }

  const api = {
    open,
    hitch: hitch,
    connect: hitch,
    use: hitch,
    when: when,
    secret,
    link,
    share: shareUrl,
    kit,
    parse: parseLink,
    snippet,
    page,
    boot: boot,
    GATE: GATE_NS,
    GENESIS: GENESIS_NS,
    define,
    query: markQuery,
    mutation: markMutation,
    mount,
    db: null,
    ready: null,
    gate: null,
    ticket: loadTicket(),
    account: {
      send: sendLogin,
      prove: proveLogin,
      me: loadTicket,
      pending: loadPending,
      logout: logout,
      refresh: refreshAccount,
      checkout: checkout,
      markPaid: markPaid,
      claim: claimNamespace,
      hash: hashEmail,
      open: openGate,
      owned: ownedNamespaces,
      invoices: myInvoices
    },
    admin: {
      email: FOUNDER_EMAIL,
      confirm: adminConfirm,
      setPlan: adminSetPlan,
      ban: adminBan,
      unban: adminUnban,
      setPay: adminSetPay,
      list: listAccounts,
      invoices: listInvoices,
      isAdmin: function () {
        const t = loadTicket();
        return !!(t && t.role === 'admin');
      }
    },
    plans: PLANS,
    founder: FOUNDER_EMAIL,
    theorem,
    version: VERSION,
    Lattice,
    HLC,
    Collection,
    Query,
    CQuery,
    canonical,
    sha256,
    trackers: DEFAULT_TRACKERS,
    mqtt: DEFAULT_MQTT
  };

  function hitch(nsOrLink, opts) {
    const parsed = parseLink(nsOrLink);
    if (!parsed.ns) return Promise.reject(new Error('Aether.hitch needs a namespace'));
    const o = Object.assign({}, opts || {});
    if (parsed.passphrase && !o.passphrase) o.passphrase = parsed.passphrase;
    if (!o.ticket) o.ticket = loadTicket();
    if (api.db && !api.db.closed && api.db.ns === parsed.ns) {
      if (o.ticket) api.db.bindAccount(o.ticket);
      return Promise.resolve(api.db);
    }
    if (api.db && api.db !== api.gate && !api.db.closed) {
      try {
        api.db.close();
      } catch (e) {}
    }
    api.ready = open(parsed.ns, o).then(function (db) {
      api.db = db;
      if (o.ticket) db.bindAccount(o.ticket);
      installDefines(db);
      waiters.splice(0).forEach(function (fn) {
        try {
          fn(db);
        } catch (e) {}
      });
      try {
        mount(document);
      } catch (e) {}
      if (o.ticket && o.claim !== false && parsed.ns !== GATE_NS && parsed.ns !== GENESIS_NS) {
        claimNamespace(parsed.ns, o.ticket).catch(function (e) {
          db.log('claim ' + (e && e.message ? e.message : e));
        });
      }
      return db;
    });
    return api.ready;
  }

  function when(fn) {
    if (api.db) {
      fn(api.db);
      return;
    }
    waiters.push(fn);
    if (api.ready) api.ready.then(fn);
  }

  function boot() {
    if (typeof document === 'undefined') return;
    const nodes = [];
    const cur = document.currentScript;
    if (cur && (cur.getAttribute('data-aether') || cur.getAttribute('data-connect'))) nodes.push(cur);
    document.querySelectorAll('script[data-aether], script[data-connect]').forEach(function (s) {
      if (nodes.indexOf(s) === -1) nodes.push(s);
    });
    const el = nodes[0];
    if (!el) return;
    const ns = el.getAttribute('data-aether') || el.getAttribute('data-connect');
    if (!ns) return;
    const pass = el.getAttribute('data-pass') || el.getAttribute('data-passphrase') || '';
    const as = el.getAttribute('data-as') || 'db';
    hitch(ns, pass ? { passphrase: pass } : {}).then(function (db) {
      try {
        if (typeof window !== 'undefined') {
          window[as] = db;
          window.dispatchEvent(new CustomEvent('aether-ready', { detail: db }));
        }
      } catch (e) {}
    });
  }

  return api;
});

if (typeof document !== 'undefined' && typeof Aether !== 'undefined' && Aether.boot) {
  Aether.boot();
}
