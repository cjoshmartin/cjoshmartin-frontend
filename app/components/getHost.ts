import { NextRequest } from "next/server"
import { headers } from "next/headers"


export default function getHost() {
  const headersList = headers()
  const referer = headersList.get("referer")
  
  if (!referer) {
    return 'http://cjoshmartin.com'
  }

  const request = new NextRequest(referer)
  // @ts-ignore
  const host = request?.nextUrl?.origin;

  return host ?? undefined;
}