/* src/rtc.mjs, the optional live transport.
 *
 * The peer connection itself needs a browser and is covered by scripts/browser_play.mjs, which
 * connects two real contexts. What is testable here is everything around it: the signalling
 * codec, and the honesty report.
 *
 * rtcHonesty is the load-bearing one. This project's whole claim is "no server", and that claim
 * is false the moment a STUN server is configured. A function whose job is to say so out loud
 * needs a test, because a regression there is not a crash, it is a page that quietly lies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RTC_SIGNAL_VERSION, packSignal, rtcHonesty, rtcSupported, unpackSignal } from '../src/rtc.mjs';

test('rtcSupported reports on the scope it is given, not on the ambient one', () => {
  assert.equal(rtcSupported({}), false);
  assert.equal(rtcSupported({ RTCPeerConnection: function Fake() {} }), true);
  assert.equal(rtcSupported({ RTCPeerConnection: 'not a constructor' }), false);
});

test('with no ICE servers the page is told it is serverless and told the catch', () => {
  const honesty = rtcHonesty([]);
  assert.equal(honesty.serverless, true);
  // The limitation has to be stated, not merely implied by the word "serverless".
  assert.match(honesty.summary, /same network/i);
  assert.match(honesty.summary, /will not connect across the internet/i);
});

test('an undefined or missing server list is treated as no servers', () => {
  for (const input of [undefined, null, []]) {
    assert.equal(rtcHonesty(input).serverless, true);
  }
});

test('WITH an ICE server configured the page must NOT claim to be serverless', () => {
  // If this test ever fails, the page is telling users there is no server while talking to one.
  const honesty = rtcHonesty([{ urls: 'stun:stun.example.invalid:3478' }]);
  assert.equal(honesty.serverless, false);
  assert.match(honesty.summary, /stun:stun\.example\.invalid:3478/);
  assert.match(honesty.summary, /not serverless/i);
});

test('every configured server is named in the summary, including url arrays', () => {
  const honesty = rtcHonesty([
    { urls: ['stun:a.invalid:3478', 'turn:b.invalid:3478'] },
    { urls: 'stun:c.invalid:3478' },
  ]);
  assert.equal(honesty.serverless, false);
  for (const url of ['stun:a.invalid:3478', 'turn:b.invalid:3478', 'stun:c.invalid:3478']) {
    assert.ok(honesty.summary.includes(url), `${url} is configured but not disclosed`);
  }
  assert.match(honesty.summary, /3 ICE server/);
});

test('a signal round trips uncompressed when the runtime has no CompressionStream', async () => {
  const scope = {}; // no CompressionStream, no DecompressionStream
  const signal = { v: RTC_SIGNAL_VERSION, role: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
  const packed = await packSignal(signal, scope);
  assert.equal(packed[0], 'p', 'the prefix must say which encoding was used');
  assert.deepEqual(await unpackSignal(packed, scope), signal);
});

test('a signal round trips compressed when the runtime can compress', async (t) => {
  if (typeof globalThis.CompressionStream !== 'function') {
    assert.fail('this Node build has no CompressionStream, so the compressed path is untested');
  }
  const signal = { v: RTC_SIGNAL_VERSION, role: 'answer', sdp: 'v=0\r\n'.repeat(60) };
  const packed = await packSignal(signal, globalThis);
  assert.equal(packed[0], 'z');
  assert.deepEqual(await unpackSignal(packed, globalThis), signal);
  // Repetitive SDP is exactly what gzip is for, so this should be a real saving.
  const plain = await packSignal(signal, {});
  assert.ok(packed.length < plain.length, `compressed ${packed.length} is not smaller than plain ${plain.length}`);
});

test('the encoding prefix is not a silent fallback: a compressed blob is refused by a runtime that cannot read it', async () => {
  if (typeof globalThis.CompressionStream !== 'function') assert.fail('no CompressionStream here');
  const packed = await packSignal({ v: 1, role: 'offer', sdp: 'v=0\r\n' }, globalThis);
  await assert.rejects(() => unpackSignal(packed, {}), /cannot decompress/);
});

test('a blob that is not a signal is refused rather than half parsed', async () => {
  for (const junk of ['', 'qqqq', 'xAAAA', 'not a blob at all']) {
    await assert.rejects(() => unpackSignal(junk, {}), `${JSON.stringify(junk)} was accepted`);
  }
});

test('whitespace inside a blob survives, because chat apps wrap long lines', async () => {
  const signal = { v: RTC_SIGNAL_VERSION, role: 'offer', sdp: 'v=0\r\ns=-\r\n' };
  const packed = await packSignal(signal, {});
  const wrapped = `${packed.slice(0, 20)}\n  ${packed.slice(20)}  `;
  assert.deepEqual(await unpackSignal(wrapped, {}), signal);
});
