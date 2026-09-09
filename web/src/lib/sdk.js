import mod from '@aether';

const Aether = mod && mod.version ? mod : mod && mod.default ? mod.default : mod;
if (typeof window !== 'undefined') window.Aether = Aether;
export default Aether;

export function sdkOrigin() {
  if (typeof location === 'undefined') return '';
  return location.origin + '/aether.js';
}

export async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    return false;
  }
}

export function go(path) {
  location.hash = '#/' + String(path || '').replace(/^\//, '');
}
