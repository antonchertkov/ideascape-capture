/* Shared by the page and the service worker: local storage + sending to the private inbox repo. */
const CFG = { owner: 'antonchertkov', repo: 'ideascape-inbox', api: 'https://api.github.com' };

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ideascape-capture', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      d.createObjectStore('outbox', { keyPath: 'id' });
      d.createObjectStore('shared', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function run(store, mode, fn) {
  return openDB().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result);
    t.onerror = t.onabort = () => rej(t.error);
  }));
}
const kvGet = k => run('kv', 'readonly', s => s.get(k));
const kvSet = (k, v) => run('kv', 'readwrite', s => s.put(v, k));
const kvDel = k => run('kv', 'readwrite', s => s.delete(k));
const outboxAll = () => run('outbox', 'readonly', s => s.getAll());
const outboxPut = i => run('outbox', 'readwrite', s => s.put(i));
const outboxDel = id => run('outbox', 'readwrite', s => s.delete(id));
const sharedAll = () => run('shared', 'readonly', s => s.getAll());
const sharedPut = i => run('shared', 'readwrite', s => s.put(i));
const sharedClear = () => run('shared', 'readwrite', s => s.clear());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function blobToB64(b) {
  return new Promise((res, rej) => {
    const f = new FileReader();
    f.onload = () => res(String(f.result).split(',')[1]);
    f.onerror = () => rej(f.error);
    f.readAsDataURL(b);
  });
}
const strToB64 = s => btoa(unescape(encodeURIComponent(s)));

async function putFile(token, path, b64, msg) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${CFG.api}/repos/${CFG.owner}/${CFG.repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, content: b64 }),
    });
    if (r.ok) return;
    if (r.status === 409) { await sleep(400 * (a + 1)); continue; }
    if (r.status === 422) {
      const j = await r.json().catch(() => ({}));
      if (/sha/i.test(j.message || '')) return; // already uploaded by an earlier attempt
    }
    const e = new Error('github ' + r.status);
    e.status = r.status;
    throw e;
  }
  const e = new Error('github conflict');
  e.status = 409;
  throw e;
}

// Images first, idea.json last: the canvas only ingests an idea once its idea.json exists.
async function sendItem(it) {
  const token = await kvGet('token');
  if (!token) { const e = new Error('no-token'); e.status = 401; throw e; }
  const names = [];
  for (let n = 0; n < it.images.length; n++) {
    const t = it.images[n].type || '';
    const ext = t.includes('png') ? 'png' : t.includes('webp') ? 'webp' : 'jpg';
    const name = `img${n + 1}.${ext}`;
    await putFile(token, `inbox/${it.id}/${name}`, await blobToB64(it.images[n]), 'capture: image');
    names.push(name);
  }
  const meta = { v: 1, id: it.id, created: it.created, source: 'phone', text: it.text, images: names, shared: it.shared || null };
  await putFile(token, `inbox/${it.id}/idea.json`, strToB64(JSON.stringify(meta, null, 1)), 'capture: idea');
}

let _flushing = null;
function flushOutbox() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    const items = (await outboxAll()).sort((a, b) => (a.created < b.created ? -1 : 1));
    let sent = 0, err = null;
    for (const it of items) {
      try { await sendItem(it); await outboxDel(it.id); sent++; }
      catch (e) { err = e; break; }
    }
    return { sent, left: (await outboxAll()).length, err };
  })().finally(() => { _flushing = null; });
  return _flushing;
}
