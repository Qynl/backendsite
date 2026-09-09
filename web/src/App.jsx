import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Aether, { copyText, go, sdkOrigin } from './lib/sdk.js';

const Ctx = createContext(null);
export const useSdk = () => useContext(Ctx);

function useHash() {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0] || 'home');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
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
    const d = await Aether.hitch(name, extra || {});
    setDb(d);
    setNs(name);
    try {
      localStorage.setItem('aether.ns', name);
    } catch {}
    setStatus(d.status());
    d.onStatus((_t, s) => setStatus(s));
    setBusy('');
    return d;
  }, []);

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

function Top() {
  const { ticket, status } = useSdk();
  const route = useHash();
  const Link = ({ to, children }) => (
    <a href={'#/' + to} className={route === to ? 'on' : ''}>
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
        <em>Æther</em>
      </a>
      <nav className="nav">
        <Link to="connect">connect</Link>
        <Link to="room">room</Link>
        <Link to="in">email in</Link>
        <Link to="account">{ticket ? ticket.plan : 'account'}</Link>
        {ticket && ticket.role === 'admin' && <Link to="admin">admin</Link>}
        {ticket && <span className="chip">{ticket.plan}</span>}
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
        </>
      )}
      {busy && <span>{busy}</span>}
    </div>
  );
}

function Home() {
  const th = Aether.theorem();
  return (
    <div className="page">
      <p className="kicker">a backend that is not a place</p>
      <h1>
        <span className="no">there is</span>
        NO
        <br />
        SERVER
      </h1>
      <p className="lede">
        Convex-shaped queries. Email-only accounts. The database is this browser, and every other browser holding the
        same name. Theorem {th.holds ? 'holds' : 'BROKEN'}.
      </p>
      <div className="row">
        <button className="hit" onClick={() => go('connect')}>
          get a backend
        </button>
        <button className="hit ghost" onClick={() => go('in')}>
          log in with email
        </button>
      </div>
      <div className="grid" style={{ marginTop: 48 }}>
        <div className="card">
          <div className="lbl">1. email</div>
          <p>No password. A letter with a link and a code. That inbox is the account.</p>
        </div>
        <div className="card">
          <div className="lbl">2. hitch</div>
          <p>Paste one tag on any site. Same name = same backend. React, Vite, Node, HTML.</p>
        </div>
        <div className="card">
          <div className="lbl">3. live</div>
          <p>Writes gossip over WebRTC. This website uses Æther as its own backend.</p>
        </div>
      </div>
    </div>
  );
}

function Snippets({ ns, pass }) {
  const { origin } = useSdk();
  const [tab, setTab] = useState('tag');
  const tag = Aether.snippet(origin, ns, pass ? { passphrase: pass } : {});
  const js = `<script src="${origin}"></script>
<script>
  Aether.define({
    messages: {
      list: Aether.query(ctx => ctx.db.query('messages').order('_creationTime').collect()),
      send: Aether.mutation(async (ctx, { body }) => ctx.db.insert('messages', { body }))
    }
  });
  Aether.hitch('${ns}'${pass ? `, { passphrase: '${pass}' }` : ''}).then(db => {
    db.live('messages.list', console.log);
  });
</script>`;
  const vite = `import Aether from './aether.js'

Aether.define({ /* queries + mutations */ })
await Aether.hitch('${ns}')`;
  const node = `node node.js keep ${ns} ./capsule.json`;
  const body = tab === 'js' ? js : tab === 'vite' ? vite : tab === 'node' ? node : tag;
  return (
    <div>
      <div className="tabs">
        {['tag', 'js', 'vite', 'node'].map((t) => (
          <button key={t} className={'tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
            {t === 'tag' ? '1. one tag' : t}
          </button>
        ))}
      </div>
      <pre className="snip">{body}</pre>
      <div className="row" style={{ marginTop: 10 }}>
        <Copy btn={body} />
      </div>
    </div>
  );
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
        setTimeout(() => setOk(false), 1200);
      }}
    >
      {ok ? 'copied' : label || 'copy'}
    </button>
  );
}

