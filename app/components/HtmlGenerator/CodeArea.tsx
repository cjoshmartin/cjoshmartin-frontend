'use client';

import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { gruvboxDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

export function CodeArea({ value }: any) {
  return (
    <SyntaxHighlighter
      language={value.language}
      style={gruvboxDark}
      showLineNumbers={true}
    >
      {value.text}
    </SyntaxHighlighter>
  );
}
