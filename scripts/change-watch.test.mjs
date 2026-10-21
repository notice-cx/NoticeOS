import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createChangeWatch, topicReader } from './change-watch.mjs';

function client() {
  return Object.assign(new EventEmitter(), { frames: [], statusCode: 0, ended: false, destroyed: false,
    setHeader() {}, write(frame) { this.frames.push(frame); return true; },
    end() { this.ended = true; this.emit('close'); }, destroy() { this.destroyed = true; this.emit('close'); },
  });
}

test('a failed topic ends listeners so browsers can resume polling', async () => {
  const watch = createChangeWatch(async () => ({ status: 403, validator: null, times: {} }));
  const page = client();
  try { watch.open(page); await watch.check(); assert.equal(page.ended, true); assert.equal(watch.clients.size, 0); }
  finally { await watch.stop(); }
});

test('watch shutdown cancels a pending read even when an adapter ignores its signal, and cancels a late body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let finish, signal, cancelled = 0, calls = 0;
  const reader = topicReader(request => { calls++; signal = request.signal; return new Promise(resolve => { finish = resolve; }); }, () => 'https://demo.example.com');
  const watch = createChangeWatch(reader), page = client();
  try {
    watch.open(page);
    await watch.stop();
    assert.equal(signal.aborted, true); assert.equal(page.ended, true);
    finish(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { etag: '"a"' } }));
    await new Promise(setImmediate);
    assert.equal(cancelled, 1);
    t.mock.timers.tick(60_000); await watch.check(); assert.equal(calls, 1);
  } finally { await watch.stop(); t.mock.timers.reset(); }
});

test('read deadline releases an uncooperative body cancellation and closes listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let cancelling = false, signal;
  const watch = createChangeWatch(topicReader(async request => {
    signal = request.signal;
    return new Response(new ReadableStream({ cancel() { cancelling = true; return new Promise(() => {}); } }), { headers: { etag: '"a"' } });
  }, () => 'https://demo.example.com'));
  const page = client();
  try {
    watch.open(page); const checking = watch.check(); await new Promise(setImmediate);
    assert.equal(cancelling, true); t.mock.timers.tick(10_000); await checking;
    assert.equal(signal.aborted, true); assert.equal(page.ended, true);
    assert.equal(watch.clients.size, 0);
  } finally { await watch.stop(); t.mock.timers.reset(); }
});

test('last disconnect aborts its generation and a successor never receives its late result', async () => {
  let finish, first = true, staleSignal;
  const watch = createChangeWatch(async (_path, _validator, signal) => {
    if (first) { first = false; staleSignal = signal; await new Promise(resolve => { finish = resolve; }); }
    return { status: 200, validator: signal.aborted ? '"old"' : '"new"', times: {} };
  });
  const old = client(), next = client();
  try {
    watch.open(old); old.emit('close'); assert.equal(staleSignal.aborted, true);
    watch.open(next); const checking = watch.check(); finish(); await checking;
    assert.deepEqual(next.frames, ['retry: 5000\n\n']);
    await watch.check(); assert.deepEqual(next.frames, ['retry: 5000\n\n']);
  } finally { await watch.stop(); }
});

test('a slow client releases its watch instead of growing an unbounded response buffer', async () => {
  const watch = createChangeWatch(async () => ({ status: 200, validator: '"a"', times: {} }));
  const page = client();
  try {
    watch.open(page); await watch.check();
    page.write = () => false;
    // The next 304 writes answer times, exercising stream backpressure.
    await watch.stop();
    const pushed = createChangeWatch(async (_path, validator) => ({ status: validator ? 304 : 200, validator: '"a"', times: { generatedAt: 'now' } }));
    try { pushed.open(page); await pushed.check(); await pushed.check(); assert.equal(page.destroyed, true); assert.equal(pushed.clients.size, 0); }
    finally { await pushed.stop(); }
  } finally { await watch.stop(); }
});
