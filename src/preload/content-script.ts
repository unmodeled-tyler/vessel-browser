// Content script preload — injected into web page views
// Provides readability-based content extraction

import { Readability } from '@mozilla/readability';

(window as any).__vessel_extractContent = () => {
  try {
    const documentClone = document.cloneNode(true) as Document;
    const reader = new Readability(documentClone);
    const article = reader.parse();
    return {
      title: article?.title || document.title,
      content: article?.textContent || document.body?.innerText || '',
      htmlContent: article?.content || '',
      byline: article?.byline || '',
      excerpt: article?.excerpt || '',
      url: window.location.href,
    };
  } catch {
    return {
      title: document.title,
      content: document.body?.innerText || '',
      htmlContent: '',
      byline: '',
      excerpt: '',
      url: window.location.href,
    };
  }
};
