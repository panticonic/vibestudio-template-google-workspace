export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type EventId = Brand<string, "EventId">;
export type TrajectoryId = Brand<string, "TrajectoryId">;
export type BranchId = Brand<string, "BranchId">;
export type TurnId = Brand<string, "TurnId">;
export type MessageId = Brand<string, "MessageId">;
export type BlockId = Brand<string, "BlockId">;
export type InvocationId = Brand<string, "InvocationId">;
export type TaskId = Brand<string, "TaskId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type EnvelopeId = Brand<string, "EnvelopeId">;
export type ChannelId = Brand<string, "ChannelId">;
export type StateHash = Brand<string, "StateHash">;

export function brandId<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
