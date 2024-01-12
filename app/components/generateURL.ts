import getHost from "./getHost";

export default function generateURL(path: string, incommingHost=undefined){
   let host : string | undefined= incommingHost; 
   if(!incommingHost){
    host = getHost();
   }
    if (!host){
        throw "cannot get host";
    }

    return host + path;
}