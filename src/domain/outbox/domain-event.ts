export type DomainEventEnvelope<
  TEventType extends string = string,
  TData = unknown,
> = {
  eventId: string;
  eventType: TEventType;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: TData;
};

export type MoneyEventPayload = {
  amount: string;
  currency: string;
};

export type WagerTransactionProcessedData = {
  transactionId: string;
  walletId: string;
  kind: 'OPENING' | 'BET' | 'WIN' | 'LOSS';
  status: 'PROCESSED';
  amount: string;
  currency: string;
  observedBalance: string;
};

export type WagerTransactionRejectedData = {
  transactionId: string;
  walletId: string;
  kind: 'BET';
  status: 'REJECTED';
  failureCode: 'INSUFFICIENT_FUNDS';
  amount: string;
  currency: string;
  observedBalance: string;
};

export type WalletBalanceChangedData = {
  walletId: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyEventPayload;
  balanceBefore: MoneyEventPayload;
  balanceAfter: MoneyEventPayload;
  walletVersion: number;
};

export type WagerTransactionProcessedEvent = DomainEventEnvelope<
  'WagerTransactionProcessed',
  WagerTransactionProcessedData
>;

export type WagerTransactionRejectedEvent = DomainEventEnvelope<
  'WagerTransactionRejected',
  WagerTransactionRejectedData
>;

export type WalletBalanceChangedEvent = DomainEventEnvelope<
  'WalletBalanceChanged',
  WalletBalanceChangedData
>;
