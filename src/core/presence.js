// Collision detection (OA 7.x, AC-OA-13): who else has this conversation open, and whether they
// are writing. Consoles send a heartbeat every few seconds while the conversation is on screen
// ("viewing") and while the composer has fresh input ("typing"); an entry expires after TTL.
// Held in memory: presence is ephemeral and never audited. Behind several app instances, swap the
// Map for a shared store (Redis) — the interface stays the same.
const TTL_MS = 15_000;
const rooms = new Map(); // conversationId → Map(userId → { userId, name, role, state, at })

function prune(room, now) {
  for (const [id, p] of room) if (now - p.at > TTL_MS) room.delete(id);
}

/** Record the caller's state and return everyone else currently on the conversation. */
export function heartbeat(conversationId, user, state = 'viewing', now = Date.now()) {
  let room = rooms.get(conversationId);
  if (!room) rooms.set(conversationId, (room = new Map()));
  if (state === 'left') room.delete(user.id);
  else room.set(user.id, { userId: user.id, name: user.name, role: user.role, state: state === 'typing' ? 'typing' : 'viewing', at: now });
  prune(room, now);
  if (!room.size) rooms.delete(conversationId);
  return others(conversationId, user.id, now);
}

export function others(conversationId, userId, now = Date.now()) {
  const room = rooms.get(conversationId);
  if (!room) return [];
  prune(room, now);
  return [...room.values()].filter((p) => p.userId !== userId).map(({ userId: id, name, role, state }) => ({ userId: id, name, role, state }));
}
