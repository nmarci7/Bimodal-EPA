// Dialogs: a window over the reasoner for adding or editing one thing. They stack (a
// confirmation over an editor), close with Escape or ×, and ask before throwing edits away.
//
// A wizard is a dialog with steps. Adding something walks through them with Next; editing it shows
// the same steps as tabs, with Save always at hand. Each step says what still stands in the way
// (its problems); Save is offered once no step has any.
import { h, clear, add } from './lib.js';

const stack = [];

document.addEventListener('keydown', (e) => {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); top.requestClose(); return; }
  if (e.key === 'Tab') {
    // keep the focus inside the top dialog
    const f = [...top.box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}, true);

export function isDialogOpen() { return stack.length > 0; }

/** Closes every open window without asking (the tour takes over from a window left open). */
export function closeAllDialogs() { while (stack.length) stack[stack.length - 1].close(); }

/** A button for a dialog footer or body. */
export function button(label, onClick, opts = {}) {
  const cls = ['btn', opts.primary ? 'primary' : '', opts.danger ? 'danger' : '', opts.small ? 'small' : '', opts.ghost ? 'ghost' : ''].filter(Boolean).join(' ');
  return h('button', { class: cls, type: 'button', disabled: opts.disabled || undefined, title: opts.title, onclick: onClick }, label);
}

/**
 * Open a dialog. Returns {box, body, setBody, setActions, setMessage, close, requestClose}.
 * size: sm | md | lg | xl. isDirty(): asked before closing; a dirty dialog asks to discard.
 */
export function openDialog({ title, subtitle, size = 'md', body, actions, onClose, isDirty, className }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
  const bodyEl = h('div', { class: 'dlg-body' });
  const msg = h('div', { class: 'dlg-msg', role: 'alert', hidden: true });
  const foot = h('div', { class: 'dlg-foot' });
  const titleEl = h('h2', { id: titleId }, title);
  const subEl = h('p', { class: 'dlg-sub', hidden: !subtitle }, subtitle || '');
  const xBtn = h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close' }, '×');
  const box = h('div', { class: `dlg dlg-${size}${className ? ` ${className}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'dlg-head' }, h('div', { class: 'dlg-titles' }, titleEl, subEl), xBtn), bodyEl, msg, foot);
  const back = h('div', { class: 'dlg-backdrop' }, box);
  const before = document.activeElement;
  let closed = false;
  const api = {
    box,
    body: bodyEl,
    setTitle(t, sub) { titleEl.textContent = t; if (sub !== undefined) { subEl.textContent = sub || ''; subEl.hidden = !sub; } },
    setBody(node) { clear(bodyEl); if (node) bodyEl.appendChild(node); },
    setActions(btns) { clear(foot); foot.append(...(btns || []).filter(Boolean)); foot.hidden = !(btns || []).filter(Boolean).length; },
    setMessage(content, kind = 'error') {
      clear(msg);
      if (!content) { msg.hidden = true; return; }
      msg.className = `dlg-msg ${kind}`;
      add(msg, content);
      msg.hidden = false;
    },
    close() {
      if (closed) return;
      closed = true;
      back.remove();
      const i = stack.indexOf(api);
      if (i >= 0) stack.splice(i, 1);
      if (onClose) onClose();
      if (before && before.focus && document.contains(before)) before.focus();
    },
    async requestClose() {
      if (isDirty && isDirty()) {
        const ok = await confirmDialog('Close without saving? The changes made in this window are lost.', { title: 'Discard the changes?', okText: 'Discard', danger: true });
        if (!ok) return;
      }
      api.close();
    },
  };
  xBtn.onclick = () => api.requestClose();
  back.addEventListener('mousedown', (e) => { if (e.target === back && !isDirty) api.requestClose(); });
  if (body) api.setBody(body);
  api.setActions(actions || []);
  document.body.appendChild(back);
  stack.push(api);
  requestAnimationFrame(() => {
    // the first thing to type into, else the first choice, else the main button
    const first = box.querySelector('.dlg-body input:not([type=checkbox]):not([type=radio]):not([type=search]), .dlg-body textarea')
      || box.querySelector('.dlg-body select, .dlg-body input[type=radio]:checked, .dlg-body input[type=search]') || box.querySelector('.dlg-foot .btn.primary');
    (first || xBtn).focus();
  });
  return api;
}

/** Ask yes or no. Resolves true for the OK button. */
export function confirmDialog(message, { title = 'Are you sure?', okText = 'OK', cancelText = 'Cancel', danger = false, detail } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog({
      title, size: 'sm',
      body: h('div', { class: 'block' }, h('p', { style: 'margin:0;line-height:1.55' }, message), detail || null),
      onClose: () => { if (!answered) resolve(false); },
    });
    const cancel = button(cancelText, () => { answered = true; resolve(false); d.close(); });
    d.setActions([cancel, button(okText, () => { answered = true; resolve(true); d.close(); }, { primary: !danger, danger })]);
    requestAnimationFrame(() => requestAnimationFrame(() => cancel.focus()));   // the safe answer has the focus
  });
}

