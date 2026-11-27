'use client';

import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { gruvboxDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

export function CodeArea({ language, code }: { language?: string; code: string }) {
  return (
    <SyntaxHighlighter
      language={language}
      style={gruvboxDark}
      showLineNumbers={true}
    >
      {code}
    </SyntaxHighlighter>
  );
}
