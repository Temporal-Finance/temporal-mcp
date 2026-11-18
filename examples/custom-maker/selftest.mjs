// selftest.mjs: runs the adapter against a mock venue (no network, no money). `node selftest.mjs`
import http from 'node:http';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { run, addressOf, quoteDigest, requestOf } from './adapter.mjs';
import * as hooks from './hooks.mjs';

const KEY = '0x' + '5a'.repeat(32), ME = addressOf(KEY), FRONT = '0x' + 'f1'.repeat(20);
const recover = (digest, sig) => { const b = hexToBytes(sig.slice(2)); const pub = secp256k1.Signature.fromCompact(bytesToHex(b.slice(0, 64))).addRecoveryBit(b[64] - 27).recoverPublicKey(digest).toRawBytes(false); return `0x${bytesToHex(keccak_256(pub.slice(1))).slice(-40)}`; };
const leg = { asset: '0', side: '0', wing: '0', strikeK: '90000' + '0'.repeat(18), months: String(4n * 10n ** 17n * 10n), qty: '10' + '0'.repeat(16) }; // 3 months? raw 4e18 = 3 months
const polls = [], seen = [];
let batch = 0;
const srv = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const p = new URL(req.url, 'http://x').pathname.replace('/api/venue', ''), body = b ? JSON.parse(b) : {};
  seen.push({ p, body, auth: req.headers.authorization });
  const j = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p === '/auth/nonce') return j({ ok: true, message: 'sign in ' + body.address });
  if (p === '/auth/verify') return j({ ok: true, token: 'tok' + 'e'.repeat(20) });
  if (p === '/chain/health') return j({ ok: true, chainId: 99901, ledger: '0x' + 'ab'.repeat(20), front: { address: FRONT } });
  if (p === '/health') return j({ ok: true, clockOffsetMs: 0 });
  if (p === '/chain/state') return j({ ok: true, accounts: [{ id: 7, kind: 'earn', equityUSD: 50, requirementUSD: 10, cushion: 5 }] });
  if (p === '/rfq/maker/register') return j({ ok: true, id: 'c_7', windowMs: 500 });
  if (p === '/rfq/maker/poll') {
    polls.push(body);
    const now = Date.now();
    if (batch++ === 0) return j({ ok: true, requests: [{ id: 'r1', ...leg, deadlineMs: now + 400 }, { id: 'r2', ...leg, deadlineMs: now - 5 }, { id: 'p1', kind: 'package', legs: [leg, { ...leg, wing: '1' }], deadlineMs: now + 400 }], accepted: 0 });
    return j({ ok: true, requests: [], accepted: 0 });
  }
  j({ ok: true });
}).listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}/api/venue`;
// 1) default hooks quote nothing
let ctl = new AbortController();
const t1 = run({ MAKER_KEY: KEY, MAKER_ACCOUNT: '7', VENUE_BASE: base }, { signal: ctl.signal });
await new Promise((r) => setTimeout(r, 600)); ctl.abort(); await t1;
const answered = polls.flatMap((p) => p.answers ?? []);
assert.deepEqual(answered.map((a) => [a.rfq, a.answer]), [['r1', null], ['r2', null], ['p1', null]], 'default hooks: no quote, an expired request is not answered with a price');
assert.ok(seen.find((s) => s.p === '/rfq/maker/unregister') && seen.find((s) => s.p === '/auth/logout'), 'a clean stop unregisters and ends the session');
assert.ok(seen.filter((s) => s.p === '/rfq/maker/poll').every((s) => s.auth?.startsWith('Bearer ')), 'the token rides as Bearer');
// 1b) a maker's own hooks: priced answers are signed firm quotes, a package is answered whole, a stop rule stops the loop
polls.length = 0; batch = 0;
const mine = { ...hooks, price: async (rq) => (rq.wing === 'call' ? 1234.5 : null), shouldQuote: async () => true };
ctl = new AbortController();
const t2 = run({ MAKER_KEY: KEY, MAKER_ACCOUNT: '7', VENUE_BASE: base }, { signal: ctl.signal, hooks: mine });
await new Promise((r) => setTimeout(r, 600)); ctl.abort(); await t2;
const ans = Object.fromEntries(polls.flatMap((p) => p.answers ?? []).map((a) => [a.rfq, a.answer]));
assert.equal(ans.r1.quote.priceUSD, '1234500000');
assert.equal(recover(quoteDigest(ans.r1.quote, { chainId: 99901, front: FRONT }), ans.r1.sig), ME, 'the quote is signed by the maker key');
assert.equal(ans.p1, null, 'a package with an unpriced leg is no answer');
assert.equal(ans.r2, null, 'a request past its deadline is not answered');
polls.length = 0; batch = 0; seen.length = 0;
await run({ MAKER_KEY: KEY, MAKER_ACCOUNT: '7', VENUE_BASE: base }, { hooks: { ...hooks, shouldQuote: async () => false } });
assert.ok(seen.find((s) => s.p === '/account/quoting' && s.body.on === false), 'a stop rule turns quoting off and the loop ends');
// 2) request shape
const r = requestOf({ id: 'x', ...leg, deadlineMs: 1 });
assert.deepEqual({ a: r.asset, s: r.takerSide, w: r.wing, k: r.strikeUSD, q: r.qty, m: Math.round(r.months * 1e6) / 1e6 }, { a: 'BTC', s: 'buy', w: 'call', k: 90000, q: 0.1, m: 3 });
// 3) the signature recovers to the maker's address over the quote digest
const q = { maker: '7', taker: '0', asset: '0', side: '0', wing: '0', strikeK: leg.strikeK, months: leg.months, qty: leg.qty, priceUSD: '1000000', expiry: '99', nonce: '1' };
const { signQuote } = await import('./adapter.mjs');
assert.equal(recover(quoteDigest(q, { chainId: 99901, front: FRONT }), signQuote(KEY, q, { chainId: 99901, front: FRONT })), ME);
console.log('custom-maker adapter selftest passed');
srv.close();
