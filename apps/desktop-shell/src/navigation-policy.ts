/** Allow reloads of the renderer document, including hash/query state, and nothing else. */
export function isAllowedRendererNavigation(target: string, rendererEntry: string): boolean {
  try {
    const targetUrl = new URL(target);
    const entryUrl = new URL(rendererEntry);
    return (
      targetUrl.protocol === entryUrl.protocol &&
      targetUrl.host === entryUrl.host &&
      targetUrl.pathname === entryUrl.pathname
    );
  } catch {
    return false;
  }
}
