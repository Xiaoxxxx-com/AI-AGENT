/** 队列名集中定义，避免中文项目里出现 "heardbeat.tick" 这种手误。 */
export const QUEUE = {
  heartbeatTick: 'heartbeat.tick',
  heartbeatUser: 'heartbeat.user',
  memorySummarize: 'memory.summarize',
  insightReflect: 'insight.reflect',
  insightReflectUser: 'insight.reflect.user',
  proactiveDeliver: 'proactive.deliver',
  noteIndex: 'note.index',
  staleSweep: 'proactive.stale-sweep',
} as const;

export const ALL_QUEUES: string[] = Object.values(QUEUE);

export interface HeartbeatUserJob {
  userId: number;
}

export interface SummarizeJob {
  userId: number;
  sessionId: string;
}

export interface ReflectUserJob {
  userId: number;
}

export interface DeliverJob {
  proactiveId: number;
}

export interface NoteIndexJob {
  noteId: number;
  userId: number;
}
