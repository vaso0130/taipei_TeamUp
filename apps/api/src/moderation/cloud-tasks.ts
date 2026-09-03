import type { ModerationQueue, ModerationTarget } from './service.js'

export interface CloudTasksQueueOptions {
  /** Full queue path: projects/<p>/locations/<l>/queues/<q>. */
  queuePath: string
  /** Public URL of POST /internal/moderation/tasks on the API service. */
  targetUrl: string
  /** Shared secret the worker route verifies. */
  taskSecret: string
  tokenProvider: () => Promise<string>
  fetchImpl?: typeof fetch
}

/** Production queue (spec §5.2): moderation never blocks user requests. */
export class CloudTasksModerationQueue implements ModerationQueue {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: CloudTasksQueueOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async enqueue(target: ModerationTarget): Promise<void> {
    const res = await this.fetchImpl(
      `https://cloudtasks.googleapis.com/v2/${this.opts.queuePath}/tasks`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.opts.tokenProvider()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          task: {
            httpRequest: {
              httpMethod: 'POST',
              url: this.opts.targetUrl,
              headers: {
                'content-type': 'application/json',
                'x-task-secret': this.opts.taskSecret,
              },
              body: Buffer.from(JSON.stringify({ target }), 'utf8').toString('base64'),
            },
          },
        }),
      },
    )
    if (!res.ok) {
      throw new Error(`cloud tasks enqueue failed: ${res.status}`)
    }
  }
}
