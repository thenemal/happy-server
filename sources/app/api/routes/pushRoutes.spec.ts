import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

// Adapted from upstream pushRoutes.spec.ts (#9). Upstream stubs socket.io's
// fetchSockets(); this fork tracks connections in eventRouter's in-memory map,
// so tests register fake connections on the real eventRouter instead.

const {
    state,
    dbMock,
    pushSendMock,
    resetState
} = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        tokens: [] as Array<{ id: string; token: string }>,
        sent: [] as Array<{ to: string; title?: string }>,
        ticketOverride: null as null | Array<{ status: 'ok' | 'error'; message?: string; details?: { error?: string } }>,
    };

    const resetState = () => {
        state.sessions = [];
        state.tokens = [];
        state.sent = [];
        state.ticketOverride = null;
    };

    const dbMock = {
        session: {
            findFirst: vi.fn(async ({ where }: any) =>
                state.sessions.find(s => s.id === where.id && s.accountId === where.accountId) ?? null)
        },
        accountPushToken: {
            findMany: vi.fn(async () => state.tokens),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        }
    };

    const pushSendMock = vi.fn(async (messages: Array<{ to: string; title?: string }>) => {
        state.sent.push(...messages);
        return state.ticketOverride ?? messages.map(() => ({ status: 'ok' as const }));
    });

    return { state, dbMock, pushSendMock, resetState };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/files", () => ({ getPublicUrl: vi.fn((path: string) => `https://example.com/${path}`) }));
vi.mock("@/app/push/pushSend", () => ({ sendPushNotifications: pushSendMock }));

// The real eventRouter is used so the production presence rule is exercised
// end to end — a regression in hasActiveUiClient fails these tests.
import { ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { pushRoutes } from "./pushRoutes";

const USER = "user-1";
const SESSION = "session-1";

const registered: ClientConnection[] = [];

function connect(connectionType: ClientConnection['connectionType'], appState?: 'active' | 'background') {
    const socket = { data: appState ? { appState } : {}, emit: () => true } as any;
    const connection = {
        connectionType,
        socket,
        userId: USER,
        sessionId: SESSION,
        machineId: 'machine-1'
    } as ClientConnection;
    eventRouter.addConnection(USER, connection);
    registered.push(connection);
}

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = USER; });
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

async function postPushEvent(app: Fastify, sessionId = SESSION) {
    return app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/push-event`,
        headers: { authorization: 'Bearer t' },
        payload: { kind: 'done', title: 'It is ready!', body: 'session title' }
    });
}

describe('POST /v1/sessions/:sessionId/push-event', () => {
    let app: Fastify;

    beforeEach(async () => {
        resetState();
        state.sessions.push({ id: SESSION, accountId: USER });
        state.tokens.push({ id: 'tok-1', token: 'ExponentPushToken[aaa]' });
        app = await buildApp();
    });

    afterEach(async () => {
        for (const connection of registered.splice(0)) {
            eventRouter.removeConnection(USER, connection);
        }
        await app.close();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('sends and reports the outcome when nothing is connected', async () => {
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, result: 'sent', tokens: 1 });
        expect(state.sent).toHaveLength(1);
    });

    it('sends when the phone is backgrounded while a coding session is live', async () => {
        // The session's own socket and the daemon must not count as the user watching.
        connect('session-scoped');
        connect('machine-scoped');
        connect('user-scoped', 'background');
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('sends when a UI client never reported its app state', async () => {
        connect('user-scoped');
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
    });

    it('suppresses and says so when a UI client is in the foreground', async () => {
        connect('user-scoped', 'active');
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, result: 'suppressed', reason: 'active-ui-client' });
        expect(state.sent).toHaveLength(0);
    });

    it('reports no_tokens instead of claiming success', async () => {
        state.tokens.length = 0;
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'no_tokens' });
        expect(state.sent).toHaveLength(0);
    });

    it('reports partial delivery and prunes unregistered devices', async () => {
        state.tokens.push({ id: 'tok-2', token: 'ExponentPushToken[bbb]' });
        state.ticketOverride = [
            { status: 'ok' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } }
        ];
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'partial', delivered: 1, tokens: 2 });
        expect(dbMock.accountPushToken.deleteMany).toHaveBeenCalledWith({ where: { id: 'tok-2' } });
    });

    it('still sends when the presence check throws', async () => {
        // Fail open: an infrastructure problem must not silence notifications.
        vi.spyOn(eventRouter, 'hasActiveUiClient').mockImplementation(() => { throw new Error('boom'); });
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('reports failed, not partial, when nothing reaches Expo', async () => {
        state.ticketOverride = [{ status: 'error', message: 'Network error' }];
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ result: 'failed' });
    });

    it('404s for a session the caller does not own', async () => {
        const res = await postPushEvent(app, 'someone-elses-session');
        expect(res.statusCode).toBe(404);
        expect(state.sent).toHaveLength(0);
    });

    it('rejects an unknown kind', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/sessions/${SESSION}/push-event`,
            payload: { kind: 'spam', title: 't', body: 'b' }
        });
        expect(res.statusCode).toBe(400);
        expect(state.sent).toHaveLength(0);
    });
});
