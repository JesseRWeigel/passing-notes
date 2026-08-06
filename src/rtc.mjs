/* Optional live mode: WebRTC with the signalling done by hand.
 *
 * READ THIS BEFORE BELIEVING THE WORD "SERVERLESS".
 *
 * The link transport in courier.mjs touches no network at all. This file does. WebRTC needs
 * to learn an address it can be reached on, and it has exactly two ways to do that:
 *
 *   HOST CANDIDATES. The addresses the machine already knows it has. These need no server and
 *   they work when both players are on the same local network. They are useless across the
 *   internet, because the address behind a home router is not reachable from outside it.
 *
 *   SERVER REFLEXIVE CANDIDATES. What a STUN server tells you your public address is. This is
 *   a server. It is somebody else's machine, it can go away, and it sees that you connected.
 *   It carries no game data, and it is still a server, so a page configured with one is not
 *   "no server at all" and this code will not let you claim otherwise. Call rtcHonesty() and
 *   put what it returns in front of the user.
 *
 * Even with STUN, two peers behind symmetric NAT cannot connect without a TURN relay, which
 * is a server that does carry your data. There is no configuration of WebRTC that connects
 * every pair of people with no infrastructure. The link transport has no such asterisk, which
 * is why it is the default here and this is the extra.
 *
 * The signalling itself is genuinely serverless: the offer and the answer are text you copy
 * into whatever chat app you already use.
 */

export const RTC_SIGNAL_VERSION = 1;

export function rtcSupported(scope = globalThis) {
  return typeof scope.RTCPeerConnection === 'function';
}

/* What the page must tell the user, given how it is configured. Deliberately returns prose
   rather than a boolean, because "is this serverless" has a longer answer than yes or no. */
export function rtcHonesty(iceServers = []) {
  if (!iceServers || iceServers.length === 0) {
    return {
      serverless: true,
      summary: 'No ICE servers are configured, so this uses local network addresses only. ' +
        'It connects when both players are on the same network and it will not connect across the internet.',
    };
  }
  const hosts = iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter(Boolean);
  return {
    serverless: false,
    summary: `This is configured with ${hosts.length} ICE server(s): ${hosts.join(', ')}. ` +
      'Those are servers. They carry no game data and they do see that you connected, so a page ' +
      'in this configuration is not serverless.',
  };
}

const SIGNAL_PLAIN = 'p';
const SIGNAL_GZIP = 'z';

function toB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* An SDP blob is mostly repeated boilerplate, so gzip earns its keep here. When the browser
   has no CompressionStream the blob goes out uncompressed under a different prefix, and the
   reader can tell which it got. A silent fallback would make the size measurement a lie. */
export async function packSignal(obj, scope = globalThis) {
  const text = JSON.stringify(obj);
  const raw = new TextEncoder().encode(text);
  if (typeof scope.CompressionStream !== 'function') return SIGNAL_PLAIN + toB64(raw);
  const stream = new Blob([raw]).stream().pipeThrough(new scope.CompressionStream('gzip'));
  const packed = new Uint8Array(await new Response(stream).arrayBuffer());
  return SIGNAL_GZIP + toB64(packed);
}

export async function unpackSignal(blob, scope = globalThis) {
  const trimmed = String(blob).trim().replace(/\s+/g, '');
  const kind = trimmed[0];
  const body = fromB64(trimmed.slice(1));
  if (kind === SIGNAL_PLAIN) return JSON.parse(new TextDecoder().decode(body));
  if (kind !== SIGNAL_GZIP) throw new Error('this does not look like a connection blob');
  if (typeof scope.DecompressionStream !== 'function') {
    throw new Error('this blob is compressed and this browser cannot decompress it');
  }
  const stream = new Blob([body]).stream().pipeThrough(new scope.DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/* One side of a hand signalled peer connection. The host calls offer() then accept(answer).
   The guest calls answer(offerBlob). Both then use send() and onMessage. */
export class ManualPeer {
  constructor({ iceServers = [], scope = globalThis } = {}) {
    if (!rtcSupported(scope)) throw new Error('this browser has no WebRTC');
    this.scope = scope;
    this.iceServers = iceServers;
    this.pc = new scope.RTCPeerConnection({ iceServers });
    this.channel = null;
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onState = () => {};
    this.pc.addEventListener('connectionstatechange', () => this.onState(this.pc.connectionState));
  }

  _wire(channel) {
    this.channel = channel;
    channel.addEventListener('open', () => this.onOpen());
    channel.addEventListener('message', (e) => {
      let parsed;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        // A peer sending something we cannot parse is a real event, so it is reported
        // rather than dropped. Silence here would look exactly like an idle connection.
        this.onMessage({ kind: 'unparseable', raw: String(e.data).slice(0, 200) });
        return;
      }
      this.onMessage(parsed);
    });
  }

  async offer() {
    this._wire(this.pc.createDataChannel('passing-notes', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    return packSignal(
      { v: RTC_SIGNAL_VERSION, role: 'offer', sdp: this.pc.localDescription.sdp },
      this.scope,
    );
  }

  async answer(offerBlob) {
    const signal = await unpackSignal(offerBlob, this.scope);
    if (signal.role !== 'offer') throw new Error('that blob is not an offer');
    this.pc.addEventListener('datachannel', (e) => this._wire(e.channel));
    await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    return packSignal(
      { v: RTC_SIGNAL_VERSION, role: 'answer', sdp: this.pc.localDescription.sdp },
      this.scope,
    );
  }

  async accept(answerBlob) {
    const signal = await unpackSignal(answerBlob, this.scope);
    if (signal.role !== 'answer') throw new Error('that blob is not an answer');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
  }

  send(obj) {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('the connection is not open');
    }
    this.channel.send(JSON.stringify(obj));
  }

  close() {
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
