export const events = [
  { id: "evt-a", type: "created" },
  { id: "evt-b", type: "authorized" },
  { id: "evt-c", type: "captured" },
  { id: "evt-d", type: "settled" },
];

export function findEvent(id) {
  return events.find((event) => event.id === id) ?? null;
}
