/* ÆTHER exhibition — binds the living replica to the plates. */
(function () {
  const NS = 'æther://genesis';
  const $ = (id) => document.getElementById(id);

  const theorem = Aether.theorem();
  $('t-th').textContent = theorem.holds ? 'holds' : 'BROKEN';
  $('proof').innerHTML = [
    ['commutative', theorem.commutative],
    ['associative', theorem.associative],
    ['idempotent', theorem.idempotent],
    ['Ω unique', theorem.holds]
  ]
    .map(
      ([k, v]) =>
        `<div class="cell"><b>${k}</b><div class="v ${v ? 'pass' : 'fail'}">${
          v ? 'pass' : 'fail'
        }</div></div>`
    )
    .join('');

  const origin = location.origin + location.pathname.replace(/[^/]*$/, '') + 'aether.js';
  if ($('origin')) $('origin').textContent = origin;
  $('snip').textContent = `<script src="${origin}"></script>
<script>
(async () => {
  const db = await Aether.open('replace-with-a-long-secret', {
    passphrase: 'optional-second-lock',
    rules: { '*': { read: true, write: true }, 'users/:id': { write: 'owner' } }
  });

  await db.col('users').doc('ada').set({ name: 'Ada', year: 1843 });
  db.col('users').where('year', '>=', 1800).on(docs => console.log(docs));

  await db.inc('signups', 1);
  await db.files.put(new Blob(['hello'], { type: 'text/plain' }));
  await db.auth.claim('ada');

  const capsule = db.exportCapsule(); // backup the whole lattice
})();
</script>`;

  const sides = document.querySelectorAll('.side-index a');
  if (sides.length && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          sides.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + en.target.id));
        });
      },
      { threshold: 0.35 }
    );
    document.querySelectorAll('section[id], main[id]').forEach((s) => io.observe(s));
  }

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('snip').textContent);
      $('copy').textContent = 'copied';
      setTimeout(() => ($('copy').textContent = 'copy the hitch'), 1400);
    } catch {
      $('copy').textContent = 'select it yourself';
    }
  });

  const cout = $('cout');
  function cprint(s, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = s;
    cout.appendChild(line);
    cout.scrollTop = cout.scrollHeight;
  }
  cprint('æther ' + Aether.version + ' — waiting for replica…');
  cprint('commands: get set del inc count keys scan append tail peers merkle who help');

  /* ── star field ── */
  const canvas = $('field');
  const ctx = canvas.getContext('2d');
  const stars = [];
  const ripples = [];
  let rot = 0.4;
  let dbRef = null;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
  }
  resize();
  addEventListener('resize', resize);

  function hashStar(h) {
    const s = (h || '0').padEnd(16, '0');
    const u = parseInt(s.slice(0, 8), 16) / 0xffffffff;
    const v = parseInt(s.slice(8, 16), 16) / 0xffffffff;
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * (v || 0.5) - 1);
    return {
      x: Math.sin(phi) * Math.cos(theta),
      y: Math.cos(phi),
      z: Math.sin(phi) * Math.sin(theta),
      key: h
    };
  }

  function rebuildStars() {
    stars.length = 0;
    if (!dbRef) return;
    for (const [k] of dbRef.scan()) {
      const h = k.replace(/[^a-f0-9]/gi, 'a').slice(0, 16) + k.length.toString(16);
      const st = hashStar(h);
      st.label = k;
      stars.push(st);
    }
    for (const p of dbRef.presence()) {
      const st = hashStar(p.actor);
      st.peer = true;
      st.label = p.actor;
      stars.push(st);
    }
  }

  function project(s, w, h) {
    const c = Math.cos(rot);
    const si = Math.sin(rot);
    const x = s.x * c - s.z * si;
    const z = s.x * si + s.z * c;
    const y = s.y;
    const persp = 1.7 / (2.2 + z);
    return { x: w / 2 + x * persp * Math.min(w, h) * 0.42, y: h / 2 + y * persp * Math.min(w, h) * 0.42, z, p: persp };
  }

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    rot += 0.0016;

    ctx.strokeStyle = 'rgba(221,243,90,0.05)';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) * 0.38, 0, Math.PI * 2);
    ctx.stroke();

    const pts = stars.map((s) => ({ s, p: project(s, w, h) }));
    pts.sort((a, b) => a.p.z - b.p.z);

    const peers = pts.filter((x) => x.s.peer);
    ctx.strokeStyle = 'rgba(208,138,76,0.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        ctx.beginPath();
        ctx.moveTo(peers[i].p.x, peers[i].p.y);
        ctx.lineTo(peers[j].p.x, peers[j].p.y);
        ctx.stroke();
      }
    }

    for (const { s, p } of pts) {
      const r = s.peer ? 3.4 : 1.2 + p.p;
      ctx.beginPath();
      ctx.fillStyle = s.peer ? '#ddf35a' : 'rgba(241,230,208,' + (0.25 + p.p * 0.5) + ')';
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += 2.2;
      rp.a *= 0.96;
      ctx.strokeStyle = 'rgba(221,243,90,' + rp.a + ')';
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.stroke();
      if (rp.a < 0.03) ripples.splice(i, 1);
    }

    requestAnimationFrame(draw);
  }
  draw();

  function boom() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ripples.push({ x: w / 2, y: h / 2, r: 6, a: 0.55 });
  }

  function renderPulse(db) {
    $('pulse').textContent = db.count('pulse');
  }
  function renderWhispers(db) {
    const rows = db.tail('whispers', 40).slice().reverse();
    $('whispers').innerHTML = rows
      .map((r) => {
        const v = r.value || {};
        const t = new Date(v.at || Date.now()).toISOString().slice(11, 19);
        const who = (r.actor || '').slice(0, 8);
        const text = String(v.text || '').replace(/[<>]/g, '');
        return `<div class="whisper"><div class="meta">${t} · ${who}</div>${text}</div>`;
      })
      .join('');
  }
  function renderLedger(db) {
    const rows = db
      .scan()
      .filter(([k]) => !k.startsWith('#') && !k.startsWith('__'))
      .slice(0, 80);
    $('ledger').innerHTML = rows
      .map(([k, v, ts, actor]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `<tr><td class="k">${esc(k)}</td><td>${esc(val)}</td><td class="muted">${esc(
          (actor || '').slice(0, 8)
        )}</td></tr>`;
      })
      .join('');
  }
  function esc(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function paintStatus(db, type, extra) {
    const st = db.status();
    $('merkle').textContent = st.merkle;
    $('t-merkle').textContent = st.merkle;
    $('keyn').textContent = st.keys;
    const n = Math.max(1, db.presence().length);
    $('peern').textContent = n;
    $('t-peers').textContent = n;
    $('t-ev').textContent = st.events;
    $('t-actor').textContent = (st.actor || '').slice(0, 8);
    $('who').textContent = st.actor || '—';
    if (type === 'log' && extra) {
      const el = $('slog');
      const d = document.createElement('div');
      const ts = new Date(extra.t).toISOString().slice(11, 19);
      d.innerHTML = `<span class="ts">${ts}</span>${esc(extra.msg)}`;
      el.appendChild(d);
      el.scrollTop = el.scrollHeight;
    }
    if (type === 'change') {
      boom();
      renderPulse(db);
      renderWhispers(db);
      renderLedger(db);
      rebuildStars();
    }
    if (type === 'open' || type === 'sync' || type === 'peer') {
      renderPulse(db);
      renderWhispers(db);
      renderLedger(db);
      rebuildStars();
    }
  }

  function beep() {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = 440;
      g.gain.value = 0.03;
      o.connect(g);
      g.connect(ac.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.08);
      o.stop(ac.currentTime + 0.09);
    } catch {}
  }

  Aether.open(NS).then((db) => {
    dbRef = db;
    cprint('replica ' + db.actor.id + ' · ns ' + NS, 'ok');
    cprint('merkle ' + db.lattice.merkle(), 'ok');
    paintStatus(db, 'open');
    db.onStatus((type, _s, extra) => paintStatus(db, type, extra));
    db.watch('', () => {});

    $('hit').addEventListener('click', async () => {
      await db.inc('pulse', 1);
      beep();
    });
    function sendWhisper() {
      const t = $('whisper-in').value.trim();
      if (!t) return;
      $('whisper-in').value = '';
      db.append('whispers', { text: t.slice(0, 240), at: Date.now() });
    }
    $('whisper-btn').addEventListener('click', sendWhisper);
    $('whisper-in').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendWhisper();
    });
    $('set-btn').addEventListener('click', async () => {
      const k = $('k-in').value.trim();
      if (!k) return;
      let v = $('v-in').value;
      try {
        v = JSON.parse(v);
      } catch {}
      await db.set(k, v);
    });

    const capOut = $('capsule-out');
    if (capOut) {
      capOut.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(db.exportCapsule())], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'aether-capsule.json';
        a.click();
      });
    }
    const capIn = $('capsule-in');
    if (capIn) {
      capIn.addEventListener('change', async () => {
        const f = capIn.files && capIn.files[0];
        if (!f) return;
        const text = await f.text();
        const n = await db.importCapsule(text);
        cprint('capsule ingested ' + n, 'ok');
      });
    }

    $('cin').addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const line = $('cin').value.trim();
      $('cin').value = '';
      if (!line) return;
      cprint('æ› ' + line);
      try {
        cprint(await run(db, line), 'ok');
      } catch (err) {
        cprint(String(err.message || err), 'err');
      }
    });
  });

  async function run(db, line) {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = line.slice(parts[0].length).trim();
    if (cmd === 'help')
      return 'get KEY | set KEY JSON | del KEY | inc KEY [n] | count KEY | keys [prefix] | scan [prefix] | append KEY TEXT | tail KEY [n] | peers | merkle | who | all';
    if (cmd === 'who') return db.actor.id;
    if (cmd === 'merkle') return db.lattice.merkle();
    if (cmd === 'peers') return JSON.stringify(db.presence(), null, 2);
    if (cmd === 'all') return JSON.stringify(db.all(), null, 2);
    if (cmd === 'keys') return db.keys(parts[1] || '').join('\n') || '(none)';
    if (cmd === 'scan')
      return db
        .scan(parts[1] || '')
        .map(([k, v]) => k + '  ' + JSON.stringify(v))
        .join('\n') || '(none)';
    if (cmd === 'get') return JSON.stringify(db.get(parts[1]), null, 2);
    if (cmd === 'del') {
      await db.del(parts[1]);
      return 'deleted ' + parts[1];
    }
    if (cmd === 'inc') {
      const n = await db.inc(parts[1], parts[2] ? Number(parts[2]) : 1);
      return parts[1] + ' = ' + n;
    }
    if (cmd === 'count') return String(db.count(parts[1]));
    if (cmd === 'set') {
      const sp = rest.indexOf(' ');
      const k = sp === -1 ? rest : rest.slice(0, sp);
      let v = sp === -1 ? null : rest.slice(sp + 1);
      try {
        v = JSON.parse(v);
      } catch {}
      await db.set(k, v);
      return 'set ' + k;
    }
    if (cmd === 'append') {
      const sp = rest.indexOf(' ');
      const k = rest.slice(0, sp);
      const t = rest.slice(sp + 1);
      await db.append(k, { text: t, at: Date.now() });
      return 'appended';
    }
    if (cmd === 'tail')
      return JSON.stringify(db.tail(parts[1], parts[2] ? Number(parts[2]) : 10), null, 2);
    return 'unknown. help';
  }
})();
