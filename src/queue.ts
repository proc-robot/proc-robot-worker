import type { Pool } from "./db.js";

export type QueueMessage = {
  /** pgmq ids are bigint; kept as a string to stay exact. */
  msgId: string;
  /** Deliveries so far, this one included. */
  readCount: number;
  enqueuedAt: Date;
  message: unknown;
};

/** One Supabase Queue (pgmq). Messages carry no org scope; jobs do. */
export class Queue {
  constructor(
    private readonly pool: Pool,
    readonly name: string,
  ) {}

  /**
   * Waits up to `maxPollSeconds` for up to `quantity` messages, which stay
   * invisible to other readers for `visibilitySeconds`.
   */
  async read(
    quantity: number,
    visibilitySeconds: number,
    maxPollSeconds: number,
  ): Promise<QueueMessage[]> {
    const { rows } = await this.pool.query<{
      msg_id: string;
      read_ct: number;
      enqueued_at: Date;
      message: unknown;
    }>(
      "select msg_id, read_ct, enqueued_at, message from pgmq.read_with_poll($1, $2, $3, $4, 100)",
      [this.name, visibilitySeconds, quantity, maxPollSeconds],
    );
    return rows.map((row) => ({
      msgId: row.msg_id,
      readCount: row.read_ct,
      enqueuedAt: row.enqueued_at,
      message: row.message,
    }));
  }

  /** Keeps a message invisible for another `seconds` (a running job), or schedules a retry. */
  async setVisibility(msgId: string, seconds: number): Promise<void> {
    await this.pool.query("select * from pgmq.set_vt($1, $2::bigint, $3)", [
      this.name,
      msgId,
      seconds,
    ]);
  }

  /** Done: moves the message to the queue's archive table. */
  async archive(msgId: string): Promise<void> {
    await this.pool.query("select pgmq.archive($1, $2::bigint)", [this.name, msgId]);
  }

  /** Gone for good (it is kept in jobs_dead_letter instead). */
  async delete(msgId: string): Promise<void> {
    await this.pool.query("select pgmq.delete($1, $2::bigint)", [this.name, msgId]);
  }
}
