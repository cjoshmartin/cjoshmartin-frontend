import { stegaClean, type StegaBranded } from "@sanity/client/stega";
import type { HOME_PAGE_QUERY_RESULT } from "@/sanity.types";
import { getImageDimensions, hasAsset, originalImageUrl } from "@/sanity/lib/image";
import PortableTextBody from "../PortableTextBody/PortableTextBody";
import LoadingImage from "../LoadingImage/LoadingImage";
import styles from "./service.module.css";

/** A service as HOME_PAGE_QUERY returns it (already filtered to the page's audience). */
export type ServiceData = NonNullable<
  NonNullable<StegaBranded<NonNullable<HOME_PAGE_QUERY_RESULT>>["services"]>[number]
>;

interface ServiceProps {
  service: ServiceData
  index: number
}

function ServiceLink({link, link_text, children}: {link?: string, link_text?: string, children: React.ReactNode}) {

  if(!link) {

    return <div>{children}</div>;
  }

  return (
    <a href={link} style={{
      color: "var(--secondary-color)",
      textDecoration: "none",
    }}>
      {children}
    </a>
  )
}

function Service({service, index }: ServiceProps) {

  const {title, description, image, linkText} = service
  const link = stegaClean(service.link) ?? undefined
  const imageDimensions = hasAsset(image) ? getImageDimensions(image) : undefined


  return (
    <ServiceLink link={link} link_text={linkText ?? undefined}>
      <div
        className={styles.container}
        style={{
          flexDirection: index % 2 === 0 ? "row" : "row-reverse",
        }}
      >
        {hasAsset(image) && imageDimensions && (
          <LoadingImage
            src={originalImageUrl(image)}
            width={imageDimensions.width}
            height={imageDimensions.height}
            wrapperStyle={{ width: "350px", height: (350 * imageDimensions.height) / imageDimensions.width, flexShrink: 0 }}
            style={{
              width: "350px",
              height: "auto",
            }}
            alt={stegaClean(image.alt) ?? ""}
          />
        )}
        <div className={styles.textContainer} >
          <h3>
            {title}
          </h3>
          <div>
            <PortableTextBody value={description} />
          </div>
          {link && link.length > 0 && (
            <div
              style={{
                color: "var(--secondary-color)",
                textDecoration: "underline",
              }}
            >
              <p>{linkText}</p>
            </div>
          )}
        </div>
      </div>
    </ServiceLink>
  );
}

export function Services({services}: {services: ReadonlyArray<ServiceData | null>}) {
    return (
      <div
        style={{
          color: "var(--secondary-color)",
          width: "100%",
          padding: "2rem",
        }}
      >
        <h2>Services</h2>
        <div
          style={{
            display: "flex",
            padding: "1rem",
            flexDirection: "column",
          }}
        >
          {services
            .filter((service): service is ServiceData => service !== null)
            .map((service, index) => (
              <Service
                key={service._id}
                service={service}
                index={index}
              />
            ))}
        </div>
      </div>
    );
}
