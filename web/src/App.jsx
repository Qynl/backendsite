import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Aether, { copyText, download, go, readHash, sdkOrigin } from './lib/sdk.js';

const Ctx = createContext(null);
export const useSdk = () => useContext(Ctx);

function useRoute() {
  const [h, setH] = useState(readHash);
  useEffect(() => {
    const on = () => setH(readHash());
    addEventListener('hashchange', on);
    addEventListener('popstate', on);
    return () => {
      removeEventListener('hashchange', on);
      removeEventListener('popstate', on);
    };
  }, []);
  return h;
}

function Provider({ children }) {
  const [ticket, setTicket] = useState(() => Aether.account.me());
  const [ns, setNs] = useState(() => {
    try {
      return localStorage.getItem('aether.ns') || '';
    } catch {
      return '';
    }
  });
  const [pass, setPass] = useState('');
  const [db, setDb] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const unStatus = useRef(null);

  const refreshTicket = useCallback(async () => {
    try {
      const t = await Aether.account.refresh();
      setTicket(t || Aether.account.me());
      return t;
    } catch {
      setTicket(Aether.account.me());
      return Aether.account.me();
    }
  }, []);

  const hitchNs = useCallback(async (name, extra) => {
    setBusy('hitching the lattice…');
    try {
      const d = await Aether.hitch(name, extra || {});
      setDb(d);
      setNs(name);
      try {
        localStorage.setItem('aether.ns', name);
      } catch {}
      if (unStatus.current) unStatus.current();
      setStatus(d.status());
      unStatus.current = d.onStatus((_t, s) => setStatus(s));
      return d;
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => {
    if (!db || !ticket || !Aether.account.seal) return;
    Aether.account.seal(db, ticket).then(() => setStatus(db.status())).catch(() => {});
  }, [db, ticket]);

  const value = useMemo(
    () => ({
      Aether,
      ticket,
      setTicket,
      ns,
      setNs,
      pass,
      setPass,
      db,
      status,
      busy,
      setBusy,
      hitchNs,
      refreshTicket,
      origin: sdkOrigin()
    }),
    [ticket, ns, pass, db, status, busy, hitchNs, refreshTicket]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function Copy({ btn, label }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="ghost"
      type="button"
      onClick={async () => {
        const y = await copyText(btn);
        setOk(y);
        setTimeout(() => setOk(false), 1400);
      }}
    >
      {ok ? 'copied' : label || 'copy'}
    </button>
  );
}

function Top() {
  const { ticket, status } = useSdk();
  const { route } = useRoute();
  const [open, setOpen] = useState(false);
  const Link = ({ to, children }) => (
    <a
      href={'#/' + to}
      className={route === to ? 'on' : ''}
      onClick={() => setOpen(false)}
    >
      {children}
    </a>
  );
  return (
    <header className="top">
      <a className="brand" href="#/home">
        <svg width="36" height="36" viewBox="0 0 84 84" aria-hidden="true">
          <circle cx="42" cy="42" r="40" fill="none" stroke="#d08a4c" strokeWidth="1.2" />
          <text x="42" y="50" textAnchor="middle" fontFamily="Newsreader, serif" fontSize="22" fill="#f1e6d0">
            Æ
          </text>
        </svg>
        <div>
          <em>Æther</em>
          <small>v {Aether.version} · unhosted</small>
        </div>
      </a>
      <button className="burger" type="button" aria-label="menu" onClick={() => setOpen((v) => !v)}>
        ≡
      </button>
      <nav className={'nav' + (open ? ' open' : '')}>
        <Link to="connect">connect</Link>
        <Link to="room">room</Link>
        <Link to="in">email in</Link>
        <Link to="docs">docs</Link>
        <Link to="hello">hello</Link>
        <Link to="account">{ticket ? ticket.plan : 'account'}</Link>
        {ticket && ticket.role === 'admin' && <Link to="admin">admin</Link>}
        {ticket && <span className="chip">{ticket.plan}</span>}
        {status && status.locked && <span className="chip">{status.writer ? 'locked · you' : 'locked'}</span>}
        {status && <span className="chip">{status.peerCount || 0} peers</span>}
      </nav>
    </header>
  );
}

function Foot() {
  const { status, ticket, busy } = useSdk();
  return (
    <div className="foot">
      <span>0 servers</span>
      <span>v {Aether.version}</span>
      {ticket && (
        <span>
          plan <b>{ticket.plan}</b>
        </span>
      )}
      {status && (
        <>
          <span>
            merkle <b>{status.merkle}</b>
          </span>
          <span>
            events <b>{status.events}</b>
          </span>
          <span>
            peers <b>{status.peerCount}</b>
          </span>
        </>
      )}
      {busy && <span>{busy}</span>}
    </div>
  );
}

function Field({ db }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    const draw = () => {
      const w = (c.width = c.clientWidth * devicePixelRatio);
      const h = (c.height = 220 * devicePixelRatio);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#070806';
      ctx.fillRect(0, 0, w, h);
      const keys = db ? db.scan().slice(0, 180) : [];
      keys.forEach(([k], i) => {
        let hsh = 0;
        for (let n = 0; n < k.length; n++) hsh = (hsh * 33 + k.charCodeAt(n)) >>> 0;
        const x = ((hsh & 0xffff) / 0xffff) * w;
        const y = (((hsh >>> 16) & 0xffff) / 0xffff) * h;
        ctx.fillStyle = i % 7 === 0 ? '#ddf35a' : '#d08a4c';
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(x, y, 1.6 * devicePixelRatio, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    };
    draw();
    const un = db && db.watch ? db.watch('', draw) : () => {};
    const onr = () => draw();
    addEventListener('resize', onr);
    return () => {
      un && un();
      removeEventListener('resize', onr);
    };
  }, [db]);
  return <canvas className="field" ref={ref} />;
}

function Home() {
  const th = Aether.theorem();
  const [gen, setGen] = useState(null);
  const [n, setN] = useState(0);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    let d;
    (async () => {
      try {
        d = await Aether.open(Aether.GENESIS || 'æther://genesis', { meter: false });
        if (!alive) {
          d.close();
          return;
        }
        setGen(d);
        const tick = () => setN(d.count('pulse'));
        tick();
        d.watch('#c/pulse/', tick);
      } catch (e) {
        if (alive) setErr(String(e.message || e));
      }
    })();
    return () => {
      alive = false;
      try {
        d && d.close();
      } catch {}
    };
  }, []);
  return (
    <div className="page wide">
      <div className="hero-split">
        <div>
          <p className="kicker">a backend that is not a place</p>
          <h1>
            <span className="no">there is</span>
            NO
            <br />
            <strike>SERVER</strike>
          </h1>
          <p className="lede">
            Convex-shaped queries. Email-only accounts. The database is this browser, and every other browser holding
            the same name. Theorem {th.holds ? 'holds' : 'BROKEN'}.
          </p>
          <div className="row">
            <button className="hit" onClick={() => go('connect')}>
              get a backend
            </button>
            <button className="hit ghost" onClick={() => go('in')}>
              log in with email
            </button>
          </div>
        </div>
        <aside className="aside">
          <strong>What the network tab will show</strong>
          static html, css, js
          <br />
          wss → public bittorrent trackers
          <br />
          stun → ice candidates
          <br />
          webrtc datachannels
          <br />
          optional POST formsubmit.co (mail hop only)
          <br />
          <span style={{ color: 'var(--acid)' }}>Ω = ⊔ replicas</span>
          <br />
          Trackers matchmake. They never see a document. There is no Æther company.
        </aside>
      </div>

      <div className="grid" style={{ marginTop: 48 }}>
        <div className="card">
          <div className="lbl">1. email once</div>
          <p>No password. One letter proves the inbox. After that this browser is verified — we do not ask again.</p>
        </div>
        <div className="card">
          <div className="lbl">2. hitch · lock</div>
          <p>Paste one tag. The lattice locks to that inbox. Nobody else can write. You just write.</p>
        </div>
        <div className="card">
          <div className="lbl">3. live</div>
          <p>Writes gossip over WebRTC. This website uses Æther as its own backend.</p>
        </div>
      </div>

      <h3>Touch a public lattice</h3>
      <p className="muted">Genesis is public on purpose. Strike it. Open another tab. The number is not a server counter.</p>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="lbl">the pulse · PN-counter</div>
          <p className="pulse">{n}</p>
          <button
            className="hit"
            disabled={!gen}
            onClick={async () => {
              try {
                await gen.inc('pulse', 1);
                setN(gen.count('pulse'));
              } catch (e) {
                setErr(String(e.message || e));
              }
            }}
          >
            strike the drum
          </button>
          {err && <p className="err">{err}</p>}
        </div>
        <div className="card">
          <div className="lbl">content-addressed sky</div>
          <Field db={gen} />
          <p className="muted" style={{ marginTop: 8 }}>
            Each key is a star. Peers light up the same sky.
          </p>
        </div>
      </div>

      <h3>It is a theorem, not a machine</h3>
      <div className="eq">
        A ⊔ B = B ⊔ A (commutative)
        <br />
        (A ⊔ B) ⊔ C = A ⊔ (B ⊔ C) (associative)
        <br />
        A ⊔ A = A (idempotent)
        <br />∴ (S, ⊔) is a join-semilattice, and Ω is unique.
      </div>
      <div className="proof">
        <span>
          commutative <b>{th.commutative ? 'yes' : 'no'}</b>
        </span>
        <span>
          associative <b>{th.associative ? 'yes' : 'no'}</b>
        </span>
        <span>
          idempotent <b>{th.idempotent ? 'yes' : 'no'}</b>
        </span>
        <span>
          holds <b>{th.holds ? 'yes' : 'BROKEN'}</b>
        </span>
      </div>

      <h3>Spark is free and already enough. Pay when the firm shows up.</h3>
      <p className="muted">
        Convex free is ~0.5 GB and a million calls. Firebase spark is 20k writes/day. Æther spark is eight backends,
        100k keys, 100k writes/day, 10 MB files — no card, no region. Braid is a firm. Loom is the shop.
      </p>
      <div className="grid" style={{ marginTop: 16 }}>
        {['spark', 'braid', 'loom'].map((p) => {
          const pl = Aether.plans[p];
          return (
            <div className="card" key={p}>
              <div className="lbl">{pl.label}</div>
              <p className="price">{pl.eur ? pl.eur + '€' : 'free'}</p>
              <p className="muted">{pl.blurb}</p>
              <p className="muted">
                {pl.ns === Infinity ? '∞' : pl.ns} ns · {pl.keys === Infinity ? '∞' : pl.keys} keys ·{' '}
                {pl.writes === Infinity ? '∞' : pl.writes} writes/day
                {pl.seats ? ' · ' + (pl.seats === Infinity ? '∞' : pl.seats) + ' seats' : ''}
              </p>
              {p === 'spark' ? (
                <button className="hit" onClick={() => go('in')}>
                  take spark
                </button>
              ) : (
                <button className="hit ghost" onClick={() => go('account')}>
                  {p}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ marginTop: 18 }}>
        A question for the owner? <a href="#/hello">Write on the site</a>. Leave your mail. It shows in the void.
      </p>
    </div>
  );
}

function Snippets({ ns, pass }) {
  const { origin } = useSdk();
  const [tab, setTab] = useState('tag');
  const kit = Aether.kit(ns, { src: origin, passphrase: pass || undefined });
  const tabs = [
    ['tag', '1. one tag'],
    ['js', 'js'],
    ['react', 'react'],
    ['vite', 'vite'],
    ['node', 'node'],
    ['page', 'html file']
  ];
  const body = kit[tab] || kit.tag;
  return (
    <div>
      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={'tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <pre className="snip">{body}</pre>
      <div className="row" style={{ marginTop: 10 }}>
        <Copy btn={body} />
        {tab === 'page' && (
          <button className="ghost" type="button" onClick={() => download('aether-room.html', kit.page, 'text/html')}>
            download html
          </button>
        )}
      </div>
    </div>
  );
}

function Connect() {
  const { ns, setNs, pass, setPass, ticket, hitchNs, busy, origin } = useSdk();
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!ns) setNs(Aether.secret());
  }, []);
  const kit = ns ? Aether.kit(ns, { src: origin, passphrase: pass || undefined }) : null;
  return (
    <div className="page">
      <p className="kicker">hitch any website · 20 seconds</p>
      <h2>Paste one tag. That’s the backend.</h2>
      <p className="lede">
        Generate a secret. Copy the snippet. Same string on every origin. WebRTC does not care which domain you are on.
      </p>
      {!ticket && (
        <p className="muted">
          Not signed in — you’ll hitch as <b>anon</b> (tiny quota). <a href="#/in">Email in</a> for spark, free.
        </p>
      )}
      {ticket && (
        <p className="ok">
          ticket {ticket.plan}
          {ticket.email ? ' · ' + ticket.email : ''}. Hitch will claim this namespace to your inbox.
        </p>
      )}
      <ol className="steps">
        <li>
          <b>Name the lattice</b>
          The name is the API key, the URL, and the lock.
          <div className="row" style={{ marginTop: 10 }}>
            <input value={ns} onChange={(e) => setNs(e.target.value.trim())} style={{ flex: 1 }} spellCheck={false} />
            <button className="ghost" type="button" onClick={() => setNs(Aether.secret())}>
              generate
            </button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="optional passphrase (AES)"
              style={{ flex: 1 }}
            />
          </div>
        </li>
        <li>
          <b>Copy how you want to speak</b>
          HTML tag, Convex-shaped JS, React hooks, Vite, Node keeper, or a whole page. Same Ω.
          {ns && <Snippets ns={ns} pass={pass} />}
        </li>
        <li>
          <b>Open the live room</b>
          This website hitches and locks the namespace. Other devices need your email once; then they write too. Strangers cannot.
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="hit"
              disabled={!!busy || !ns}
              onClick={async () => {
                setErr('');
                try {
                  await hitchNs(ns, pass ? { passphrase: pass } : {});
                  go('room', { ns, p: pass || undefined });
                } catch (e) {
                  setErr(String(e.message || e));
                }
              }}
            >
              {busy || 'open room'}
            </button>
            {kit && <Copy btn={kit.link} label="copy aether:// link" />}
            {kit && <Copy btn={kit.share} label="copy room URL" />}
            {kit && (
              <button className="ghost" type="button" onClick={() => download('aether-room.html', kit.page, 'text/html')}>
                download html
              </button>
            )}
          </div>
          {err && <p className="err">{err}</p>}
        </li>
      </ol>
    </div>
  );
}

function Gate() {
  const { setTicket, setBusy, busy, refreshTicket } = useSdk();
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem('aether.lastEmail') || '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(() => Aether.account.pending());
  const [msg, setMsg] = useState('');
  const [kind, setKind] = useState('');
  const [left, setLeft] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      const p = Aether.account.pending();
      if (!p) {
        setLeft(0);
        return;
      }
      setLeft(Math.max(0, 20 * 60 * 1000 - (Date.now() - p.at)));
    }, 500);
    return () => clearInterval(id);
  }, [pending]);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const otp = q.get('otp');
    const eh = q.get('eh');
    if (!otp) return;
    (async () => {
      setBusy('warming the gate lattice…');
      try {
        const t = await Aether.account.prove({ otp, eh, email: email || undefined });
        setTicket(t);
        setKind('ok');
        setMsg('in. plan ' + t.plan + (t.role === 'admin' ? ' · you are the void' : ''));
        try {
          history.replaceState({}, '', location.pathname + '#/connect');
        } catch {}
        go('connect');
      } catch (e) {
        setKind('err');
        setMsg(String(e.message || e) + ' — type the email you used and the six-digit code.');
      }
      setBusy('');
    })();
  }, []);

  async function send(e) {
    e.preventDefault();
    setBusy('writing a letter into the gate lattice…');
    setMsg('');
    try {
      const r = await Aether.account.send(email);
      setPending(r);
      setKind(r.mailed && r.mailed.ok ? 'ok' : 'err');
      setMsg(
        r.mailed && r.mailed.ok
          ? 'Letter handed to the mail hop. Check inbox and spam. First time: confirm FormSubmit, then send again.'
          : 'The hop did not take it. Open your mail app — or type the code below. The code is the whole proof.'
      );
    } catch (err) {
      setKind('err');
      setMsg(String(err.message || err));
    }
    setBusy('');
  }

  async function prove(e) {
    e.preventDefault();
    setBusy('proving the inbox…');
    try {
      const t = await Aether.account.prove({ email, code });
      setTicket(t);
      await refreshTicket();
      setKind('ok');
      setMsg('in. plan ' + t.plan);
      go('connect');
    } catch (err) {
      setKind('err');
      setMsg(String(err.message || err));
    }
    setBusy('');
  }

  const t = Aether.account.me();
  if (t) {
    return (
      <div className="page">
        <p className="kicker">gate</p>
        <h2>You’re in.</h2>
        <p className="lede">
          Plan <b>{t.plan}</b>. Role {t.role}. No password exists.
        </p>
        <div className="row">
          <button className="hit" onClick={() => go('connect')}>
            hitch a site
          </button>
          <button
            className="hit ghost"
            onClick={() => {
              Aether.account.logout();
              setTicket(null);
            }}
          >
            log out
          </button>
        </div>
      </div>
    );
  }

  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000)
    .toString()
    .padStart(2, '0');

  return (
    <div className="page">
      <p className="kicker">no passwords · a letter is the key</p>
      <h2>Your email is the account.</h2>
      <p className="lede">
        We send a link and a six-digit code. Open either. That is the only time we ask. After that this browser is the
        owner of whatever it hitches.
      </p>
      <form onSubmit={send} className="row" style={{ marginBottom: 18 }}>
        <input
          type="email"
          required
          placeholder="you@somewhere"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="hit" disabled={!!busy}>
          {busy || 'send the letter'}
        </button>
      </form>
      {pending && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="lbl">
            step 2 · open the letter, or type the code {left > 0 ? '· ' + mins + ':' + secs : '· expired, send again'}
          </div>
          <div className="code">{pending.code}</div>
          <p className="muted">
            This code is also in the email. First hop may be a confirmation from FormSubmit — click it, then send again.
            A new tab on another device needs a few seconds for the gate lattice to meet itself.
          </p>
          <div className="row">
            {pending.mailto && (
              <a className="hit ghost" href={pending.mailto}>
                open mail app
              </a>
            )}
            <Copy btn={pending.url} label="copy magic link" />
            <Copy btn={pending.code} label="copy code" />
          </div>
          <form onSubmit={prove} className="row" style={{ marginTop: 14 }}>
            <input
              inputMode="numeric"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
            />
            <button className="hit" disabled={!!busy}>
              enter
            </button>
          </form>
        </div>
      )}
      {msg && <p className={kind}>{msg}</p>}
    </div>
  );
}

