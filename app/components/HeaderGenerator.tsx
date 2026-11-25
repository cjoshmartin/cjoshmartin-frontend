import ShowImage from "../blog/_compoents/ShowImage/ShowImage";
import YouTubeEmbed from "./PortableTextBody/YouTubeEmbed";
import { stegaClean } from "@sanity/client/stega";
import { hasAsset, imageUrl, scaledDimensions } from "@/sanity/lib/image";
import type { HeroMediaValue, ImageWithAltValue } from "@/sanity/lib/types";

/** Widest rendition of a hero image. */
const HERO_IMAGE_WIDTH = 1600

/**
 * The hero of a blog post or project: the first hero media item (a YouTube video or an image),
 * otherwise the content image, otherwise the default image.
 */
export default function HeaderGenerator({heroMedia, contentImage, className}: {
    heroMedia?: HeroMediaValue | null,
    contentImage?: ImageWithAltValue | null,
    className?: string,
}){
    const currentVisual = heroMedia ? heroMedia[0] : undefined
    if ( currentVisual?._type === "youtube") {
        return (
          <div>
            <YouTubeEmbed url={currentVisual.url} />
          </div>
        );
    }

    const image = currentVisual ?? contentImage;
    if (!hasAsset(image)) {
        return (
          <ShowImage
            width={770}
            height={360}
            className={className}
          />
        )
    }

    const { width, height } = scaledDimensions(image, HERO_IMAGE_WIDTH);
    return (
      <ShowImage
        width={width}
        height={height}
        url={imageUrl(image, HERO_IMAGE_WIDTH)}
        alt={stegaClean(image.alt) ?? undefined}
        className={className}
      />
    )
}
