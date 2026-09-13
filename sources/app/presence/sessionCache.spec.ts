import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findUnique, update } = vi.hoisted(() => ({
    findUnique: vi.fn(),
    update: vi.fn()
}));

vi.mock("@/storage/db", () => ({
    db: {
        session: { findUnique, update },
        machine: { findUnique: vi.fn(), update: vi.fn() }
    }
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() }
}));

type ActivityCacheModule = typeof import("./sessionCache");

const SESSION_ID = "session-1";
const USER_ID = "user-1";
const BATCH_INTERVAL = 5 * 1000;
const STOPPED_TTL = 60 * 1000;

describe("activityCache heartbeat suppression", () => {
    let activityCache: ActivityCacheModule["activityCache"];

    beforeEach(async () => {
        // Fake timers must be installed before the module creates its intervals
        vi.useFakeTimers();
        vi.resetModules();
        findUnique.mockReset();
        update.mockReset();
        // lastActiveAt well past UPDATE_THRESHOLD so a fresh heartbeat always queues
        findUnique.mockImplementation(async () => ({
            id: SESSION_ID,
            accountId: USER_ID,
            lastActiveAt: new Date(Date.now() - 2 * 60 * 1000)
        }));
        update.mockResolvedValue({});
        activityCache = (await import("./sessionCache")).activityCache;
    });

    afterEach(() => {
        activityCache.shutdown();
        vi.useRealTimers();
    });

    async function heartbeat(): Promise<boolean> {
        if (!await activityCache.isSessionValid(SESSION_ID, USER_ID)) {
            return false;
        }
        return activityCache.queueSessionUpdate(SESSION_ID, Date.now());
    }

    it("flushes heartbeats as active when the session is not stopped", async () => {
        expect(await heartbeat()).toBe(true);

        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL);

        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0][0]).toMatchObject({
            where: { id: SESSION_ID },
            data: { active: true }
        });
    });

    it("ignores heartbeats after clearSessionUpdates and never flushes active", async () => {
        activityCache.clearSessionUpdates(SESSION_ID);

        expect(await activityCache.isSessionValid(SESSION_ID, USER_ID)).toBe(false);
        expect(activityCache.queueSessionUpdate(SESSION_ID, Date.now())).toBe(false);
        expect(findUnique).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL);

        expect(update).not.toHaveBeenCalled();
    });

    it("drops an update queued before clearSessionUpdates", async () => {
        expect(await heartbeat()).toBe(true);

        activityCache.clearSessionUpdates(SESSION_ID);
        // A heartbeat that was in flight when the session was stopped
        expect(activityCache.queueSessionUpdate(SESSION_ID, Date.now())).toBe(false);

        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL);

        expect(update).not.toHaveBeenCalled();
    });

    it("does not cache a session stopped while its validation was reading the database", async () => {
        let resolveLookup: (value: unknown) => void = () => {};
        findUnique.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve; }));

        const validation = activityCache.isSessionValid(SESSION_ID, USER_ID);
        activityCache.clearSessionUpdates(SESSION_ID);
        resolveLookup({ id: SESSION_ID, accountId: USER_ID, lastActiveAt: new Date(Date.now() - 2 * 60 * 1000) });

        expect(await validation).toBe(false);
        expect(activityCache.queueSessionUpdate(SESSION_ID, Date.now())).toBe(false);

        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL);

        expect(update).not.toHaveBeenCalled();
    });

    it("accepts heartbeats again after resumeSessionUpdates", async () => {
        activityCache.clearSessionUpdates(SESSION_ID);
        expect(await heartbeat()).toBe(false);

        activityCache.resumeSessionUpdates(SESSION_ID);
        expect(await heartbeat()).toBe(true);

        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL);

        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0][0]).toMatchObject({ data: { active: true } });
    });

    it("lifts suppression on its own once the stopped marker expires", async () => {
        activityCache.clearSessionUpdates(SESSION_ID);

        await vi.advanceTimersByTimeAsync(STOPPED_TTL - 1000);
        expect(await heartbeat()).toBe(false);

        await vi.advanceTimersByTimeAsync(2000);
        expect(await heartbeat()).toBe(true);

        await vi.advanceTimersByTimeAsync(BATCH_INTERVAL);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("prunes expired stopped markers in cleanup", async () => {
        activityCache.clearSessionUpdates("stopped-a");
        activityCache.clearSessionUpdates("stopped-b");
        await vi.advanceTimersByTimeAsync(STOPPED_TTL / 2);
        activityCache.clearSessionUpdates("stopped-c");

        await vi.advanceTimersByTimeAsync(STOPPED_TTL / 2 + 1000);
        activityCache.cleanup();

        // Only the marker set after the first two has not expired yet
        const stoppedSessions = (activityCache as unknown as { stoppedSessions: Map<string, number> }).stoppedSessions;
        expect([...stoppedSessions.keys()]).toEqual(["stopped-c"]);
    });
});
