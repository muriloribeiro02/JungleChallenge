import type { QueryRunner } from 'typeorm';
import { OutboxClaimLockedUntil1761690008000 } from '../../src/infrastructure/database/migrations/009-Outbox_claim_locked_until';
import { CreateInboxMessageTable1761690009000 } from '../../src/infrastructure/database/migrations/010-Create_table_inbox_message';

describe('messaging migrations (unit)', () => {
  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;
    return { queryRunner, queries };
  }

  it('009 adiciona locked_until e índice claimable', async () => {
    const migration = new OutboxClaimLockedUntil1761690008000();
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.up(queryRunner);
    expect(queries[0]).toContain('locked_until');
    expect(queries[1]).toContain('IDX_outbox_message_claimable');
  });

  it('010 cria inbox_message', async () => {
    const migration = new CreateInboxMessageTable1761690009000();
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.up(queryRunner);
    expect(queries[0]).toContain('CREATE TABLE "inbox_message"');
    expect(queries[0]).toContain('PK_inbox_message_id');
  });
});
