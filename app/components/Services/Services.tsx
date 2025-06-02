/* eslint-disable @next/next/no-img-element */

import { FocusModes } from "../Context/FocusMode";
import styles from "./service.module.css";

interface ImageObj {
  id: number;
  title: string;
  file: string;
  width: number;
  height: number;
  created_at: string;
  focal_point_x: number | null,
  focal_point_y: number | null,
  focal_point_width: number | null,
  focal_point_height: number | null,
  file_size: number,
  file_hash: string,
  collection: number,
  uploaded_by_user: number
}
export interface ServiceObj {
  service: {
    title: string,
    description?: string,
    link?: string,
    link_text?: string,
    image: ImageObj
    audience: FocusModes
  }
}

interface ServiceProps {
  service: ServiceObj
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

  const {title, description, image, link, link_text} = service.service


  return (
    <ServiceLink link={link} link_text={link_text}>
      <div
        className={styles.container}
        style={{
          flexDirection: index % 2 === 0 ? "row" : "row-reverse",
        }}
      >
        <img
          src={image.file}
          style={{
            width: "350px",
          }}
          alt={image.title}
        />
        <div className={styles.textContainer} >
          <h3>
            {title}
          </h3>
          <p dangerouslySetInnerHTML={{ __html: description || "" }} />
          {link && link.length > 0 && (
            <a
              style={{
                color: "var(--secondary-color)",
                textDecoration: "underline",
              }}
              dangerouslySetInnerHTML={{ __html: link_text ?? "" }}
            />
          )}
        </div>
      </div>
    </ServiceLink>
  );
}

export function Services({services, project_audience}: {services: ServiceObj[], project_audience: FocusModes}) {
    return (
      <div
        style={{
          backgroundColor: "var(--primary-color)",
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
            ?.filter((service) =>
              service.service.audience.toLowerCase().includes(project_audience.toLowerCase())
            )
            .map((service, index) => (
              <Service
                key={service.service.title}
                service={service}
                index={index}
              />
            ))}
        </div>
      </div>
    );
}