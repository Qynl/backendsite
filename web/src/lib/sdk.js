import mod from '@aether';

const Aether = mod && mod.version ? mod : mod && mod.default ? mod.default : mod;
if (typeof window !== 'undefined') window.Aether = Aether;
export default Aether;

export function sdkOrigin() {
  if (typeof location === 'undefined') return './aether.js';
  return location.origin.replace(/\/$/, '') + '/aether.js';
}

export async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

export function go(path, q) {
  let h = '#/' + String(path || '').replace(/^\//, '');
  if (q) {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => {
      if (v != null && v !== '') p.set(k, String(v));
    });
    const s = p.toString();
    if (s) h += '?' + s;
  }
  location.hash = h;
}

export function readHash() {
  const raw = (location.hash || '#/home').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = ((qi === -1 ? raw : raw.slice(0, qi)).split('/')[0] || 'home').trim() || 'home';
  const params = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  try {
    const search = new URLSearchParams(location.search);
    search.forEach((v, k) => {
      if (!params.has(k)) params.set(k, v);
    });
  } catch {}
  return { route: path, params };
}
