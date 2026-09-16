

enum TypeOfContent {
    RICHTEXT = "full_richtext",
    CODE = "code",
    STL_FILE = "stl_picker",
    VIDEO = "media",


}

import { ReactNode } from 'react';
import { STLFileArea } from '../STLFileAreaLazy';
import { CodeArea } from './CodeArea';
import { RichTextArea } from './RichTextArea/RichTextArea';


function VideoArea(value: any){
    const {url} = value.value;

    console.log(url)
    return <video src={url} autoPlay loop playsInline controls muted/>
}

function AreaPicker({type, value}: any){
    switch (type) {
        case TypeOfContent.RICHTEXT:
            return <RichTextArea value={value}/>
            
        case TypeOfContent.CODE:
            return <CodeArea value={value}/>

        case TypeOfContent.STL_FILE:
            return <STLFileArea value={value} />
        case TypeOfContent.VIDEO:
            return <VideoArea value={value}/>
        default:
            return null
            // return <h1><b>SOMETHING BROKEN!!!</b></h1>;
    }
}

export default function HtmlGenerator({body}: any){
    const elements: ReactNode[] = body?.map(({ type, value, id }: any) => (
      <AreaPicker key={id} type={type} value={value} />
    ));
    return elements;
    
}