function Room() {
  const { ns, setNs, db, hitchNs, pass, setPass, ticket, busy, status } = useSdk();
  const { params } = useRoute();
  const [rows, setRows] = useState([]);
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  const [pulse, setPulse] = useState(0);
  const [people, setPeople] = useState([]);
  const [who, setWho] = useState('');

  useEffect(() => {
    const qn = params.get('ns');
    const qp = params.get('p');
    if (qn && qn !== ns) setNs(qn);
    if (qp && qp !== pass) setPass(qp);
  }, [params]);

  useEffect(() => {
    let un = () => {};
    let un2 = () => {};
    let iv;
    (async () => {
      try {
        let d = db;
        const name = params.get('ns') || ns || Aether.secret();
        const p = params.get('p') || pass;
        if (!d || d.ns !== name) {
          d = await hitchNs(name, p ? { passphrase: p } : {});
        }
        Aether.define({
          messages: {
            list: Aether.query((ctx) => ctx.db.query('messages').order('_creationTime').collect()),
            send: Aether.mutation(async (ctx, args) => {
              const text = String(args.body || '').trim();
              if (!text) return;
              const me = (ctx.auth && ctx.auth.id ? ctx.auth.id : 'anon').slice(0, 8);
              await ctx.db.insert('messages', { body: text.slice(0, 400), author: me });
            })
          }
        });
        un = d.live('messages.list', setRows);
        const tick = () => {
          try {
            setPulse(d.count('pulse'));
            setPeople(d.presence());
            const me = d.auth && d.auth.me();
            setWho(me ? me.id : '');
          } catch {}
        };
        tick();
        un2 = d.watch('', tick);
        iv = setInterval(tick, 4000);
      } catch (e) {
        setErr(String(e.message || e));
      }
    })();
    return () => {
      un();
      un2();
      clearInterval(iv);
    };
  }, [db, ns]);

  const share = ns ? (Aether.share ? Aether.share(ns, pass) : location.origin + '/#/room?ns=' + encodeURIComponent(ns)) : '';

  return (
    <div className="page wide">
      <p className="kicker">live room · this site’s backend is Æther</p>
      <h2>Say something into the lattice.</h2>
      <p className="muted">
        ns <code>{ns || '—'}</code>
        {ticket ? ' · ' + ticket.plan : ' · anon'}
        {status && status.locked ? (status.writer ? ' · locked to you' : ' · locked · read only') : ''}
      </p>
      {status && status.locked && !status.writer && !ticket && (
        <p className="muted">
          This lattice has an owner. <a href="#/in">Email in once</a> on this browser — then it writes without asking
          again. Nobody else can.
        </p>
      )}
      {status && status.locked && !status.writer && ticket && (
        <p className="err">This inbox does not own this lattice. You can read. You cannot write.</p>
      )}
      {status && status.locked && status.writer && (
        <p className="ok">Owner verified on this connection. Writes just work. Strangers are dropped.</p>
      )}
      <div className="row" style={{ margin: '8px 0 16px' }}>
        {share && <Copy btn={share} label="copy room URL" />}
        {ns && <Copy btn={Aether.link(ns, pass)} label="copy aether://" />}
        {db && (
          <button
            className="ghost"
            type="button"
            onClick={() => download((ns || 'lattice') + '.json', JSON.stringify(db.exportCapsule(), null, 2), 'application/json')}
          >
            download capsule
          </button>
        )}
        <label className="ghost">
          restore
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files && e.target.files[0];
              if (!f || !db) return;
              try {
                await db.importCapsule(JSON.parse(await f.text()));
              } catch (ex) {
                setErr(String(ex.message || ex));
              }
            }}
          />
        </label>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="room">
        <div>
          <div className="log">
            {(rows || []).map((r) => (
              <article key={r._id}>
                <div className="who">{r.author || 'anon'}</div>
                <div>{r.body}</div>
              </article>
            ))}
            {!(rows && rows.length) && <p className="muted">empty. the first write creates the room.</p>}
          </div>
          <form
            className="row"
            style={{ marginTop: 12 }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!db || !body.trim()) return;
              try {
                await db.run('messages.send', { body });
                setBody('');
              } catch (ex) {
                setErr(String(ex.message || ex));
              }
            }}
          >
            <input
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={status && status.locked && !status.writer ? 'read only until you email in once' : 'into the mesh…'}
              maxLength={400}
              style={{ flex: 1 }}
              disabled={!!(status && status.locked && !status.writer)}
            />
            <button className="hit" disabled={!!busy || !db || (status && status.locked && !status.writer)}>
              send
            </button>
          </form>
        </div>
        <aside className="card">
          <div className="lbl">replica</div>
          <p className="muted">
            actor {who || '—'}
            <br />
            peers {status ? status.peerCount : 0}
            <br />
            events {status ? status.events : 0}
            <br />
            merkle {status ? status.merkle : '∅'}
            <br />
            servers 0
          </p>
          <div className="lbl" style={{ marginTop: 16 }}>
            presence
          </div>
          <div className="people">
            {(people || []).map((p) => (
              <span key={p.actor}>{p.actor.slice(0, 8)}</span>
            ))}
            {!(people && people.length) && <span>just you</span>}
          </div>
          <div className="lbl" style={{ marginTop: 16 }}>
            pulse
          </div>
          <p className="pulse" style={{ fontSize: 42 }}>
            {pulse}
          </p>
          <button
            className="ghost"
            type="button"
            disabled={!db || (status && status.locked && !status.writer)}
            onClick={async () => {
              try {
                await db.inc('pulse', 1);
                setPulse(db.count('pulse'));
              } catch (ex) {
                setErr(String(ex.message || ex));
              }
            }}
          >
            strike
          </button>
          <div className="lbl" style={{ marginTop: 16 }}>
            signaling
          </div>
          <div className="slog">
            {(status && status.log ? status.log.slice(-12) : []).map((l, i) => (
              <div key={i}>{l.msg}</div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Hello() {
  const { ticket } = useSdk();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => (ticket && ticket.email) || '');
  const [firm, setFirm] = useState((ticket && ticket.firm && ticket.firm.name) || '');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="page">
      <p className="kicker">write the owner · no ticket required</p>
      <h2>Say it on the site. He sees it.</h2>
      <p className="lede">
        Leave your mail. The letter sits on the lattice. The owner writes you back from the void — no hop, no public
        inbox.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg('');
          try {
            await Aether.account.hello({ name, email, firm, body });
            setKind('ok');
            setMsg('On the lattice. The owner will write you.');
            setBody('');
          } catch (err) {
            setKind('err');
            setMsg(String(err.message || err));
          }
          setBusy(false);
        }}
      >
        <div className="grid-2" style={{ marginBottom: 12 }}>
          <input placeholder="your name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="email"
            required
            placeholder="you@somewhere"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input placeholder="firm (optional)" value={firm} onChange={(e) => setFirm(e.target.value)} />
        </div>
        <textarea
          required
          rows={6}
          placeholder="what should the owner know?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ width: '100%', marginBottom: 12 }}
        />
        <div className="row">
          <button className="hit" disabled={busy}>
            {busy ? 'sending…' : 'leave it in the void'}
          </button>
        </div>
      </form>
      {msg && <p className={kind}>{msg}</p>}
    </div>
  );
}

