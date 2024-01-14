

enum TypeOfContent {
    RICHTEXT = "full_richtext",
    CODE = "code",
    STL_FILE = "stl_picker"

}

function RichTextArea({value, className}: any){
    return (
      <div className={className} dangerouslySetInnerHTML={{ __html: value }} />
    );
}

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { gruvboxDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import generateURL from './generateURL';

function CodeArea({value}: any){

    return (
      <SyntaxHighlighter
        language={value.language}
        style={gruvboxDark}
        showLineNumbers={true}
        wrapLongLines={true}
      >
        {value.text}
      </SyntaxHighlighter>
    );
}

import URL from '@/app/components/defaulturl';
import { ReactNode } from 'react';

function STLFileArea({value} : any) {
    const {scale, url, title} = value;
    const downloadLink = generateURL(url, URL)

    return (

        <div>
            <h4>{title}</h4>
            <a href={downloadLink}>Download Link</a>
        </div>
    );
}

function AreaPicker({type, value}: any){
    switch (type) {
        case TypeOfContent.RICHTEXT:
            return <RichTextArea value={value}/>
            
        case TypeOfContent.CODE:
            return <CodeArea value={value}/>

        case TypeOfContent.STL_FILE:
            return <STLFileArea value={value} />
        default:
            return <h1><b>SOMETHING BROKEN!!!</b></h1>;
    }
}

export default function HtmlGenerator({body}: any){
    const elements: ReactNode[] = body.map(({type, value, id}: any) => <AreaPicker  key={id} type={type} value={value}/>)
    return elements;
    
}