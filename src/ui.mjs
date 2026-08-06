/* The page. Everything below runs from a file:// URL with the network unplugged. */

const STORE_KEY = 'passing-notes/reversi/longest';

// Real limits worth measuring a link against. Sources are in the README.
const CARRIERS = [
  { name: 'one GSM-7 SMS segment', limit: 160 },
  { name: 'one post on X', limit: 280 },
  { name: 'a QR code a phone reads across a table (version 10-L, alphanumeric)', limit: 395 },
  { name: 'the old Internet Explorer address bar', limit: 2083 },
];

const el = (id) => document.getElementById(id);

/* localStorage throws on a file:// origin in Chrome. That is a fine thing to happen and a
   terrible thing to swallow, because the rewind guard silently stops working. The state is
   reported on the page either way. */
function openStore() {
  try {
    const probe = '__probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return {
      ok: true,
      read: () => globalThis.localStorage.getItem(STORE_KEY),
      write: (v) => globalThis.localStorage.setItem(STORE_KEY, v),
      clear: () => globalThis.localStorage.removeItem(STORE_KEY),
    };
  } catch (err) {
    const why = String(err && err.name ? err.name : err);
    return { ok: false, why, read: () => null, write: () => {}, clear: () => {} };
  }
}

function describeFit(length) {
  const fits = CARRIERS.filter((c) => length <= c.limit);
  if (fits.length === 0) return `longer than every limit we measured against (${CARRIERS[CARRIERS.length - 1].limit})`;
  return `fits ${fits[0].name} (${fits[0].limit})`;
}

