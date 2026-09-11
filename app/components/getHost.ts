import { NextRequest } from "next/server"
import { headers } from "next/headers";


export default async function getHost() {
  const headersList = await headers()
  const referer = headersList.get("referer")
  
  if (!referer) {
    return `https://${process?.env?.VERCEL_URL ?? 'cjoshmartin.com'}` 
  }

  const request = new NextRequest(referer)
  // @ts-ignore
  const host = request?.nextUrl?.origin;

  return host ?? undefined;
}