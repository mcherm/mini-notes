/**
 * Tests for html/sync-engine.js. The Web Locks API and the delivery pass
 * are injected: a fake lock manager records requests and lets a test grant
 * them, and a scripted attemptDelivery serves a fixed list of results.
 * Timers run under node:test's mock clock.
 */

import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";

import {
    DELIVERY_IDLE, DELIVERY_RETRY, IDLE_RECHECK_DELAY_MS,
    INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, SYNC_ENGINE_LOCK_NAME,
    SyncEngine,
} from "../html/sync-engine.js";

/**
 * A stand-in for navigator.locks that records each request and leaves it
 * ungranted until the test grants it.
 */
class FakeLockManager {
    constructor() {
        this.requests = [];
    }

    request(name, callback) {
        let grant;
        const result = new Promise((resolve) => {
            grant = () => resolve(callback());
        });
        this.requests.push({name: name, grant: grant});
        return result;
    }
}

/**
 * An attemptDelivery function serving the scripted results in order, then
 * DELIVERY_IDLE forever (so an exhausted script parks the engine with no
 * pending timers). An entry that is an Error is thrown instead. The number
 * of attempts so far is exposed as `calls`.
 */
function scriptedDelivery(script) {
    const fn = async () => {
        fn.calls += 1;
        const result = script.length > 0 ? script.shift() : DELIVERY_IDLE;
        if (result instanceof Error) {
            throw result;
        }
        return result;
    };
    fn.calls = 0;
    return fn;
}

/**
 * Lets every promise chain that can make progress do so: awaits a real
 * macrotask boundary (setImmediate is not mocked), by which point all
 * pending microtasks have run.
 */
