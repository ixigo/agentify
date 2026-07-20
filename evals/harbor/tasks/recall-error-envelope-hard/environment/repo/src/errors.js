// Single error envelope for every handler in this service. Introduced after
// incident INC-114, when three handlers shipped three different error shapes
// and the mobile client crashed parsing one of them.
export function respondError(status, code, message) {
  return {
    status,
    body: { error: { code, message } },
  };
}

export function respondOk(body) {
  return { status: 200, body };
}
