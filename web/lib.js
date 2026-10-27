// Small helpers: DOM building, API calls, files, modal, toast.

export function h(tag, attrs = {}, ...kids) {
  const ns = attrs && attrs.svg ? 'http://www.w3.org/2000/svg' : null;
  const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'svg' || v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' && !ns) el.value = v;
    else if (k === 'checked' && !ns) el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return el;
}

export const s = (tag, attrs = {}, ...kids) => h(tag, { ...attrs, svg: true }, ...kids);

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/** Append children, skipping null, undefined and false (Element.append would write them as text). */
export function add(el, ...kids) {
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}

export async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const det = data && data.detail ? data.detail : data;
    const msg = det && det.problems ? det.problems.join('; ') : (typeof det === 'string' ? det : JSON.stringify(det));
    const err = new Error(msg); err.problems = det && det.problems; throw err;
  }
  return data;
}

export function readFile(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsText(file); });
}

export function download(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}

let toastTimer = null;
export function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function modal(content) {
  const m = document.getElementById('modal');
  const body = m.querySelector('.modal-body');
  clear(body).appendChild(content);
  m.hidden = false;
  const close = () => { m.hidden = true; };
  m.querySelector('.modal-close').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  return close;
}

export function dropZone(label, sub, onFiles, accept) {
  const input = h('input', { type: 'file', multiple: true, hidden: true, accept: accept || undefined });
  const zone = h('label', { class: 'drop' }, label, h('span', { class: 'small' }, sub), input);
  input.addEventListener('change', () => { onFiles([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
  return zone;
}

export function store(key, value) {
  try {
    if (value === undefined) { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { return null; }
  return null;
}

export function verdictClass(v) { return (v || '').replace(' ', '-'); }

export function fmtCell(id) { const [f, o] = id.split('@'); return { field: f, obs: o }; }
