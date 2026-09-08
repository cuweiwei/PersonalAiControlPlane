export type Point3 = [number, number, number];

/** Distance-based paths avoid rushing long segments or teleporting at corners. */
export function alongPath(points: Point3[], distance: number): { position: Point3; heading: number; length: number } {
  if (!points.length) return { position: [0, 0, 0], heading: 0, length: 0 };
  const lengths = points.slice(1).map((p, i) => Math.hypot(...p.map((v, axis) => v - points[i][axis])));
  const length = lengths.reduce((sum, value) => sum + value, 0);
  let left = Math.max(0, Math.min(Number.isFinite(distance) ? distance : 0, length));
  let heading = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (!lengths[i]) continue;
    const from = points[i], to = points[i + 1]; heading = Math.atan2(from[0] - to[0], from[2] - to[2]);
    if (left <= lengths[i]) return { position: from.map((v, axis) => v + (to[axis] - v) * left / lengths[i]) as Point3, heading, length };
    left -= lengths[i];
  }
  return { position: [...points[points.length - 1]], heading, length };
}

export function shortestTurn(from: number, to: number, fraction: number): number {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + difference * Math.max(0, Math.min(1, fraction));
}

/** Identity persists when a member moves between seat pages. */
export function appearanceSeed(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}
