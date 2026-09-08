import assert from "node:assert/strict";
import test from "node:test";
import { alongPath, shortestTurn, appearanceSeed } from "../apps/control-web/src/office/motion.ts";

test("Office delivery covers distance uniformly through unequal aisle segments and can retrace its path", () => {
  const path: [number, number, number][] = [[0, 0, 0], [0, 0, 2], [8, 0, 2]];
  assert.deepEqual(alongPath(path, 1).position, [0, 0, 1]);
  assert.deepEqual(alongPath(path, 3).position, [1, 0, 2]);
  assert.deepEqual(alongPath(path, 9).position, [7, 0, 2]);
  assert.deepEqual(alongPath(path, 8).position, [6, 0, 2]);
  assert.deepEqual(alongPath(path, 50).position, [8, 0, 2]);
  assert.deepEqual(alongPath(path, -1).position, [0, 0, 0]);
});

test("Office path handles coincident waypoints without invalid coordinates", () => {
  assert.deepEqual(alongPath([[1, 0, 2], [1, 0, 2]], 4), { position: [1, 0, 2], heading: 0, length: 0 });
  assert.deepEqual(alongPath([], 4), { position: [0, 0, 0], heading: 0, length: 0 });
});

test("Office actors turn across the angle boundary without spinning and retain identity independent of seat", () => {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  assert.ok(Math.abs(shortestTurn(radians(179), radians(-179), .5) - Math.PI) < 1e-10);
  const members = ["researcher-a", "engineer-b", "writer-c"];
  const identities = Object.fromEntries(members.map((id) => [id, appearanceSeed(id)]));
  assert.deepEqual(Object.fromEntries([...members].reverse().map((id) => [id, appearanceSeed(id)])), identities);
});
