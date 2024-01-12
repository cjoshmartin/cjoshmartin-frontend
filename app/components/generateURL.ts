import getHost from "./getHost";

export default function generateURL(path: string, incommingHost="" ){
   let host : string= incommingHost; 
   if(incommingHost.length < 1){
    host = getHost();
   }
    if (!host){
        throw "cannot get host";
    }

    return host + path;
}