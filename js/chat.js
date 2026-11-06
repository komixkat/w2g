/* Chat panel: renders messages, keeps the scroll pinned near the bottom. */

export class Chat {
  constructor({ list, empty, input, send }) {
    this.list = list;
    this.empty = empty;
    this.input = input;
    this.send = send;
    this.count = 0;
  }

  add({ name, text, ts = Date.now(), self = false }) {
    const row = document.createElement('div');
    row.className = 'msg' + (self ? ' msg-self' : '');

    const head = document.createElement('div');
    head.className = 'msg-head';

    const who = document.createElement('span');
    who.className = 'msg-name';
    who.textContent = name;

    const when = document.createElement('span');
    when.className = 'msg-time';
    when.textContent = clock(ts);

    head.append(who, when);

    const body = document.createElement('div');
    body.className = 'msg-text';
    body.textContent = text;

    row.append(head, body);
    this._append(row);
  }

  system(text, kind = '') {
    const row = document.createElement('div');
    row.className = 'msg system' + (kind ? ' ' + kind : '');
    row.textContent = text;
    this._append(row, true);
  }

  clear() {
    this.list.querySelectorAll('.msg').forEach(el => el.remove());
    this.count = 0;
    this._empty(true);
  }

  setEnabled(on) {
    this.input.disabled = !on;
    this.send.disabled = !on;
    this.input.placeholder = on ? 'message…' : 'connect to chat';
    if (!on) this.input.value = '';
  }

  _append(row, system = false) {
    const pinned = this._pinned();

    this._empty(false);
    this.list.append(row);
    this.count++;

    if (system) row.dataset.system = '1';

    if (pinned || system) this.list.scrollTop = this.list.scrollHeight;
  }

  _pinned() {
    const gap = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
    return gap < 80;
  }

  _empty(on) {
    if (!this.empty) return;
    this.empty.classList.toggle('hidden', !on);
  }

  hasMessages() {
    return this.count > 0;
  }
}

function clock(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
