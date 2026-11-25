/**
 * "read in N minutes" label. The minutes come from `readingMinutes` (lib/portableText.ts): 200 words
 * per minute over the rich text plus code blocks, computed on the server so list pages don't send
 * whole bodies to the browser. A missing body is 0 minutes ("less than 1 minute").
 */
export function CalculateReadTime({minutes, className, fullText = true}: {minutes: number, className?: string, fullText?: boolean}){
  const readingTime = minutes;

  return <small className={className}> {fullText ? "read in" : ""} {readingTime < 1 ? "less than 1" : readingTime} minute{readingTime > 1 ? "s" : ""}</small>;
}
