import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

// GET /v3/sessions/:id/messages pagination (#15). Clients open a session with
// before_seq=2147483647 (newest page, DESC); the daemon syncs forward with
// after_seq. The fork once ignored before_seq and served the oldest page.

const { state, dbMock } = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        messages: [] as Array<{ id: string; sessionId: string; seq: number }>,
    };

    const dbMock = {
        session: {
            findFirst: vi.fn(async ({ where }: any) =>
                state.sessions.find(s => s.id === where.id && s.accountId === where.accountId) ?? null)
        },
        sessionMessage: {
            findMany: vi.fn(async ({ where, orderBy, take }: any) => {
                const { gt, lt } = where.seq;
                const rows = state.messages
                    .filter(m => m.sessionId === where.sessionId)
                    .filter(m => (gt === undefined || m.seq > gt) && (lt === undefined || m.seq < lt))
                    .sort((a, b) => orderBy.seq === 'desc' ? b.seq - a.seq : a.seq - b.seq)
                    .slice(0, take);
                return rows.map(m => ({
                    ...m,
                    localId: null,
                    content: { t: 'encrypted', c: `m${m.seq}` },
                    createdAt: new Date(0),
                    updatedAt: new Date(0)
                }));
            })
        }
    };

    return { state, dbMock };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/files", () => ({ getPublicUrl: vi.fn((path: string) => `https://example.com/${path}`) }));

import { sessionRoutes } from "./sessionRoutes";

const USER = "user-1";
const SESSION = "session-1";

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = USER; });
    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

async function getMessages(app: Fastify, query: string) {
    const res = await app.inject({ method: 'GET', url: `/v3/sessions/${SESSION}/messages?${query}` });
    return { status: res.statusCode, body: res.json() };
}

const seqs = (body: any) => body.messages.map((m: any) => m.seq);

describe('GET /v3/sessions/:sessionId/messages', () => {
    let app: Fastify;

    beforeEach(async () => {
        state.sessions = [{ id: SESSION, accountId: USER }];
        state.messages = Array.from({ length: 250 }, (_, i) => ({ id: `msg-${i + 1}`, sessionId: SESSION, seq: i + 1 }));
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
        vi.clearAllMocks();
    });

    it('serves the newest page DESC for before_seq=2147483647', async () => {
        const { status, body } = await getMessages(app, 'before_seq=2147483647&limit=100');
        expect(status).toBe(200);
        expect(seqs(body)[0]).toBe(250);
        expect(seqs(body)[99]).toBe(151);
        expect(body.messages).toHaveLength(100);
        expect(body.hasMore).toBe(true);
    });

    it('pages backward to the start and reports hasMore=false at the end', async () => {
        const second = await getMessages(app, 'before_seq=151&limit=100');
        expect(seqs(second.body)[0]).toBe(150);
        expect(second.body.hasMore).toBe(true);

        const last = await getMessages(app, 'before_seq=51&limit=100');
        expect(seqs(last.body)).toEqual(Array.from({ length: 50 }, (_, i) => 50 - i));
        expect(last.body.hasMore).toBe(false);
    });

    it('keeps forward ASC sync for after_seq', async () => {
        const { body } = await getMessages(app, 'after_seq=240&limit=100');
        expect(seqs(body)).toEqual([241, 242, 243, 244, 245, 246, 247, 248, 249, 250]);
        expect(body.hasMore).toBe(false);
    });

    it('defaults to forward from the start with no cursor', async () => {
        const { body } = await getMessages(app, 'limit=3');
        expect(seqs(body)).toEqual([1, 2, 3]);
        expect(body.hasMore).toBe(true);
    });

    it('rejects after_seq and before_seq together', async () => {
        const { status } = await getMessages(app, 'after_seq=1&before_seq=10');
        expect(status).toBe(400);
    });

    it('404s for a session owned by another account', async () => {
        state.sessions = [{ id: SESSION, accountId: 'someone-else' }];
        const { status } = await getMessages(app, 'before_seq=2147483647');
        expect(status).toBe(404);
    });
});
