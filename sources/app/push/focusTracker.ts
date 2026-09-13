/**
 * Checks whether the user is actively looking at a Happy UI client
 * (mobile app / web / desktop).
 *
 * "Active" requires positive proof: a `user-scoped` socket that reported
 * `app-state: active`. Coding sessions (`session-scoped`) and the daemon
 * (`machine-scoped`) are not notification surfaces, and a client that never
 * reported its state is unknown rather than present — so we send.
 *
 * State lives on `socket.data.appState`, set by the `app-state` socket event
 * in socket.ts; it disappears with the socket on disconnect.
 *
 * Ported from upstream (#9). Upstream queries socket.io rooms via
 * fetchSockets(); this fork keeps connections in eventRouter's in-memory map
 * (single replica), so the check reads that instead.
 */

import { eventRouter } from "@/app/events/eventRouter";

export async function isUserActive(userId: string): Promise<boolean> {
    return eventRouter.hasActiveUiClient(userId);
}
