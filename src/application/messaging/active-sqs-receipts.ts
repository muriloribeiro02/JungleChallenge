import type { MessageBus } from '../ports/message-bus';
import type { MessagingLogger } from '../ports/messaging-logger';

type TrackedReceipt = {
  bus: MessageBus;
  receiptHandle: string;
  transportMessageId: string;
};

/**
 * Receipt handles de mensagens SQS recebidas e ainda não ACK/abandonadas.
 * No drain timeout o Host libera visibility=0 (best-effort) sem ACK.
 */
const tracked = new Map<string, TrackedReceipt>();

export function trackSqsReceipt(
  key: string,
  bus: MessageBus,
  receiptHandle: string,
  transportMessageId: string,
): void {
  tracked.set(key, { bus, receiptHandle, transportMessageId });
}

export function untrackSqsReceipt(key: string): void {
  tracked.delete(key);
}

export async function releaseTrackedReceiptsBestEffort(
  logger?: MessagingLogger,
): Promise<number> {
  const entries = [...tracked.entries()];
  tracked.clear();
  let released = 0;

  await Promise.all(
    entries.map(async ([key, entry]) => {
      if (!entry.bus.changeVisibility) {
        return;
      }
      try {
        await entry.bus.changeVisibility(entry.receiptHandle, 0);
        released += 1;
        logger?.info('shutdown.visibility_zero', {
          transportMessageId: entry.transportMessageId,
          receiptKey: key,
        });
      } catch (error) {
        logger?.info('shutdown.visibility_zero_failed', {
          transportMessageId: entry.transportMessageId,
          receiptKey: key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return released;
}

/** Testes. */
export function clearTrackedSqsReceipts(): void {
  tracked.clear();
}

export function trackedSqsReceiptCount(): number {
  return tracked.size;
}
