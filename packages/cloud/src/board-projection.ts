import { isCoreConflictError } from '@byok/core';
import type { TenantBoundBoard } from './tenant-stores';

/**
 * One-way projection from an already accepted terminal fact into coordination.
 *
 * This module deliberately knows no wire message type or execution-state
 * vocabulary. It can only CAS an existing coordination row one step toward
 * review, and a concurrent board decision wins without retry or overwrite.
 */
export async function projectTerminalToReview(board: TenantBoundBoard, taskId: string): Promise<void> {
  const item = await board.get(taskId);
  if (item === undefined || item.status !== 'in_progress') return;
  try {
    await board.updateStatus({
      itemId: taskId,
      expectedStatus: 'in_progress',
      status: 'in_review',
    });
  } catch (caught) {
    if (isCoreConflictError(caught)) return;
    throw caught;
  }
}
