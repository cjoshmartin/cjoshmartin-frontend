import Image from 'next/image';

export default function ShowImage({ url, alt, width, height, className }: any) {

    if (url) {
        return <Image src={url} alt={alt} width={width} height={height}  className={className}/>;
    }

    return (
        <Image
            src={"https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?ixlib=rb-1.2.1&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1170&q=80"}
            alt="Default image for blog post when there is not an image to show"
            width={width}
            height={height} 
            className={className}
            />
    );
}
