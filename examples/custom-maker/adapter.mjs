#!/usr/bin/env node
// adapter.mjs: the reference client for Temporal's CUSTOM MAKER PORT. It is plumbing, not a strategy: it carries the venue's requests to
// your hooks (hooks.mjs) and your answers back as signed firm quotes. See README.md for the port itself.
//
//   MAKER_KEY=0x…  MAKER_ACCOUNT=<ledger account id>  [VENUE_BASE=https://protect.temporal.exchange/api/venue]  node adapter.mjs
//
// The key signs quotes and acts and stays in this process (read from the environment, never written or printed).
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';
import * as hooks from './hooks.mjs';

// ---- units and signing (the port's shapes) -------------------------------------------------------------------------------------------
const k = (t) => keccak_256(utf8ToBytes(t));
const w32 = (v) => hexToBytes(BigInt(v).toString(16).padStart(64, '0'));
const a32 = (a) => hexToBytes(String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0'));
const sign = (digest, key) => { const s = secp256k1.sign(digest, hexToBytes(key.replace(/^0x/, '')), { lowS: true }); return `0x${s.toCompactHex()}${(s.recovery + 27).toString(16)}`; };
export const addressOf = (key) => `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(hexToBytes(key.replace(/^0x/, '')), false).slice(1))).slice(-40)}`;
const DOMAIN_T = k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');

/** Sign-in message: EIP-191 personal_sign. */
export const personalSign = (message, key) => { const m = utf8ToBytes(message); return sign(keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${m.length}`), m)), key); };

/** The firm quote: EIP-712 `Quote` under domain { name "TemporalQuote", version "1", chainId, verifyingContract = the front contract }. */
export const QUOTE_FIELDS = [['maker', 'uint256'], ['taker', 'uint256'], ['asset', 'uint8'], ['side', 'uint8'], ['wing', 'uint8'], ['strikeK', 'uint256'], ['months', 'uint256'], ['qty', 'uint256'], ['priceUSD', 'uint256'], ['expiry', 'uint64'], ['nonce', 'uint64']];
const QUOTE_T = k(`Quote(${QUOTE_FIELDS.map(([n, t]) => `${t} ${n}`).join(',')})`);
export const quoteDigest = (q, { chainId, front }) => keccak_256(concatBytes(utf8ToBytes('\x19\x01'),
  keccak_256(concatBytes(DOMAIN_T, k('TemporalQuote'), k('1'), w32(chainId), a32(front))), keccak_256(concatBytes(QUOTE_T, ...QUOTE_FIELDS.map(([n]) => w32(q[n]))))));
export const signQuote = (key, q, domain) => sign(quoteDigest(q, domain), key);

/** A venue act's intent: EIP-712 `VenueIntent(address user,bytes32 callHash,uint256 nonce,uint256 deadline)` under { VenueLedger, 1, chainId, ledger }. */
const INTENT_T = k('VenueIntent(address user,bytes32 callHash,uint256 nonce,uint256 deadline)');
export const intentDigest = ({ chainId, ledger, user, call, nonce, deadline }) => keccak_256(concatBytes(utf8ToBytes('\x19\x01'),
  keccak_256(concatBytes(DOMAIN_T, k('VenueLedger'), k('1'), w32(chainId), a32(ledger))), keccak_256(concatBytes(INTENT_T, a32(user), keccak_256(hexToBytes(call.slice(2))), w32(nonce), w32(deadline)))));

// ---- translate the port's integers to the plain request your hooks read -------------------------------------------------------------
const ASSETS = ['BTC', 'HYPE'];
// `months` travels as the contract stores it: a rate per year in wad (12 months = 1e18), so months = 12 / (raw / 1e18).
const monthsOf = (raw) => (BigInt(raw) === 0n ? 0 : 12 / (Number(BigInt(raw)) / 1e18));
export const requestOf = (m) => ({ id: m.id, asset: ASSETS[Number(m.asset)] ?? String(m.asset), takerSide: Number(m.side) === 0 ? 'buy' : 'sell', wing: Number(m.wing) === 0 ? 'call' : 'put',
  strikeUSD: Number(BigInt(m.strikeK) / 10n ** 12n) / 1e6, months: monthsOf(m.months), qty: Number(BigInt(m.qty) / 10n ** 12n) / 1e6, deadlineMs: Number(m.deadlineMs) });

// ---- the adapter ---------------------------------------------------------------------------------------------------------------------
export async function run(env = process.env, { signal, hooks: H = hooks } = {}) {
  const KEY = env.MAKER_KEY, ACCOUNT = String(env.MAKER_ACCOUNT ?? '');
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(KEY ?? '') || !/^\d+$/.test(ACCOUNT)) throw new Error('Set MAKER_KEY (0x… private key) and MAKER_ACCOUNT (your ledger account id) in the environment.');
  const API = String(env.VENUE_BASE ?? 'https://protect.temporal.exchange/api/venue').replace(/\/$/, '');
  const LIVE = env.MAKER_LIVE === '1', EXPIRY_S = Number(env.EXPIRY_S ?? 10), MARGIN_MS = Number(env.MARGIN_EVERY_S ?? 60) * 1000;
  const ME = addressOf(KEY);
  const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
  const S = { token: null, connId: null, domain: null, ledger: null, clockMs: 0, stop: false, nonce: BigInt(Date.now()) * 1000n };
  const venueNow = () => Date.now() + S.clockMs;
  const call = async (method, path, body, { token = S.token, timeoutMs = 30000, final = false } = {}) => {
    const res = await fetch(API + path, { method, signal: signal && !final ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && j.ok !== false, j };
  };

  async function signIn() {
    const n = await call('POST', '/auth/nonce', { address: ME }, { token: null });
    if (!n.j.message) throw new Error(`auth/nonce: ${n.j.reason ?? n.status}`);
    const v = await call('POST', '/auth/verify', { address: ME, signature: personalSign(n.j.message, KEY) }, { token: null });
    if (!v.j.token) throw new Error(`auth/verify: ${v.j.reason ?? v.status}`);
    S.token = v.j.token;
    const h = await call('GET', '/chain/health', null, { token: null });
    if (!h.j.front?.address || !h.j.chainId || !h.j.ledger) throw new Error('chain/health has no front, chainId or ledger');
    S.domain = { chainId: Number(h.j.chainId), front: h.j.front.address }; S.ledger = h.j.ledger;
    S.clockMs = Number((await call('GET', '/health', null, { token: null })).j.clockOffsetMs) || 0;
    const reg = await call('POST', '/rfq/maker/register', { transport: 'poll', accounts: [ACCOUNT] });
    if (!reg.ok) throw new Error(`register: ${reg.j.code ?? reg.status} ${reg.j.reason ?? ''}`);
    S.connId = reg.j.id;
    log({ ev: 'registered', account: ACCOUNT, windowMs: reg.j.windowMs });
  }

  /** The account as the venue sees it now. */
  async function readState() {
    const r = await call('GET', `/chain/state?wallet=${ME}`, null, { token: null });
    const accts = r.j.accounts ?? r.j.view?.accounts ?? [];
    const list = Array.isArray(accts) ? accts : Object.values(accts);
    const account = list.find((a) => String(a.id ?? a.ledgerAccountId) === ACCOUNT) ?? null;
    return { account, legs: account?.legs ?? [], perps: account?.perps ?? [], raw: r.j };
  }

  /** Acts: build (the venue encodes the call) -> dry-run -> sign -> submit. Money acts only submit when MAKER_LIVE=1. */
  async function send(act, args = {}) {
    const b = await call('POST', '/chain/build', { act, wallet: ME, account: Number(ACCOUNT), ...args }, { token: null });
    if (!b.ok) return { ok: false, step: 'build', ...b.j };
    const d = await call('POST', '/chain/dryrun', { user: ME, call: b.j.call, extraCashUSD: 0 }, { token: null });
    if (!d.ok) return { ok: false, step: 'dryrun', ...d.j };
    if (!LIVE) { log({ ev: 'act_dry_run', act, args, result: d.j }); return { ok: true, dryRun: true, result: d.j }; }
    const n = await call('GET', `/chain/nonce?wallet=${ME}`, null, { token: null });
    const deadline = Math.floor(Date.now() / 1000) + 120, nonce = n.j.nonce;
    const sig = sign(intentDigest({ chainId: S.domain.chainId, ledger: S.ledger, user: ME, call: b.j.call, nonce, deadline }), KEY);
    const snap = await call('POST', '/chain/snapshot', { call: b.j.call, wallet: ME }, { token: null });
    const r = await call('POST', '/chain/intent', { user: ME, call: b.j.call, nonce: String(nonce), deadline: String(deadline), sig, ...(Array.isArray(snap.j.snaps) ? { snaps: snap.j.snaps } : {}) }, { token: null });
    log({ ev: 'act', act, args, ok: r.ok, reason: r.j.reason ?? null });
    return r.ok ? { ok: true, ...r.j } : { ok: false, step: 'submit', ...r.j };
  }
  const acts = {
    send,
    deposit: (usd) => send('deposit', { usd }), withdraw: (usd) => send('withdraw', { usd }), exit: () => send('exitMaker'), closeAccount: () => send('closeAccountAtFront'),
    makerPerp: async ({ asset, side, size }) => { const r = await call('POST', '/account/makerPerp', { id: Number(ACCOUNT), asset, side, size }); log({ ev: 'makerPerp', asset, side, size, ok: r.ok, code: r.j.code ?? null }); return r.j; },
    quotingOff: async () => { const r = await call('POST', '/account/quoting', { id: null, on: false, ledgerAccountId: Number(ACCOUNT) }, { final: S.stop }); log({ ev: 'quoting_off', ok: r.ok }); return r.j; },
  };

  /** One request -> an answer for the poll, or null (no quote). A late answer is no answer: hooks are raced against the deadline. */
  async function answer(msg) {
    const legsIn = msg.kind === 'package' ? (Array.isArray(msg.legs) ? msg.legs : []) : [msg];
    if (!legsIn.length || legsIn.length > 8 || (msg.kind && msg.kind !== 'package')) return { answer: null, why: 'unsupported_shape' };
    const left = Number(msg.deadlineMs) - venueNow() - 60; // keep 60 ms for the network
    if (left <= 0) return { answer: null, why: 'deadline_passed' };
    const work = (async () => {
      if (!(await H.shouldQuote(S.lastState))) { S.stop = true; return { answer: null, why: 'stop_rule' }; }
      const quotes = [];
      for (const [i, m] of legsIn.entries()) {
        const req = requestOf({ ...m, id: msg.id, deadlineMs: msg.deadlineMs });
        if (!(await H.withinLimits(req, S.lastState))) return { answer: null, why: 'over_limits' };
        const px = await H.price(req);
        if (!(typeof px === 'number' && px > 0 && Number.isFinite(px))) return { answer: null, why: 'no_price' }; // a package is answered whole or not at all
        const q = { maker: ACCOUNT, taker: '0', asset: String(m.asset), side: String(m.side), wing: String(m.wing), strikeK: String(m.strikeK), months: String(m.months), qty: String(m.qty),
          priceUSD: String(Math.max(1, Math.round(px * 1e6))), expiry: String(Math.floor(venueNow() / 1000) + EXPIRY_S), nonce: String(S.nonce++) };
        quotes.push({ leg: i, quote: q, sig: signQuote(KEY, q, S.domain) });
      }
      return { answer: msg.kind === 'package' ? { quotes } : { quote: quotes[0].quote, sig: quotes[0].sig }, why: 'quoted' };
    })();
    return Promise.race([work, new Promise((r) => setTimeout(() => r({ answer: null, why: 'too_slow' }), left))]);
  }

  S.lastState = await signIn().then(readState).catch((e) => { log({ ev: 'start_error', error: String(e.message) }); throw e; });
  const timer = setInterval(async () => {
    try { S.lastState = await readState(); if (!(await H.shouldQuote(S.lastState))) S.stop = true; else await H.manageMargin(S.lastState, acts); } catch (e) { log({ ev: 'margin_error', error: String(e.message) }); }
  }, MARGIN_MS);
  const onStop = () => { S.stop = true; };
  process.once('SIGINT', onStop); process.once('SIGTERM', onStop);

  let answers = [], backoff = 1000;
  while (!S.stop && !signal?.aborted) {
    try {
      if (!S.token || !S.connId) { await signIn(); S.lastState = await readState(); }
      const r = await call('POST', '/rfq/maker/poll', { id: S.connId, answers, waitMs: 20000 }, { timeoutMs: 40000 });
      answers = [];
      if (r.status === 401 || r.status === 404) { S.token = null; S.connId = null; continue; } // session or registration lost: sign in and register again
      if (!r.ok) throw new Error(`poll ${r.status} ${r.j.code ?? ''}`);
      backoff = 1000;
      for (const msg of r.j.requests ?? []) { const a = await answer(msg); answers.push({ rfq: msg.id, answer: a.answer }); log({ ev: 'request', id: msg.id, why: a.why }); if (S.stop) break; }
    } catch (e) {
      if (signal?.aborted || S.stop) break;
      log({ ev: 'error', error: String(e.message).slice(0, 160) });
      await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(30000, backoff * 2);
      S.token = null; S.connId = null;
    }
  }
  // clean stop: hand back what was answered, stop being asked, and (if the stop rule fired) turn quoting off
  clearInterval(timer);
  try { if (S.connId) await call('POST', '/rfq/maker/poll', { id: S.connId, answers, waitMs: 0 }, { timeoutMs: 5000, final: true }); } catch { /* best effort */ }
  try { if (S.stop && S.token) await acts.quotingOff(); } catch { /* best effort */ }
  try { if (S.connId) await call('POST', '/rfq/maker/unregister', { id: S.connId }, { timeoutMs: 5000, final: true }); } catch { /* best effort */ }
  try { if (S.token) await call('POST', '/auth/logout', {}, { timeoutMs: 5000, final: true }); } catch { /* best effort */ }
  log({ ev: 'stopped' });
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) run().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
