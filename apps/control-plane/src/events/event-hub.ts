export type ControlPlaneEvent = { type: string; [key: string]: unknown };

export class EventHub {
  private readonly listeners = new Set<(event: ControlPlaneEvent) => void>();

  subscribe(listener: (event: ControlPlaneEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ControlPlaneEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* dashboard listeners are best effort */ }
    }
  }
}
