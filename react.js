/* ÆTHER React — Convex-shaped hooks. The functions still run on the replica. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.AetherReact = mod;
    if (root.Aether) root.Aether.react = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function getReact() {
    if (typeof React !== 'undefined') return React;
    try {
      return require('react');
    } catch (e) {
      throw new Error('Aether React hooks need React in scope (peer). Vite: import React from "react"');
    }
  }

  const Ctx = { current: null };

  function AetherProvider(props) {
    const R = getReact();
    if (!Ctx.el) Ctx.el = R.createContext(null);
    const { ns, passphrase, children, client } = props;
    const [db, setDb] = R.useState(client || (typeof Aether !== 'undefined' ? Aether.db : null));
    R.useEffect(
      function () {
        if (client) {
          setDb(client);
          return;
        }
        const A = typeof Aether !== 'undefined' ? Aether : null;
        if (!A) return;
        let alive = true;
        const name = ns || (A.db && A.db.ns);
        if (!name) return;
        A.hitch(name, passphrase ? { passphrase: passphrase } : {}).then(function (d) {
          if (alive) setDb(d);
        });
        return function () {
          alive = false;
        };
      },
      [ns, passphrase, client]
    );
    return R.createElement(Ctx.el.Provider, { value: db }, children);
  }

  function useAether() {
    const R = getReact();
    if (!Ctx.el) Ctx.el = R.createContext(null);
    const db = R.useContext(Ctx.el);
    if (db) return db;
    if (typeof Aether !== 'undefined' && Aether.db) return Aether.db;
    throw new Error('useAether() outside <AetherProvider> and no Aether.db yet');
  }

  function useQuery(name, args) {
    const R = getReact();
    const db = useAether();
    const [data, setData] = R.useState(undefined);
    const key = JSON.stringify(args || {});
    R.useEffect(
      function () {
        if (!db || !db.live) return;
        return db.live(name, args || {}, setData);
      },
      [db, name, key]
    );
    return data;
  }

  function useMutation(name) {
    const R = getReact();
    const db = useAether();
    return R.useCallback(
      function (args) {
        return db.run(name, args || {});
      },
      [db, name]
    );
  }

  function useAccount() {
    const R = getReact();
    const A = typeof Aether !== 'undefined' ? Aether : null;
    const [t, setT] = R.useState(A && A.account ? A.account.me() : null);
    R.useEffect(function () {
      if (!A) return;
      const id = setInterval(function () {
        setT(A.account.me());
      }, 800);
      return function () {
        clearInterval(id);
      };
    }, []);
    return t;
  }

  function Authenticated(props) {
    const R = getReact();
    const t = useAccount();
    if (!t) return props.fallback || null;
    return props.children;
  }

  return {
    AetherProvider: AetherProvider,
    useAether: useAether,
    useQuery: useQuery,
    useMutation: useMutation,
    useAccount: useAccount,
    Authenticated: Authenticated
  };
});
