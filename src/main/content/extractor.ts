import type { WebContents } from 'electron';
import type { PageContent } from '../../shared/types';

export async function extractContent(
  webContents: WebContents,
): Promise<PageContent> {
  const result = await webContents.executeJavaScript(`
    (function() {
      if (window.__vessel_extractContent) {
        return window.__vessel_extractContent();
      }
      return {
        title: document.title,
        content: document.body.innerText,
        htmlContent: '',
        byline: '',
        excerpt: '',
        url: window.location.href,
      };
    })()
  `);

  return result as PageContent;
}