/** Show something to read, with one Close button. */
export function infoDialog(title, content, { size = 'md', subtitle, actions = [] } = {}) {
  const d = openDialog({ title, subtitle, size, body: content });
  d.setActions([...actions, button('Close', () => d.close(), { primary: true })]);
  return d;
}

/**
 * A dialog with steps.
 *   mode: 'add' (Back/Next, Save on the last step) | 'edit' (steps are tabs, Save always)
 *   steps: [{id, title, hint?, render(ctx) -> Node, problems?(ctx) -> [text], skip?(ctx) -> bool}]
 *   preview(ctx) -> Node | null      shown under every step
 *   onSave(ctx, {force}) -> true (close) | {problems: [...], canForce} (stay, show them) | false (stay)
 * ctx: {data, update() (redraw preview, problems, buttons), rerender() (redraw the step too), goto(id), dialog}
 */
export function wizard({ title, subtitle, size = 'lg', mode = 'add', steps, preview, onSave, saveLabel, data, startAt, onClose }) {
  const ctx = { data, step: 0, visited: new Set(), dirty: false };
  const dlg = openDialog({ title, subtitle, size, isDirty: () => ctx.dirty, onClose, className: 'wz-dialog' });
  ctx.dialog = dlg;
  const rail = h('ol', { class: 'wz-rail', 'aria-label': 'Steps' });
  const pane = h('div', { class: 'wz-pane' });
  const probs = h('div', { class: 'wz-problems', 'aria-live': 'polite' });
  const prev = h('div', { class: 'wz-preview' });
  dlg.setBody(h('div', { class: `wz ${mode}` }, rail, h('div', { class: 'wz-main' }, pane, probs, prev)));

  const active = () => steps.filter((s) => !(s.skip && s.skip(ctx)));
  const current = () => { const a = active(); ctx.step = Math.max(0, Math.min(ctx.step, a.length - 1)); return a[ctx.step]; };
  const problemsOf = (s) => (s.problems ? s.problems(ctx) : []);
  const allProblems = () => active().flatMap((s) => problemsOf(s).map((t) => ({ step: s, text: t })));

  function drawRail() {
    clear(rail);
    rail.hidden = active().length <= 1;
    active().forEach((s, i) => {
      const n = problemsOf(s).length;
      const reachable = mode === 'edit' || ctx.visited.has(s.id) || i <= ctx.step;
      const li = h('li', { class: `${i === ctx.step ? 'current' : ''}${ctx.visited.has(s.id) && !n ? ' done' : ''}${n && (mode === 'edit' || ctx.visited.has(s.id)) ? ' bad' : ''}` },
        h('button', { type: 'button', disabled: !reachable || undefined, 'aria-current': i === ctx.step ? 'step' : undefined, 'aria-label': `${mode === 'edit' ? '' : `Step ${i + 1}: `}${s.title}${n ? ` (${n} to fix)` : ''}`, onclick: () => { ctx.step = i; drawAll(); } },
          h('span', { class: 'wz-n' }, mode === 'edit' ? '' : String(i + 1)), h('span', { class: 'wz-t' }, s.title),
          n && (mode === 'edit' || ctx.visited.has(s.id)) ? h('span', { class: 'wz-bad', title: `${n} thing(s) to fix` }, String(n)) : null));
      rail.appendChild(li);
    });
  }
  function drawPane() {
    const s = current();
    ctx.visited.add(s.id);
    clear(pane);
    const hint = typeof s.hint === 'function' ? s.hint(ctx) : s.hint;
    add(pane, h('h3', { class: 'wz-title' }, s.title), hint ? h('p', { class: 'hint' }, hint) : null, s.render(ctx));
  }
  function drawProblems() {
    clear(probs);
    const ps = problemsOf(current());
    if (ps.length) probs.append(h('ul', {}, ps.map((t) => h('li', {}, t))));
    probs.hidden = !ps.length;
  }
  function drawPreview() {
    clear(prev);
    const node = preview ? preview(ctx) : null;
    if (node) prev.appendChild(node);
    prev.hidden = !node;
  }
  function drawFooter() {
    const a = active();
    const last = ctx.step >= a.length - 1;
    const stepBad = problemsOf(current()).length > 0;
    const anyBad = allProblems().length > 0;
    const btns = [button('Cancel', () => dlg.requestClose()), h('span', { class: 'spacer' })];
    if (mode === 'add' && ctx.step > 0) btns.push(button('Back', () => { ctx.step--; drawAll(); }));
    if (mode === 'add' && !last) btns.push(button('Next', () => { if (!problemsOf(current()).length) { ctx.step++; drawAll(); } }, { primary: true, disabled: stepBad, title: stepBad ? 'Fix what is listed above first' : undefined }));
    if (mode === 'edit' || last) btns.push(button(saveLabel || (mode === 'add' ? 'Add' : 'Save'), save, { primary: true, disabled: anyBad, title: anyBad ? 'Some steps still need attention (see the numbers on the left)' : undefined }));
    dlg.setActions(btns);
  }
  function drawAll() { drawRail(); drawPane(); drawProblems(); drawPreview(); drawFooter(); }

  async function save(opts = {}) {
    const bad = allProblems();
    if (bad.length) { ctx.step = active().indexOf(bad[0].step); drawAll(); return; }
    dlg.setMessage(null);
    let r;
    try { r = await onSave(ctx, opts); } catch (e) { dlg.setMessage(`Could not save: ${e.message}`); return; }
    if (r === true || r === undefined) { ctx.dirty = false; dlg.close(); return; }
    if (r && r.problems && r.problems.length) {
      dlg.setMessage([h('b', {}, r.title || 'The model check finds new problems with this change:'), h('ul', {}, r.problems.map((t) => h('li', {}, t))),
        h('div', { class: 'inline' }, r.canForce ? button('Save anyway', () => save({ force: true }), { small: true }) : null,
          h('span', { class: 'small muted' }, r.canForce ? 'You can save now and fix the rest later; the badge over the canvas keeps the count.' : ''))]);
    }
  }

  ctx.update = () => { ctx.dirty = true; drawRail(); drawProblems(); drawPreview(); drawFooter(); };
  ctx.rerender = () => { ctx.dirty = true; drawAll(); };
  ctx.goto = (id) => { const i = active().findIndex((s) => s.id === id); if (i >= 0) { ctx.step = i; drawAll(); } };
  if (startAt) { const i = active().findIndex((s) => s.id === startAt); if (i >= 0) ctx.step = i; }
  if (mode === 'edit') active().forEach((s) => ctx.visited.add(s.id));
  drawAll();
  return ctx;
}

