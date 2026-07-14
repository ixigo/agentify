// feedpage — offset pagination.
// page is 1-based: page 1 is the first pageSize items.
export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}
