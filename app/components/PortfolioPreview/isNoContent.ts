export function isNoContent(website?: string, body?: string[]) {
  return (website ?? []).length > 0 && (body ?? []).length < 1;
}
