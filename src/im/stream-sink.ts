export interface StreamSink {
  start(): void;
  onDelta(delta: string): void;
  toolNotice(text: string): Promise<void>;
  finalize(error?: string): Promise<string | null>;
  resetState(): void;
  readonly buffer: string;
}
