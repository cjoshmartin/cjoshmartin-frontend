/** A project with a website but no body links straight to the website instead of its own page. */
export function isNoContent(website?: string, hasBody?: boolean) {
  return (website ?? "").length > 0 && !hasBody;
}
