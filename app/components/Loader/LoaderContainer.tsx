import { Suspense } from "react";
import Loader from "./Loader";

export default function LoaderContainer(props: any){
    return (
        <Suspense fallback={<Loader/>}>
            {props.children}
        </Suspense>
    );
}