function settle() {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Advances the mock clock, then lets the woken code run. */
async function tick(ms) {
    mock.timers.tick(ms);
    await settle();
}

let locks;

beforeEach(() => {
    mock.timers.enable({apis: ["setTimeout"]});
    locks = new FakeLockManager();
});

afterEach(() => {
    mock.timers.reset();
});

/** Builds an engine on the shared fake locks, started but not yet granted. */
function startEngine(script) {
    const delivery = scriptedDelivery(script);
    const engine = new SyncEngine(locks, delivery);
    engine.start();
    return {engine: engine, delivery: delivery};
}

describe("the election", () => {
    test("start requests the shared lock and does not run before it is granted", async () => {
        const {delivery} = startEngine([]);
        assert.equal(locks.requests.length, 1);
        assert.equal(locks.requests[0].name, SYNC_ENGINE_LOCK_NAME);
        await settle();
        assert.equal(delivery.calls, 0);
    });

    test("a delivery attempt runs as soon as the lock is granted", async () => {
        const {delivery} = startEngine([]);
        locks.requests[0].grant();
        await settle();
        assert.equal(delivery.calls, 1);
    });

    test("calling start again does not request a second lock", async () => {
        const {engine} = startEngine([]);
        engine.start();
        assert.equal(locks.requests.length, 1);
    });

    test("of two started engines, only the granted one runs", async () => {
        const first = startEngine([]);
        const second = startEngine([]);
        locks.requests[0].grant();
        await settle();
        second.engine.wake();
        await settle();
        assert.equal(first.delivery.calls, 1);
        assert.equal(second.delivery.calls, 0);
    });
});

describe("the idle state", () => {
    test("an idle queue sleeps until a wake", async () => {
        const {engine, delivery} = startEngine([DELIVERY_IDLE]);
        locks.requests[0].grant();
        await settle();
        assert.equal(delivery.calls, 1);
        await tick(IDLE_RECHECK_DELAY_MS - 1);
        assert.equal(delivery.calls, 1);
        engine.wake();
        await settle();
        assert.equal(delivery.calls, 2);
    });

    test("an idle queue rechecks unprompted after the idle recheck delay", async () => {
        const {delivery} = startEngine([DELIVERY_IDLE]);
        locks.requests[0].grant();
        await settle();
        assert.equal(delivery.calls, 1);
        await tick(IDLE_RECHECK_DELAY_MS);
        assert.equal(delivery.calls, 2);
    });

    test("a wake during a running attempt causes one more attempt", async () => {
        let finishFirstAttempt;
        let calls = 0;
        const delivery = () => {
            calls += 1;
            if (calls === 1) {
                return new Promise((resolve) => {
                    finishFirstAttempt = () => resolve(DELIVERY_IDLE);
                });
            }
            return Promise.resolve(DELIVERY_IDLE);
        };
        const engine = new SyncEngine(locks, delivery);
        engine.start();
        locks.requests[0].grant();
        await settle();
        engine.wake();
        finishFirstAttempt();
        await settle();
        assert.equal(calls, 2);
    });
});

describe("the backoff", () => {
    test("a stuck command is retried after the initial delay, not before", async () => {
        const {delivery} = startEngine([DELIVERY_RETRY]);
        locks.requests[0].grant();
        await settle();
        assert.equal(delivery.calls, 1);
        await tick(INITIAL_RETRY_DELAY_MS - 1);
        assert.equal(delivery.calls, 1);
        await tick(1);
        assert.equal(delivery.calls, 2);
    });

    test("the delay doubles per failed attempt and stops growing at the cap", async () => {
        const script = [];
        const expectedDelays = [];
        for (let d = INITIAL_RETRY_DELAY_MS; ; d = Math.min(d * 2, MAX_RETRY_DELAY_MS)) {
            script.push(DELIVERY_RETRY);
            expectedDelays.push(d);
            if (d === MAX_RETRY_DELAY_MS && expectedDelays.at(-2) === MAX_RETRY_DELAY_MS) {
                break;
            }
        }
        const {delivery} = startEngine(script);
        locks.requests[0].grant();
        await settle();
        let expectedCalls = 1;
        for (const delay of expectedDelays) {
            assert.equal(delivery.calls, expectedCalls);
            await tick(delay - 1);
            assert.equal(delivery.calls, expectedCalls, `no retry before ${delay}ms elapsed`);
            await tick(1);
            expectedCalls += 1;
            assert.equal(delivery.calls, expectedCalls, `a retry at ${delay}ms`);
        }
    });

    test("a wake during backoff retries immediately and resets the delay", async () => {
        const {engine, delivery} = startEngine(
            [DELIVERY_RETRY, DELIVERY_RETRY, DELIVERY_RETRY, DELIVERY_RETRY]);
        locks.requests[0].grant();
        await settle();
        await tick(INITIAL_RETRY_DELAY_MS);
        await tick(INITIAL_RETRY_DELAY_MS * 2);
        assert.equal(delivery.calls, 3);
        engine.wake();
        await settle();
        assert.equal(delivery.calls, 4);
        await tick(INITIAL_RETRY_DELAY_MS);
        assert.equal(delivery.calls, 5);
    });

    test("an idle attempt resets the delay for the next stuck command", async () => {
        const {engine, delivery} = startEngine(
            [DELIVERY_RETRY, DELIVERY_RETRY, DELIVERY_IDLE, DELIVERY_RETRY]);
        locks.requests[0].grant();
        await settle();
        await tick(INITIAL_RETRY_DELAY_MS);
        await tick(INITIAL_RETRY_DELAY_MS * 2);
        assert.equal(delivery.calls, 3);
        engine.wake();
        await settle();
        assert.equal(delivery.calls, 4);
        await tick(INITIAL_RETRY_DELAY_MS);
        assert.equal(delivery.calls, 5);
    });

    test("a rejected delivery attempt is retried with backoff", async () => {
        const {delivery} = startEngine([new Error("the pass broke")]);
        locks.requests[0].grant();
        await settle();
        assert.equal(delivery.calls, 1);
        await tick(INITIAL_RETRY_DELAY_MS);
        assert.equal(delivery.calls, 2);
    });
});
