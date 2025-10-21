
import { redirect } from "next/navigation";
import RickRoll from "./rick_roll";

export default function Page(){
    redirect('/');
    return <RickRoll />;
}