export function startApp(opts = {}) {
  const game = opts.game;
  const store = openStore();
  let session = null;
  let selfWrittenHash = null;
  let lastAuto = [];

  el('storage-state').textContent = store.ok ? 'on' : 'off';
  el('storage-why').textContent = store.ok
    ? 'Your browser lets this page remember the longest game it has seen, so a link that rewinds the game is refused.'
    : `This browser refuses storage for this page (${store.why}), which is normal for a file opened from disk. ` +
      'The rewind guard is OFF. Everything else works.';

  const bound = opts.codeLengthBound(game);
  el('bound-chars').textContent = String(bound.chars);
  el('bound-bits').textContent = String(bound.bits);

  function showError(message) {
    el('error').textContent = message;
    el('error').hidden = message === '';
  }

  function setPending(code) {
    el('pending').hidden = code === null;
    el('pending-code').value = code === null ? '' : code;
  }

  function render() {
    const state = session.state;
    const legal = session.legalMoves();
    const legalSet = new Set(legal);
    const score = game.score(state);

    for (let cell = 0; cell < 64; cell++) {
      const button = el(`cell-${cell}`);
      const disc = state.cells[cell];
      button.dataset.disc = disc === 1 ? 'black' : disc === 2 ? 'white' : 'empty';
      const playable = legalSet.has(cell);
      button.dataset.legal = playable ? 'yes' : 'no';
      button.disabled = !playable;
      button.setAttribute(
        'aria-label',
        `${game.moveName(cell)}, ${button.dataset.disc}${playable ? ', legal move' : ''}`,
      );
    }

    el('score-black').textContent = String(score.black);
    el('score-white').textContent = String(score.white);
    el('legal-count').textContent = String(legal.length);

    if (session.over) {
      const winner = game.winner(state);
      el('turn').textContent = 'game over';
      el('outcome').textContent =
        winner === 0
          ? `Draw, ${score.black} discs each.`
          : `${winner === 1 ? 'Black' : 'White'} wins, ${Math.max(score.black, score.white)} to ${Math.min(score.black, score.white)}.`;
      el('outcome').dataset.winner = winner === 0 ? 'draw' : winner === 1 ? 'black' : 'white';
      el('outcome').hidden = false;
    } else {
      el('turn').textContent = state.turn === 1 ? 'black' : 'white';
      el('outcome').hidden = true;
      el('outcome').dataset.winner = 'none';
      el('outcome').textContent = '';
    }

    const code = session.code;
    const link = session.link(location.href);
    el('code').value = code;
    el('link').value = link;
    el('code-length').textContent = String(code.length);
    el('link-length').textContent = String(link.length);
    el('code-fit').textContent = describeFit(link.length);
    el('digit-count').textContent = String(session.digits.length);

    // Every ply that is not a recorded decision was re-derived by the reader for free.
    el('auto-count').textContent = String(session.history.length - session.digits.length);
    el('ply-count').textContent = String(session.history.length);

    const log = el('autolog');
    log.textContent = '';
    for (const event of lastAuto) {
      const li = document.createElement('li');
      const who = event.by === 1 ? 'Black' : 'White';
      li.textContent =
        event.kind === 'pass'
          ? `${who} had no legal move and passed.`
          : `${who} had only one legal move, ${game.moveName(event.move)}, so it was played automatically.`;
      log.appendChild(li);
    }
    el('autolog-wrap').hidden = lastAuto.length === 0;

    el('hint').textContent = session.over
      ? 'Send the last link so they can see the finish.'
      : `Copy the link and send it to whoever is playing ${state.turn === 1 ? 'Black' : 'White'}.`;

    try {
      history.replaceState(null, '', link);
      selfWrittenHash = new URL(link).hash;
    } catch {
      // replaceState is refused on some file:// origins. Setting the fragment directly still
      // works and only costs a history entry.
      selfWrittenHash = `#g=${code}`;
      location.hash = `g=${code}`;
    }
  }

  function remember() {
    if (!store.ok) return;
    store.write(JSON.stringify(session.digits));
  }

  function storedDigits() {
    if (!store.ok) return null;
    const raw = store.read();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function adopt(next, { auto = [] } = {}) {
    session = next;
    lastAuto = auto;
    showError('');
    setPending(null);
    remember();
    render();
  }

  function loadCode(code, { force = false, quiet = false } = {}) {
    let next;
    try {
      next = opts.Session.fromCode(game, code, { maxCodeLength: opts.maxCodeLength });
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
      setPending(null);
      return false;
    }
    const known = storedDigits();
    if (!force && known && !next.extendsFrom(known)) {
      showError(
        `This link is not a continuation of the game you already have. It has ${next.digits.length} ` +
          `decisions and yours has ${known.length}, and they disagree. Somebody rewound the game, or ` +
          'this is a different game entirely.',
      );
      setPending(code);
      return false;
    }
    const before = session ? session.history.length : 0;
    const grew = !quiet && session && next.extendsFrom(session.digits);
    const auto = grew ? next.history.slice(before) : [];
    adopt(next, { auto: auto.filter((h) => h.kind !== 'move') });
    return true;
  }

  function fresh() {
    store.clear();
    adopt(new opts.Session(game, { maxCodeLength: opts.maxCodeLength }));
  }

  // ---- board
  const board = el('board');
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const cell = row * 8 + col;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell';
      button.id = `cell-${cell}`;
      button.dataset.cell = String(cell);
      button.addEventListener('click', () => {
        const before = session.history.length;
        try {
          session.play(cell);
        } catch (err) {
          showError(err && err.message ? err.message : String(err));
          return;
        }
        lastAuto = session.history.slice(before).filter((h) => h.kind !== 'move');
        showError('');
        remember();
        render();
      });
      board.appendChild(button);
    }
  }

  el('load').addEventListener('click', () => {
    const text = el('paste').value.trim();
    if (text === '') {
      showError('Paste the link or the code they sent you first.');
      return;
    }
    if (loadCode(text)) el('paste').value = '';
  });

  el('accept-anyway').addEventListener('click', () => {
    const code = el('pending-code').value;
    store.clear();
    if (loadCode(code, { force: true })) el('paste').value = '';
  });

  el('new').addEventListener('click', fresh);

  for (const [buttonId, sourceId] of [
    ['copy-link', 'link'],
    ['copy-code', 'code'],
  ]) {
    el(buttonId).addEventListener('click', async () => {
      const value = el(sourceId).value;
      const status = el('copy-status');
      try {
        await navigator.clipboard.writeText(value);
        status.textContent = 'copied';
        return;
      } catch {
        /* fall through to the old way */
      }
      el(sourceId).select();
      const worked = (() => {
        try {
          return document.execCommand('copy');
        } catch {
          return false;
        }
      })();
      status.textContent = worked
        ? 'copied'
        : 'this browser would not let the page copy for you, the box is selected so press ctrl+C';
    });
  }

  addEventListener('hashchange', () => {
    if (location.hash === selfWrittenHash) return;
    if (location.hash.startsWith('#g=')) loadCode(location.hash.slice(3));
  });

  // ---- live mode, deliberately behind a disclosure and off by default
  const honesty = opts.rtcHonesty(opts.iceServers || []);
  el('rtc-honesty').textContent = honesty.summary;
  el('rtc-serverless').textContent = honesty.serverless ? 'yes' : 'no';
  el('rtc-supported').textContent = opts.rtcSupported() ? 'yes' : 'no';

  let peer = null;
  const rtcSay = (message) => {
    el('rtc-status').textContent = message;
  };
  const rtcPeer = () => {
    if (!peer) {
      peer = new opts.ManualPeer({ iceServers: opts.iceServers || [] });
      peer.onState = (s) => rtcSay(`connection ${s}`);
      peer.onOpen = () => {
        rtcSay('connected, moves now travel by themselves');
        peer.send({ kind: 'code', code: session.code });
      };
      peer.onMessage = (msg) => {
        if (msg && msg.kind === 'code') loadCode(msg.code);
      };
    }
    return peer;
  };

  el('rtc-offer').addEventListener('click', async () => {
    try {
      rtcSay('gathering local addresses');
      el('rtc-out').value = await rtcPeer().offer();
      rtcSay('send that blob to the other player, then paste their reply below');
    } catch (err) {
      rtcSay(`could not make an offer: ${err && err.message ? err.message : err}`);
    }
  });

  el('rtc-answer').addEventListener('click', async () => {
    try {
      el('rtc-out').value = await rtcPeer().answer(el('rtc-in').value);
      rtcSay('send that answer back');
    } catch (err) {
      rtcSay(`could not answer: ${err && err.message ? err.message : err}`);
    }
  });

  el('rtc-accept').addEventListener('click', async () => {
    try {
      await rtcPeer().accept(el('rtc-in').value);
      rtcSay('answer accepted, waiting for the channel to open');
    } catch (err) {
      rtcSay(`could not accept: ${err && err.message ? err.message : err}`);
    }
  });

  // ---- first paint
  const fromHash = location.hash.startsWith('#g=') ? location.hash.slice(3) : '';
  session = new opts.Session(game, { maxCodeLength: opts.maxCodeLength });
  if (fromHash) {
    if (!loadCode(fromHash, { quiet: true })) render();
  } else {
    render();
  }
  document.documentElement.dataset.ready = 'yes';
}
