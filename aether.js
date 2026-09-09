/*  ÆTHER  —  the backend that is not a place.
    ──────────────────────────────────────────
    A join-semilattice of signed CRDT replicas that inhabit browsers.
    There is no origin server for data. Public BitTorrent trackers and
    MQTT brokers are used only as *matchmakers* (SDP exchange). Once
    WebRTC opens, every mutation is gossiped peer-to-peer. Same-origin
    tabs also sync over BroadcastChannel. Persistence is IndexedDB on
    every replica. The global state is the least upper bound of all
    replicas — proven eventually consistent (Shapiro et al., 2011).

    Any website includes this file, opens the same namespace, and they
    share one mathematical object. Capability = knowledge of the name.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Aether = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.1.0';
  const CHAN = 'aether';
  const MAX_PEERS = 16;
  const CHUNK = 12000;
  const EVENT_CAP = 4000;
  const DEFAULT_TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.novage.com.ua:8000/announce'
  ];
  const DEFAULT_MQTT = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };

  /* ───────────── bytes & hashes ───────────── */

  const te = new TextEncoder();
  const td = new TextDecoder();

  const hex = (buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

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

  /* ───────────── hybrid logical clock ─────────────
     String form is totally ordered: physical > logical > actor.
     Observing a remote stamp never lets us go backwards. */

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

  /* ───────────── CRDT: LWW-Map over a signed event log ─────────────
     State is a map key → {value, ts, actor, del}.
     Merge is join on the (ts, actor) total order. Commutative,
     associative, idempotent ⇒ a join-semilattice. */

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
      if (ev.op === 'set' || ev.op === 'del') {
        const cur = this.state.get(ev.key);
        if (!cur || ev.ts > cur.ts || (ev.ts === cur.ts && ev.actor > cur.actor)) {
          this.state.set(ev.key, {
            value: ev.op === 'del' ? undefined : ev.value,
            ts: ev.ts,
            actor: ev.actor,
            del: ev.op === 'del'
          });
        }
      }
      if (this.order.length > EVENT_CAP) this._gc();
      return true;
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
        if (!prefix || k.startsWith(prefix)) out.push([k, c.value, c.ts, c.actor]);
      }
      out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return out;
    }
    merkle() {
      if (!this.order.length) return '∅';
      const ids = this.order.slice().sort();
      let h = 0;
      for (const id of ids) {
        for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
      }
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
        const tag = e.key + '\0' + e.ts + '\0' + e.actor;
        if (keep.has(tag) || e.op === 'del') {
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
      for (const [k, c] of this.state) {
        if (!c.del) o[k] = c.value;
      }
      return o;
    }
  }

  /* ───────────── identity (ECDSA P-256) ───────────── */

  async function generateIdentity() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify'
    ]);
    const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
    const jwkPub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const fp = (await sha256(raw)).slice(0, 16);
    return { id: fp, pub: hex(raw), jwkPub, jwkPriv };
  }

  async function importIdentity(rec) {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      rec.jwkPub,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify']
    );
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      rec.jwkPriv,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    );
    return { id: rec.id, pub: rec.pub, publicKey, privateKey, jwkPub: rec.jwkPub, jwkPriv: rec.jwkPriv };
  }

  async function signBytes(priv, msg) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, te.encode(msg));
    return hex(sig);
  }

  async function verifyBytes(pubHex, msg, sigHex) {
    try {
      const raw = unhex(pubHex);
      const key = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
      );
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        unhex(sigHex),
        te.encode(msg)
      );
    } catch {
      return false;
    }
  }

  function bodyOf(ev) {
    return canonical({ op: ev.op, key: ev.key, value: ev.value, ts: ev.ts, actor: ev.actor, pub: ev.pub });
  }

  /* ───────────── IndexedDB ───────────── */

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

  /* ───────────── tiny MQTT 3.1.1 client (signaling only) ───────────── */

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

  class MqttSignal {
    constructor(url, topic, onMsg, log) {
      this.url = url;
      this.topic = topic;
      this.onMsg = onMsg;
      this.log = log;
      this.ws = null;
      this.alive = false;
      this.ping = null;
      this.cid = 'ae' + uid();
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
          const pkt = concatU8([new Uint8Array([0x10, ...mqttLen(vh.length)]), vh]);
          this.ws.send(pkt);
        };
        this.ws.onmessage = (ev) => {
          const u = new Uint8Array(ev.data);
          if (!u.length) return;
          const type = u[0] >> 4;
          if (type === 2) {
            clearTimeout(t);
            this.alive = true;
            this._sub();
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
    _sub() {
      const id = new Uint8Array([0x00, 0x01]);
      const topic = mqttStr(this.topic);
      const qos = new Uint8Array([0]);
      const vh = concatU8([id, topic, qos]);
      const pkt = concatU8([new Uint8Array([0x82, ...mqttLen(vh.length)]), vh]);
      this.ws.send(pkt);
    }
    publish(obj) {
      if (!this.alive || !this.ws || this.ws.readyState !== 1) return;
      const topic = mqttStr(this.topic);
      const payload = te.encode(JSON.stringify(obj));
      const vh = concatU8([topic, payload]);
      const pkt = concatU8([new Uint8Array([0x30, ...mqttLen(vh.length)]), vh]);
      this.ws.send(pkt);
    }
    _pubin(u) {
      let i = 1;
      let mul = 1;
      let rem = 0;
      while (i < u.length) {
        const d = u[i++];
        rem += (d & 127) * mul;
        if ((d & 128) === 0) break;
        mul *= 128;
      }
      const qos = (u[0] & 0x06) >> 1;
      const tlen = (u[i] << 8) | u[i + 1];
      i += 2;
      i += tlen;
      if (qos > 0) i += 2;
      try {
        const msg = JSON.parse(td.decode(u.slice(i)));
        this.onMsg(msg);
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

  /* ───────────── WebRTC helpers ───────────── */

  function waitIce(pc, ms = 3500) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve(pc.localDescription);
    return new Promise((resolve) => {
      const done = () => resolve(pc.localDescription);
      const t = setTimeout(done, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          done();
        }
      });
    });
  }

  /* ───────────── Replica (the living backend) ───────────── */

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
      this.stats = {
        events: 0,
        gossip: 0,
        tracker: 0,
        webrtc: 0,
        mqtt: 0,
        started: Date.now()
      };
      this.logLines = [];
      this._chunkBuf = new Map();
      this._announceTimer = null;
      this._presenceTimer = null;
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
        peers: live.map((p) => ({
          id: p.actor || p.trackerId,
          via: p.via,
          open: p.open
        })),
        peerCount: live.length,
        events: this.lattice.order.length,
        keys: [...this.lattice.state.values()].filter((c) => !c.del).length,
        merkle: this.lattice.merkle(),
        servers: 0,
        theorem: 'Ω = ⊔ replicas  (join-semilattice)',
        stats: { ...this.stats },
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
      const ih = unhex(this.nsHash.slice(0, 40));
      this.infoHashBin = binary20(ih);
      const pid = randBytes(20);
      pid[0] = '-'.charCodeAt(0);
      pid[1] = 'A'.charCodeAt(0);
      pid[2] = 'E'.charCodeAt(0);
      pid[3] = '0'.charCodeAt(0);
      pid[4] = '1'.charCodeAt(0);
      pid[5] = '-'.charCodeAt(0);
      this.peerIdBin = binary20(pid);
      this.peerIdHex = hex(pid);

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
          const tx = this.idb.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(
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
          for (const ev of all) this.lattice.apply(ev);
          this.stats.events = this.lattice.order.length;
          this.log('rehydrated ' + all.length + ' events from this browser');
        }
      }

      this._bindBroadcast();
      if (this.opts.signal !== false) {
        this._bindTrackers(this.opts.trackers || DEFAULT_TRACKERS);
        this._bindMqtt(this.opts.mqtt || DEFAULT_MQTT);
      }
      this._presenceTimer = setInterval(() => this._beat(), 12000);
      this._beat();
      this.ready = true;
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
        this._bcSend({ t: 'HELLO', from: this.actor.id, pub: this.actor.pub, have: this.lattice.allIds(), merkle: this.lattice.merkle() });
      } catch {}
    }

    _bcSend(msg) {
      if (!this.bc) return;
      try {
        this.bc.postMessage({ ...msg, from: this.actor.id });
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
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        this._onTracker(tr, msg);
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
            if (off)
              offers.push({
                offer_id: off.offerIdBin,
                offer: { type: 'offer', sdp: off.sdp }
              });
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
        buf: '',
        send: (m) => this._dcSend(rec, m)
      };
      this.pcs.set(tag, rec);
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
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
      for (let k = 0; k < n; k++) {
        rec.ch.send(JSON.stringify({ t: '_chk', id, k, n, d: s.slice(k * CHUNK, (k + 1) * CHUNK) }));
      }
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
        } catch (e) {
          this.log('offer fail');
        }
      }
      if (msg.answer && msg.offer_id != null) {
        const pc =
          this.pendingOffers.get(msg.offer_id) ||
          this.pendingOffers.get(binToHex20(msg.offer_id)) ||
          this.pendingOffers.get(hex(typeof msg.offer_id === 'string' ? te.encode(msg.offer_id).slice(0, 20) : []));
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
      const topic = 'aether/v1/' + this.nsHash.slice(0, 40) + '/sig';
      for (const url of urls) {
        const m = new MqttSignal(
          url,
          topic,
          (msg) => this._onMqttSig(msg),
          (s) => this.log(s)
        );
        m.connect().then((ok) => {
          if (!ok) return;
          this.mqtt.push(m);
          this.stats.mqtt++;
          this._mqttOffer(m);
          this._emitStatus('mqtt');
        });
      }
    }

    async _mqttOffer(m) {
      try {
        const off = await this._makeOffer();
        if (!off) return;
        m.publish({
          k: 'offer',
          from: this.peerIdHex,
          actor: this.actor.id,
          offer_id: off.offerIdHex,
          sdp: off.sdp
        });
      } catch {}
    }

    async _onMqttSig(msg) {
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
            m.publish({
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

    async _onWire(msg, rec) {
      if (!msg || !msg.t) return;
      if (msg.t === 'HELLO') {
        rec.actor = msg.from;
        rec.pub = msg.pub;
        this.stats.gossip++;
        const miss = this.lattice.missing(msg.have || []);
        const theyNeed = (this.lattice.allIds() || []).filter((id) => !(msg.have || []).includes(id));
        if (theyNeed.length) rec.send({ t: 'EVENTS', es: this.lattice.dump(theyNeed.slice(0, 400)) });
        if (miss.length) rec.send({ t: 'WANT', ids: miss.slice(0, 400) });
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

    async _ingest(ev, local) {
      if (!ev || !ev.id) return false;
      if (this.lattice.has(ev.id)) return false;
      if (!local) {
        if (!ev.sig || !ev.pub || !ev.actor) return false;
        const ok = await verifyBytes(ev.pub, bodyOf(ev), ev.sig);
        if (!ok) {
          this.log('drop unsigned/forged event');
          return false;
        }
      }
      if (ev.ts) this.hlc.observe(ev.ts);
      const applied = this.lattice.apply(ev);
      if (!applied) return false;
      this.stats.events = this.lattice.order.length;
      if (this.idb) {
        try {
          this.idb.transaction('events', 'readwrite').objectStore('events').put(ev);
        } catch {}
      }
      for (const w of this.watchers) {
        if (!w.prefix || (ev.key && ev.key.startsWith(w.prefix))) {
          try {
            w.fn(ev.key, ev.op === 'del' ? undefined : this.lattice.get(ev.key), ev);
          } catch {}
        }
      }
      this._emitStatus('change', ev);
      return true;
    }

    _gossip(ev) {
      const msg = { t: 'EVENT', e: ev, from: this.actor.id };
      this._bcSend(msg);
      for (const rec of this.peers.values()) {
        if (rec.via === 'webrtc' && rec.open) rec.send(msg);
      }
    }

    async mutate(op, key, value) {
      if (!this.ready) throw new Error('aether not open');
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
    async del(key) {
      await this.mutate('del', key);
    }
    get(key) {
      return this.lattice.get(key);
    }
    has(key) {
      return this.lattice.get(key) !== undefined;
    }
    keys(prefix) {
      return this.lattice.scan(prefix).map((x) => x[0]);
    }
    scan(prefix) {
      return this.lattice.scan(prefix);
    }
    all() {
      return this.lattice.snapshot();
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
      const p = '#c/' + key + '/';
      for (const [k, v] of this.lattice.scan(p)) s += Number(v) || 0;
      return s;
    }

    async append(key, value) {
      const id = uid();
      const k = '#l/' + key + '/' + Date.now().toString(36) + '-' + id;
      await this.set(k, value);
      return k;
    }
    tail(key, n) {
      const p = '#l/' + key + '/';
      const rows = this.lattice.scan(p);
      const m = n == null ? rows.length : n;
      return rows.slice(-m).map(([k, v, ts, actor]) => ({ key: k, value: v, ts, actor }));
    }

    async _beat() {
      if (!this.ready || this.closed) return;
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
      for (const [k, v] of this.lattice.scan('#p/')) {
        if (v && typeof v.at === 'number' && now - v.at < windowMs) {
          out.push({ actor: k.slice(3), at: v.at, origin: v.origin });
        }
      }
      return out;
    }

    async close() {
      this.closed = true;
      clearInterval(this._announceTimer);
      clearInterval(this._presenceTimer);
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

  /* ───────────── the theorem, executed ───────────── */

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
    const BC = mergeLat(B, C);
    const A_BC = mergeLat(A, BC);
    const associative = snapEq(ABC, A_BC);
    const AA = mergeLat(A, A);
    const idempotent = snapEq(AA, A);
    const lub = ABC.snapshot();
    return {
      commutative,
      associative,
      idempotent,
      holds: commutative && associative && idempotent,
      lub,
      note: 'LWW-Map is a join-semilattice on (timestamp, actor). Ω = ⊔ replicas. Divergence is temporary; the least upper bound is unique.'
    };
  }

  async function open(ns, opts) {
    if (!ns || typeof ns !== 'string') throw new Error('Aether.open(namespace) requires a string capability');
    const r = new Replica(ns, opts || {});
    await r.open();
    return r;
  }

  return {
    open,
    theorem,
    version: VERSION,
    Lattice,
    HLC,
    canonical,
    sha256,
    trackers: DEFAULT_TRACKERS,
    mqtt: DEFAULT_MQTT
  };
});
