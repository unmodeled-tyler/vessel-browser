import type { PageContent } from '../../shared/types';

export function generateReaderHTML(page: PageContent): string {
  // DOMPurify runs in renderer context; here we do basic escaping
  const escapedTitle = escapeHtml(page.title);
  const escapedByline = escapeHtml(page.byline);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a1e;
      color: #d4d4d8;
      font-family: Charter, Georgia, serif;
      font-size: 19px;
      line-height: 1.7;
      padding: 3rem 1.5rem;
    }
    .reader-container {
      max-width: 680px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.8em;
      line-height: 1.3;
      margin-bottom: 0.5rem;
      color: #e4e4e8;
    }
    .byline {
      color: #71717a;
      font-size: 0.85em;
      margin-bottom: 2rem;
      font-style: italic;
    }
    .reader-content p { margin-bottom: 1.2em; }
    .reader-content h2, .reader-content h3 {
      color: #e4e4e8;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
    }
    .reader-content a { color: #6b8aad; text-decoration: none; }
    .reader-content a:hover { text-decoration: underline; }
    .reader-content img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
      margin: 1em 0;
    }
    .reader-content blockquote {
      border-left: 3px solid #3a3a40;
      padding-left: 1em;
      color: #a1a1aa;
      margin: 1em 0;
    }
    .reader-content code {
      background: #2a2a2e;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .reader-content pre {
      background: #2a2a2e;
      padding: 1em;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
    }
    .reader-content ul, .reader-content ol {
      padding-left: 1.5em;
      margin-bottom: 1em;
    }
  </style>
</head>
<body>
  <div class="reader-container">
    <h1>${escapedTitle}</h1>
    ${escapedByline ? `<div class="byline">${escapedByline}</div>` : ''}
    <div class="reader-content">${page.htmlContent || escapeHtml(page.content)}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
