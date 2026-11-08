/* Chat panel: renders messages, keeps the scroll pinned near the bottom. */

export class Chat {
  constructor({ list, input, send }) {
    this.list = list;
    this.input = input;
    this.send = send;
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

    const pinned = this._pinned();
    this.list.append(row);
    if (pinned) this.list.scrollTop = this.list.scrollHeight;
  }

  clear() {
    this.list.replaceChildren();
  }

  setEnabled(on) {
    this.input.disabled = !on;
    this.send.disabled = !on;
    if (!on) this.input.value = '';
  }

  _pinned() {
    const gap = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight;
    return gap < 80;
  }
}

function clock(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