function Connect() {
  const { ns, setNs, pass, setPass, ticket, hitchNs, busy } = useSdk();
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!ns) setNs(Aether.secret());
  }, []);
  return (
    <div className="page">
      <p className="kicker">hitch any website · 20 seconds</p>
      <h2>Paste one tag. That’s the backend.</h2>
      <p className="lede">Generate a secret. Copy the snippet. Same string on every origin. WebRTC does not care which domain you are on.</p>
      {!ticket && (
        <p className="muted">
          Not signed in — you’ll hitch as <b>anon</b> (tiny quota). <a href="#/in">Email in</a> for spark, free.
        </p>
      )}
      <ol className="steps">
        <li>
          <b>Name the lattice</b>
          The name is the API key, the URL, and the lock.
          <div className="row" style={{ marginTop: 10 }}>
            <input value={ns} onChange={(e) => setNs(e.target.value.trim())} style={{ flex: 1 }} />
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
          HTML tag, Convex-shaped JS, Vite, or a Node keeper. Same Ω.
          {ns && <Snippets ns={ns} pass={pass} />}
        </li>
        <li>
          <b>Open the live room</b>
          This website hitches the same namespace — Æther is its own backend.
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="hit"
              disabled={!!busy}
              onClick={async () => {
                setErr('');
                try {
                  await hitchNs(ns, pass ? { passphrase: pass } : {});
                  go('room');
                } catch (e) {
                  setErr(String(e.message || e));
                }
              }}
            >
              {busy || 'open room'}
            </button>
            <Copy btn={Aether.link(ns, pass)} label="copy aether:// link" />
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

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const otp = q.get('otp');
    const eh = q.get('eh');
    if (!otp) return;
    (async () => {
      setBusy('opening the letter…');
      try {
        const t = await Aether.account.prove({ otp, eh, email });
        setTicket(t);
        setKind('ok');
        setMsg('in. plan ' + t.plan + (t.role === 'admin' ? ' · you are the void' : ''));
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
      setKind('ok');
      setMsg(
        r.mailed && r.mailed.ok
          ? 'Letter handed to the mail hop. Check inbox and spam. First time: confirm FormSubmit, then send again.'
          : 'The hop did not take it. Send the letter yourself with your mail app — or type the code below.'
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

  return (
    <div className="page">
      <p className="kicker">no passwords · a letter is the key</p>
      <h2>Your email is the account.</h2>
      <p className="lede">
        We send a link and a six-digit code. Open either. Admin is <code>qynlden@tutamail.com</code> and is infinite.
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
          <div className="lbl">step 2 · open the letter, or type the code</div>
          <div className="code">{pending.code}</div>
          <p className="muted">This code is also in the email. First hop may be a confirmation from FormSubmit — click it, then send again.</p>
          <div className="row">
            {pending.mailto && (
              <a className="hit ghost" href={pending.mailto}>
                open mail app
              </a>
            )}
            <Copy btn={pending.url} label="copy magic link" />
          </div>
          <form onSubmit={prove} className="row" style={{ marginTop: 14 }}>
            <input
              inputMode="numeric"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
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
  const { ns, db, hitchNs, pass, ticket, busy, status } = useSdk();
  const [rows, setRows] = useState([]);
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let un = () => {};
    (async () => {
      try {
        let d = db;
        if (!d) {
          const name = ns || Aether.secret();
          d = await hitchNs(name, pass ? { passphrase: pass } : {});
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
      } catch (e) {
        setErr(String(e.message || e));
      }
    })();
    return () => un();
  }, [db]);

  return (
    <div className="page">
      <p className="kicker">live room · this site’s backend is Æther</p>
      <h2>Say something into the lattice.</h2>
      <p className="muted">
        ns <code>{ns || '—'}</code>
        {ticket ? ' · ' + ticket.plan : ' · anon'} · open this URL on another device with the same namespace.
      </p>
      {err && <p className="err">{err}</p>}
      <div className="room" style={{ marginTop: 18 }}>
        <div>
          <div className="log" id="log">
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
            <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="into the mesh…" maxLength={400} style={{ flex: 1 }} />
            <button className="hit" disabled={!!busy || !db}>
              send
            </button>
          </form>
        </div>
        <aside className="card">
          <div className="lbl">replica</div>
          <p className="muted">
            peers {status ? status.peerCount : 0}
            <br />
            events {status ? status.events : 0}
            <br />
            merkle {status ? status.merkle : '∅'}
            <br />
            servers 0
          </p>
          <p className="muted" style={{ marginTop: 12 }}>
            Queries run here, then gossip. There is no Convex cloud.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Account() {
  const { ticket, setTicket, db, refreshTicket } = useSdk();
  const [inv, setInv] = useState(null);
  const [msg, setMsg] = useState('');
  const plan = (ticket && Aether.plans[ticket.plan]) || Aether.plans.anon;
  const usedKeys = db && db.meteredKeys ? db.meteredKeys() : 0;
  const usedW = db && db.writesToday ? db.writesToday() : 0;

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
          <b>{plan.ns === Infinity ? '∞' : plan.ns}</b>
        </div>
      </div>
      <h2 style={{ fontSize: 28 }}>Widen the room</h2>
      <div className="grid">
        {['braid', 'loom'].map((p) => (
          <div className="card" key={p}>
            <div className="lbl">{p}</div>
            <p style={{ fontFamily: 'var(--display)', fontSize: 36, margin: '6px 0' }}>{Aether.plans[p].eur}€</p>
            <p className="muted">{Aether.plans[p].blurb}</p>
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
            Pay <b>{inv.invoice.eur}€</b> for <b>{inv.invoice.plan}</b> to <code>{inv.mail}</code> with this id in the
            subject.
            {inv.pay && inv.pay.stripe && (
              <>
                {' '}
                <a href={inv.pay.stripe}>Stripe</a>
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
      {msg && <p className="ok">{msg}</p>}
      <div className="row" style={{ marginTop: 24 }}>
        <button className="ghost" onClick={() => refreshTicket()}>
          refresh plan
        </button>
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
  const [eh, setEh] = useState('');
  const [plan, setPlan] = useState('spark');
  const [pay, setPay] = useState({ stripe: '', paypal: '', crypto: '' });
  const [msg, setMsg] = useState('');

  async function load() {
    await Aether.account.open();
    setRows(Aether.admin.list());
    setInv(Aether.admin.invoices());
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
        <p className="lede">
          Log in with <code>qynlden@tutamail.com</code>. That inbox is infinite.
        </p>
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
      <div className="card">
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
            <tr key={a.eh}>
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

export default function App() {
  const route = useHash();
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
    ) : (
      <Home />
    );
  return (
    <Provider>
      <div className="grain" />
      <Top />
      {page}
      <Foot />
    </Provider>
  );
}
