# ÆTHER

**A backend that is not a place.**

No origin server holds your data. Æther is a join-semilattice of signed CRDT replicas that live in browsers. Public BitTorrent trackers and MQTT brokers are used only as WebRTC matchmakers. After the handshake, every mutation is gossiped peer-to-peer over DTLS datachannels. Same-origin tabs also sync on `BroadcastChannel`. Each replica persists to IndexedDB.

Any website includes `aether.js`, opens the same namespace string, and they become one backend. The name is the capability.

```html
<script src="./aether.js"></script>
<script>
  const db = await Aether.open('my-secret-universe');
  await db.set('user/ada', { year: 1843 });
  await db.inc('signups', 1);
  db.watch('', (key, value) => console.log(key, value));
</script>
```

## Why this is not fake

- **Data plane:** WebRTC DataChannels + BroadcastChannel. Not HTTP to us. There is no us.
- **Matchmaking only:** `wss://tracker.openwebtorrent.com` and friends exchange SDP. They never see keys or values.
- **Algebra:** LWW-Map over a hybrid logical clock is a join-semilattice (commutative, associative, idempotent). `Aether.theorem()` runs the proof in the page.
- **Identity:** ECDSA P-256 per replica. Forged events drop.
- **Cost:** zero. No account, no API key, no vendor.

## Honest limits

- Symmetric NAT pairs may fail ICE (no TURN on purpose). A connected third peer still gossips.
- If every replica closes, the last IndexedDB copy sleeps until someone reopens the namespace.
- A public name is a public database. Use an unguessable namespace.

## Algebra

```
Ω = ⊔ { replica(p) | p ∈ swarm }
```

Shapiro, Preguiça, Baquero, Zawirski — *Conflict-free Replicated Data Types*, 2011.

## License

Unlicense / public domain. A protocol, not a product.
