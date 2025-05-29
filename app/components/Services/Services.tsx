/* eslint-disable @next/next/no-img-element */

import { FocusModes } from "../Context/FocusMode";

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
interface ServiceObj {
  service: {
    title: string,
    description?: string,
    link?: string,
    image: ImageObj
    audience: FocusModes
  }
}

interface ServiceProps {
  service: ServiceObj
  index: number
}

function Service({service, index }: ServiceProps) {

  const {title, description, image, link} = service.service

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexDirection: index % 2 === 0 ? "row" : "row-reverse",
          padding: "1rem",
          gap: "1rem",
        }}
      >
        <img
          src={image.file}
          style={{
            width: "350px",
            // padding: "1rem",
          }}
          alt={image.title}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <h3>{title}</h3>
          <p dangerouslySetInnerHTML={{ __html: description || "" }} />
          <a href={link} style={{
            color: "var(--secondary-color)",
            textDecoration: "underline",
          }}>HEY JOSH YOU NEED TO THINK ABOUT HOW ARE YOU GOING TO SHOW THIS</a>
        </div>
      </div>
    </div>
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