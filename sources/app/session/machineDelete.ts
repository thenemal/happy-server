import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteMachineUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";

/**
 * Delete a machine and all its related data.
 * Handles:
 * - Deleting all access keys for the machine
 * - Deleting the machine itself
 * - Sending socket notification to all connected clients
 *
 * Sessions are NOT deleted — they are account-scoped and may be shared across machines.
 *
 * @returns true if deletion was successful, false if machine not found or not owned by user
 */
export async function machineDelete(ctx: Context, machineId: string): Promise<boolean> {
    return await inTx(async (tx) => {
        const machine = await tx.machine.findFirst({
            where: {
                id: machineId,
                accountId: ctx.uid
            }
        });

        if (!machine) {
            log({ module: 'machine-delete', userId: ctx.uid, machineId }, 'Machine not found or not owned by user');
            return false;
        }

        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { machineId, accountId: ctx.uid }
        });
        log({ module: 'machine-delete', userId: ctx.uid, machineId, deletedCount: deletedAccessKeys.count }, `Deleted ${deletedAccessKeys.count} access keys`);

        await tx.machine.delete({ where: { id: machineId } });
        log({ module: 'machine-delete', userId: ctx.uid, machineId }, 'Machine deleted successfully');

        afterTx(tx, async () => {
            const updSeq = await allocateUserSeq(ctx.uid);
            const updatePayload = buildDeleteMachineUpdate(machineId, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return true;
    });
}
