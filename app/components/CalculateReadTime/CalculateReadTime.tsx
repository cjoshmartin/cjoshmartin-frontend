import { useMemo } from "react";

export function CalculateReadTime({body, className, fullText = true}: {body: string, className?: string, fullText?: boolean}){
  const wordsPerMinute = 200;

  const readingTime = useMemo(() => {
    const content = Object.values(body)
    .filter(({ type }: any) => type === "full_richtext" || type === "code")
    .map(({ value, type }: any) => {
      let text = "";
      if(type === "full_richtext"){
        text = value.replace(/<[^>]*>?/g, '').trim();
      }
      else if (type === "code") {
        text = (value?.text || "")
          .split(/\r\n/g)
          .map((line: string) => line.trim())
          .join(" ");
      }
      return text;
    });

  const words = content.reduce(
    (acc: number, curr: string) =>
      acc + curr.split(/\s+/).filter((word) => word.length > 0).length,
    0
  );

    return Math.ceil(words / wordsPerMinute);
  }, [body]);

  return <small className={className}> {fullText ? "read in" : ""} {readingTime < 1 ? "less than 1" : readingTime} minute{readingTime > 1 ? "s" : ""}</small>;
}
