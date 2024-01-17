import { redirect } from "next/navigation";
import URL from "../components/defaulturl";

export default function Page(){

    redirect(`${URL}/admin`)
}