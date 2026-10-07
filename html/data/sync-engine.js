/**
 * The background retry loop that drains the update queue on its own
 * (docs/pwa_design.md → "Delivering Delayed Updates").
 *
 * Exactly one tab runs the loop no matter how many are open: every tab's
 * engine requests the same Web Lock and holds it until the tab closes, so
 * the browser grants it to one tab at a time and promotes a waiting tab
 * when the holder goes away. The election governs only this retry loop —
 * the write path's own immediate delivery attempt still runs in whichever
 * tab enqueued the command, which is safe under the duplicate-delivery
 * rules (→ "Duplicate delivery").
 *
 * Once granted the lock, the engine alternates between delivery attempts
 * and waiting. An attempt that ends with the queue empty puts the engine
 * to sleep until the next wake() call — rechecking on its own every
 * IDLE_RECHECK_DELAY_MS, since a command enqueued from a tab that did not
 * win the election arrives with no wake(); an attempt that leaves a command
 * stuck at the head schedules the next attempt after an exponentially
 * growing delay, doubling from INITIAL_RETRY_DELAY_MS up to
 * MAX_RETRY_DELAY_MS. A wake() — the browser's `online` event or a new
 * command being enqueued — resets the delay to its initial value and
 * triggers an immediate attempt; the third backoff-resetting event, app
 * launch, is simply the engine starting. The delivery work itself is
 * injected (the data layer supplies it), so this module holds only the
 * schedule.
 */

/** The Web Lock name every tab's engine contends for. */
export const SYNC_ENGINE_LOCK_NAME = "mini-notes-sync-engine";

/** The delay before the first retry of a stuck command. */
export const INITIAL_RETRY_DELAY_MS = 30 * 1000;

/** The ceiling the doubling retry delay never exceeds. */
export const MAX_RETRY_DELAY_MS = 2 * 60 * 60 * 1000;

/** How long an idle engine waits before rechecking the queue unprompted. */
export const IDLE_RECHECK_DELAY_MS = 60 * 60 * 1000;

/** attemptDelivery result: the queue is empty; sleep until a wake. */
export const DELIVERY_IDLE = "idle";

/** attemptDelivery result: a command is still stuck; retry after a delay. */
export const DELIVERY_RETRY = "retry";

export class SyncEngine {
    /**
     * locks is the Web Locks API entry point (navigator.locks in the
     * browser); attemptDelivery is an async function that runs one delivery
     * pass over the queue and resolves to DELIVERY_IDLE or DELIVERY_RETRY.
     * A rejection from attemptDelivery is treated as DELIVERY_RETRY, so a
     * failure inside a pass can never stop the engine or skip the backoff.
     */
    constructor(locks, attemptDelivery) {
        this.locks = locks;
        this.attemptDelivery = attemptDelivery;
        this.started = false;
        this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
        this.wakeRequested = false;
        this.wakeResolve = null;
    }

    /**
     * Enters the election: requests the lock, and runs the loop for the
     * rest of the tab's life once granted. Calling again does nothing.
     */
    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.locks.request(SYNC_ENGINE_LOCK_NAME, () => this.runLoop())
            .catch((e) => console.warn("sync engine: the lock request failed:", e));
    }

    /**
     * Resets the backoff and triggers an immediate delivery attempt: a
     * sleeping or backoff-waiting loop is woken now, and a loop that is
     * mid-attempt (or not yet granted the lock) will run one more attempt
     * as soon as it next waits. Safe to call at any time, in every tab —
     * in a tab that never wins the election it has no loop to wake and
     * does nothing lasting.
     */
    wake() {
        this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
        if (this.wakeResolve !== null) {
            this.wakeResolve();
        } else {
            this.wakeRequested = true;
        }
    }

    /** The endless attempt-then-wait loop; runs only in the lock-holding tab. */
    async runLoop() {
        while (true) {
            let result;
            try {
                result = await this.attemptDelivery();
            } catch (e) {
                console.warn("sync engine: a delivery attempt failed:", e);
                result = DELIVERY_RETRY;
            }
            if (result === DELIVERY_IDLE) {
                this.retryDelayMs = INITIAL_RETRY_DELAY_MS;
                await this.waitForWake(IDLE_RECHECK_DELAY_MS);
            } else {
                const delayMs = this.retryDelayMs;
                this.retryDelayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
                await this.waitForWake(delayMs);
            }
        }
    }

    /**
     * Waits until wake() is called or delayMs has passed, whichever comes
     * first. A wake() that arrived while no wait was in progress is
     * consumed here, ending the wait immediately.
     */
    async waitForWake(delayMs) {
        if (this.wakeRequested) {
            this.wakeRequested = false;
            return;
        }
        let timer;
        await new Promise((resolve) => {
            this.wakeResolve = resolve;
            timer = setTimeout(resolve, delayMs);
        });
        this.wakeResolve = null;
        this.wakeRequested = false;
        clearTimeout(timer);
    }
}