function Account() {
  const { ticket, setTicket, db, refreshTicket } = useSdk();
  const [inv, setInv] = useState(null);
  const [mine, setMine] = useState([]);
  const [owned, setOwned] = useState([]);
  const [firms, setFirms] = useState([]);
  const [firmName, setFirmName] = useState('');
  const [seat, setSeat] = useState('');
  const [msg, setMsg] = useState('');
  const plan = (ticket && Aether.plans[ticket.plan]) || Aether.plans.anon;
  const usedKeys = db && db.meteredKeys ? db.meteredKeys() : 0;
  const usedW = db && db.writesToday ? db.writesToday() : 0;

  useEffect(() => {
    if (!ticket) return;
    (async () => {
      try {
        await Aether.account.open();
        if (Aether.account.owned) setOwned(await Aether.account.owned());
        if (Aether.account.invoices) setMine(Aether.account.invoices());
        if (Aether.account.firm) setFirms(Aether.account.firm.list());
      } catch {}
    })();
  }, [ticket]);

  async function buy(name) {
    setMsg('');
    try {
      const r = await Aether.account.checkout(name);
      setInv(r);
    } catch (e) {
      setMsg(String(e.message || e));
    }
  }

  if (!ticket) {
    return (
      <div className="page">
        <p className="kicker">account</p>
        <h2>Email in first.</h2>
        <button className="hit" onClick={() => go('in')}>
          log in
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <p className="kicker">account · no password</p>
      <h2>{ticket.plan}</h2>
      <p className="muted">
        {ticket.email || ticket.eh} · {ticket.role}
      </p>
      <div className="grid" style={{ margin: '22px 0' }}>
        <div className="card">
          <div className="lbl">keys</div>
          <b>
            {usedKeys} / {plan.keys === Infinity ? '∞' : plan.keys}
          </b>
          <div className="bar">
            <i style={{ width: plan.keys === Infinity ? '2%' : Math.min(100, (usedKeys / plan.keys) * 100) + '%' }} />
          </div>
        </div>
        <div className="card">
          <div className="lbl">writes today</div>
          <b>
            {usedW} / {plan.writes === Infinity ? '∞' : plan.writes}
          </b>
          <div className="bar">
            <i style={{ width: plan.writes === Infinity ? '2%' : Math.min(100, (usedW / plan.writes) * 100) + '%' }} />
          </div>
        </div>
        <div className="card">
          <div className="lbl">namespaces</div>
          <b>
            {owned.length} / {plan.ns === Infinity ? '∞' : plan.ns}
          </b>
        </div>
      </div>
      {owned.length > 0 && (
        <>
          <h3>Your lattices</h3>
          <table>
            <thead>
              <tr>
                <th>namespace</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {owned.map((o) => (
                <tr key={o.ns}>
                  <td className="k">{o.ns}</td>
                  <td>
                    <button className="ghost" type="button" onClick={() => go('room', { ns: o.ns })}>
                      open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3>Firm</h3>
      {ticket.firm ? (
        <p className="muted">
          {ticket.firm.name} · {ticket.firm.role} · members inherit the wider plan
        </p>
      ) : ticket.plan === 'spark' ? (
        <p className="muted">
          Spark is yours alone — already wider than other free plans. Braid (9€) is five seats for a company.
        </p>
      ) : (
        <p className="muted">Name a firm. Invite seats. They hitch with their own email; they inherit your width.</p>
      )}
      {firms.map((f) => (
        <div className="card" key={f.id} style={{ marginBottom: 12 }}>
          <div className="lbl">
            {f.name} · {f.plan} · {(f.members || []).length}/{f.seats || '—'} seats
          </div>
          <table>
            <tbody>
              {(f.members || []).map((m) => (
                <tr key={m.eh}>
                  <td className="k">{m.email || m.eh}</td>
                  <td>{m.role}</td>
                  <td>
                    {((ticket.firm && ticket.firm.role === 'owner') || f.eh === ticket.eh) && m.eh !== ticket.eh && (
                      <button
                        className="ghost"
                        type="button"
                        onClick={async () => {
                          try {
                            await Aether.account.firm.kick(m.eh);
                            setFirms(Aether.account.firm.list());
                            await refreshTicket();
                          } catch (ex) {
                            setMsg(String(ex.message || ex));
                          }
                        }}
                      >
                        kick
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {((ticket.firm && ticket.firm.role === 'owner') || f.eh === ticket.eh) && (
            <form
              className="row"
              style={{ marginTop: 10 }}
              onSubmit={async (e) => {
                e.preventDefault();
                setMsg('');
                try {
                  await Aether.account.firm.invite(seat);
                  setSeat('');
                  setFirms(Aether.account.firm.list());
                  setMsg('seat offered — they email in on their browser, then hitch.');
                } catch (ex) {
                  setMsg(String(ex.message || ex));
                }
              }}
            >
              <input
                type="email"
                required
                placeholder="teammate@firm"
                value={seat}
                onChange={(e) => setSeat(e.target.value)}
              />
              <button className="hit">invite</button>
            </form>
          )}
        </div>
      ))}
      {!firms.length && (Aether.plans[ticket.ownPlan || ticket.plan] || {}).seats >= 2 && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await Aether.account.firm.create(firmName || 'firm');
              await refreshTicket();
              setFirms(Aether.account.firm.list());
            } catch (ex) {
              setMsg(String(ex.message || ex));
            }
          }}
        >
          <input placeholder="firm name" value={firmName} onChange={(e) => setFirmName(e.target.value)} />
          <button className="hit">create firm</button>
        </form>
      )}

      <h2 style={{ fontSize: 28, marginTop: 28 }}>Widen the room</h2>
      <div className="grid">
        {['braid', 'loom'].map((p) => (
          <div className="card" key={p}>
            <div className="lbl">{p}</div>
            <p className="price">{Aether.plans[p].eur}€</p>
            <p className="muted">{Aether.plans[p].blurb}</p>
            <p className="muted">{Aether.plans[p].seats} seats</p>
            <button className="hit" onClick={() => buy(p)}>
              pay {p}
            </button>
          </div>
        ))}
      </div>
      {inv && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="lbl">invoice {inv.invoice.id}</div>
          <p>
            Pay <b>{inv.invoice.eur}€</b> for <b>{inv.invoice.plan}</b>. Quote invoice id <code>{inv.invoice.id}</code>.
            {inv.pay && inv.pay.stripe && (
              <>
                {' '}
                <a href={inv.pay.stripe}>Stripe</a>
              </>
            )}
            {inv.pay && inv.pay.paypal && (
              <>
                {' '}
                <a href={inv.pay.paypal}>PayPal</a>
              </>
            )}
            {inv.pay && inv.pay.crypto && (
              <>
                {' '}
                <a href={inv.pay.crypto}>crypto</a>
              </>
            )}
          </p>
          <button
            className="hit ghost"
            onClick={async () => {
              await Aether.account.markPaid(inv.invoice.id);
              setMsg('marked pending — admin confirms, then the lattice widens.');
            }}
          >
            I paid
          </button>
        </div>
      )}
      {mine.length > 0 && (
        <table style={{ marginTop: 18 }}>
          <thead>
            <tr>
              <th>invoice</th>
              <th>plan</th>
              <th>status</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((i) => (
              <tr key={i.id}>
                <td className="k">{i.id}</td>
                <td>{i.plan}</td>
                <td>{i.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className="ok">{msg}</p>}
      <div className="row" style={{ marginTop: 24 }}>
        <button className="ghost" onClick={() => refreshTicket()}>
          refresh plan
        </button>
        {db && db.auth && (
          <button
            className="ghost"
            onClick={() => download('aether-seed.json', db.auth.exportSeed(), 'application/json')}
          >
            export replica seed
          </button>
        )}
        <button
          className="ghost"
          onClick={() => {
            Aether.account.logout();
            setTicket(null);
          }}
        >
          log out
        </button>
      </div>
    </div>
  );
}

function Admin() {
  const { ticket } = useSdk();
  const [rows, setRows] = useState([]);
  const [inv, setInv] = useState([]);
  const [letters, setLetters] = useState([]);
  const [firms, setFirms] = useState([]);
  const [eh, setEh] = useState('');
  const [plan, setPlan] = useState('spark');
  const [pay, setPay] = useState({ stripe: '', paypal: '', crypto: '' });
  const [msg, setMsg] = useState('');

  async function load() {
    await Aether.account.open();
    setRows(Aether.admin.list());
    setInv(Aether.admin.invoices());
    if (Aether.admin.inbox) setLetters(Aether.admin.inbox());
    if (Aether.admin.firms) setFirms(Aether.admin.firms());
    const cfg = (Aether.gate && Aether.gate.get('~cfg/pay')) || {};
    setPay({ stripe: cfg.stripe || '', paypal: cfg.paypal || '', crypto: cfg.crypto || '' });
  }

  useEffect(() => {
    if (ticket && ticket.role === 'admin') load();
  }, [ticket]);

  if (!ticket || ticket.role !== 'admin') {
    return (
      <div className="page">
        <p className="kicker">void</p>
        <h2>This is not your void.</h2>
        <p className="lede">This void has an owner. Email in if that is you.</p>
        <button className="hit" onClick={() => go('in')}>
          email in
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <p className="kicker">admin · infinite</p>
      <h2>The rest obey.</h2>
      <h3>Inbox · contact the owner</h3>
      {!(letters && letters.length) && <p className="muted">empty. the site hello form writes here.</p>}
      {letters.map((l) => (
        <div className="card" key={l.id} style={{ marginBottom: 10 }}>
          <div className="lbl">
            {l.status || 'open'} · {l.name || 'anon'} · {l.email || l.eh || '—'}
            {l.firm ? ' · ' + l.firm : ''}
          </div>
          <p>{l.body}</p>
          <div className="row">
            {l.email && (
              <a className="ghost" href={'mailto:' + l.email + '?subject=' + encodeURIComponent('re: Æther')}>
                reply
              </a>
            )}
            {l.status !== 'done' && (
              <button
                className="ghost"
                type="button"
                onClick={async () => {
                  await Aether.admin.read(l.id, 'done');
                  load();
                }}
              >
                mark done
              </button>
            )}
          </div>
        </div>
      ))}
      <h3>Firms</h3>
      <table>
        <thead>
          <tr>
            <th>name</th>
            <th>plan</th>
            <th>owner eh</th>
            <th>seats</th>
          </tr>
        </thead>
        <tbody>
          {firms.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td>{f.plan}</td>
              <td className="k">{f.eh}</td>
              <td>
                {(f.members || []).length}/{f.seats || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card" style={{ marginTop: 18 }}>
        <div className="lbl">payment rails</div>
        <div className="row">
          <input placeholder="Stripe link" value={pay.stripe} onChange={(e) => setPay({ ...pay, stripe: e.target.value })} />
          <input placeholder="PayPal" value={pay.paypal} onChange={(e) => setPay({ ...pay, paypal: e.target.value })} />
          <input placeholder="crypto" value={pay.crypto} onChange={(e) => setPay({ ...pay, crypto: e.target.value })} />
          <button
            className="ghost"
            onClick={async () => {
              await Aether.admin.setPay(pay);
              setMsg('saved rails');
            }}
          >
            save
          </button>
        </div>
      </div>
      <div className="row" style={{ margin: '18px 0' }}>
        <input placeholder="email hash" value={eh} onChange={(e) => setEh(e.target.value.trim())} />
        <select value={plan} onChange={(e) => setPlan(e.target.value)}>
          {Object.keys(Aether.plans).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button
          className="hit"
          onClick={async () => {
            await Aether.admin.setPlan(eh, plan);
            load();
          }}
        >
          set plan
        </button>
        <button
          className="ghost"
          onClick={async () => {
            await Aether.admin.ban(eh, 'admin');
            load();
          }}
        >
          ban
        </button>
        <button
          className="ghost"
          onClick={async () => {
            await Aether.admin.unban(eh);
            load();
          }}
        >
          unban
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>eh</th>
            <th>plan</th>
            <th>role</th>
            <th>banned</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.eh} onClick={() => setEh(a.eh)} style={{ cursor: 'pointer' }}>
              <td className="k">{a.eh}</td>
              <td>{a.plan}</td>
              <td>{a.role}</td>
              <td>{a.banned ? 'yes' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 style={{ fontSize: 28, marginTop: 28 }}>invoices</h2>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>plan</th>
            <th>€</th>
            <th>status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {inv.filter(Boolean).map((i) => (
            <tr key={i.id}>
              <td className="k">{i.id}</td>
              <td>{i.plan}</td>
              <td>{i.eur}</td>
              <td>{i.status}</td>
              <td>
                {i.status !== 'paid' && (
                  <button
                    className="ghost"
                    onClick={async () => {
                      await Aether.admin.confirm(i.id);
                      load();
                    }}
                  >
                    confirm
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <p className="ok">{msg}</p>}
    </div>
  );
}

function Docs() {
  const { origin } = useSdk();
  return (
    <div className="page docs">
      <p className="kicker">the dialect</p>
      <h2>Speak Ω like Convex. Host nothing.</h2>
      <p className="lede">Copy a file. Hitch a name. Queries run here, then gossip.</p>

      <h3>1. One tag</h3>
      <pre className="snip">{`<script src="${origin}" data-aether="ae-YOUR-SECRET"></script>`}</pre>
      <p className="muted">
        <code>window.db</code> appears. Same tag on every origin. That is the whole sync setup.
      </p>

      <h3>2. Queries & mutations</h3>
      <pre className="snip">{`Aether.define({
  messages: {
    list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),
    send: Aether.mutation(async (ctx, { body }) => {
      await ctx.db.insert('messages', { body, author: ctx.auth.id.slice(0, 8) });
    })
  }
});
db.live('messages.list', rows => render(rows));
await db.run('messages.send', { body: 'hello' });`}</pre>

      <h3>3. HTML with no further JS</h3>
      <pre className="snip">{`<ul data-ae="messages.list"><template><li>{body}</li></template></ul>
<form data-ae-run="messages.send"><input name="body" /></form>`}</pre>

      <h3>4. React</h3>
      <pre className="snip">{`import { AetherProvider, useQuery, useMutation } from './react.js'
<AetherProvider ns="ae-YOUR-SECRET"><App /></AetherProvider>`}</pre>

      <h3>5. Email in once. Then this connection owns it.</h3>
      <pre className="snip">{`await Aether.account.send('you@somewhere')
await Aether.account.prove({ code: '123456' })
await Aether.hitch(ns)
// first hitch locks the lattice to that inbox and registers this browser as a writer.
// later writes do not re-check email. other actors are dropped.`}</pre>
      <p className="muted">
        One letter per browser. The ticket lives in <code>localStorage</code>. Hitch seals the namespace. Strangers with
        the name can read if they know it; they cannot write. Spark is free. Braid 9€ / loom 29€.
      </p>

      <h3>6. Prove there is no origin API</h3>
      <p className="muted">
        Network tab: GET aether.js, wss trackers, wss mqtt, STUN, optional formsubmit. No fetch to your server. WebRTC
        is chrome://webrtc-internals.
      </p>
      <h3>7. Hello the owner. Firms inherit width.</h3>
      <pre className="snip">{`await Aether.account.hello({ name, email, body: 'we want a keeper' })
await Aether.account.firm.create('acme')
await Aether.account.firm.invite('you@acme')
// member emails in, hitch, refresh → ticket.plan widens to the firm`}</pre>
      <p className="muted">
        Spark is free and already wide. Braid is five seats. Letters land in the admin void. Full notes live in the repo
        README. Capability = the namespace string.
      </p>
    </div>
  );
}

export default function App() {
  const { route } = useRoute();
  const page =
    route === 'connect' ? (
      <Connect />
    ) : route === 'in' ? (
      <Gate />
    ) : route === 'room' ? (
      <Room />
    ) : route === 'account' ? (
      <Account />
    ) : route === 'admin' ? (
      <Admin />
    ) : route === 'docs' ? (
      <Docs />
    ) : route === 'hello' ? (
      <Hello />
    ) : (
      <Home />
    );
  return (
    <Provider>
      <div className="grain" />
      <div className="vignette" />
      <Top />
      {page}
      <Foot />
    </Provider>
  );
}