// ---------------------------------------------------------------- form controls

/** A labelled control: label above, hint below. */
export function field(label, control, hint, opts = {}) {
  return h('label', { class: `f${opts.wide ? ' wide' : ''}${opts.inline ? ' inline-f' : ''}${opts.detail ? ' detail' : ''}` },
    h('span', { class: 'f-label' }, label), control, hint ? h('span', { class: 'f-hint' }, hint) : null);
}

export function textInput(value, onInput, attrs = {}) {
  const tag = attrs.multiline ? 'textarea' : 'input';
  const { multiline, ...rest } = attrs;
  return h(tag, { value: value ?? '', type: tag === 'input' ? 'text' : undefined, ...rest, oninput: (e) => onInput(e.target.value) });
}

export function numberInput(value, onInput, { min = 0, max = 10, step = 1, ...rest } = {}) {
  return h('input', { type: 'number', min, max, step, value: value ?? '', class: 'num', ...rest,
    oninput: (e) => onInput(e.target.value === '' ? NaN : Number(e.target.value)) });
}

/** options: [[value, label, disabled?]] */
export function selectInput(options, value, onChange, attrs = {}) {
  return h('select', { ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map(([v, t, dis]) => h('option', { value: v, selected: String(v) === String(value ?? '') ? true : undefined, disabled: dis || undefined }, t)));
}

export function checkInput(label, checked, onChange, hint) {
  return h('label', { class: 'f-check' }, h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange(e.target.checked) }),
    h('span', {}, label, hint ? h('span', { class: 'f-hint block' }, hint) : null));
}

/** Big radio choices: [{value, title, text, disabled, why}] */
export function choiceCards(options, value, onChange, name = `c${Math.random().toString(36).slice(2, 7)}`) {
  return h('div', { class: 'choices', role: 'radiogroup' }, options.map((o) => h('label', { class: `choice${o.value === value ? ' on' : ''}${o.disabled ? ' off' : ''}` },
    h('input', { type: 'radio', name, value: o.value, checked: o.value === value, disabled: o.disabled || undefined, onchange: () => onChange(o.value) }),
    h('span', { class: 'choice-t' }, o.title), o.text ? h('span', { class: 'choice-x' }, o.text) : null,
    o.disabled && o.why ? h('span', { class: 'choice-why' }, o.why) : null)));
}

/** A dropdown menu on a button: items [{label, onClick, checked?, disabled?, hint?} | 'sep'], built when opened. */
export function dropdown(label, items, { title, primary } = {}) {
  const btn = h('button', { class: `btn${primary ? ' primary' : ''} menu-btn`, type: 'button', title, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, label, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  const wrap = h('div', { class: 'menu-wrap' }, btn);
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); } };
  const outside = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); btn.focus(); } };
  btn.addEventListener('click', () => {
    if (menu) { closeMenu(); return; }
    const list = typeof items === 'function' ? items() : items;
    menu = h('div', { class: 'menu', role: 'menu' }, list.map((it) => (it === 'sep' ? h('div', { class: 'menu-sep', role: 'separator' })
      : h('button', { type: 'button', role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox', 'aria-checked': it.checked === undefined ? undefined : String(!!it.checked),
        disabled: it.disabled || undefined, onclick: () => { closeMenu(); it.onClick(); } },
      h('span', { class: 'menu-check', 'aria-hidden': 'true' }, it.checked ? '✓' : ''), h('span', { class: 'menu-l' }, it.label), it.hint ? h('span', { class: 'menu-h' }, it.hint) : null))));
    wrap.appendChild(menu);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  });
  return wrap;
}
