import ShowImage from "../blog/_compoents/ShowImage/ShowImage";

enum HeaderTypes {
    YOUTUBE = "youtube_video",
    IMAGE = "image"
}

function getImage(currentVisual?: object, content_image?: object){
    let output = content_image;

    if(currentVisual){
        //@ts-ignore
        output = currentVisual.value
    }

    return output
}

export default function HeaderGenerator({content_visuals, content_image, className}: any){
    const currentVisual = content_visuals ? content_visuals[0] : null
    if ( currentVisual?.type === HeaderTypes.YOUTUBE) {
        return (
          <div
            dangerouslySetInnerHTML={{ __html: currentVisual.value }} />
        );
    }

    const image = getImage(currentVisual, content_image);
    return (
      <ShowImage
      //@ts-ignore
        width={image?.width ?? 770}
      //@ts-ignore
        height={image?.height ?? 360}
      //@ts-ignore
        url={image?.url}
        className={className}
      />
    )
}