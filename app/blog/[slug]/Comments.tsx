'use client'

import { DiscussionEmbed } from "disqus-react";

export default function Comments({slug, id, title}: any){
    // return <div />;

    return (
          <DiscussionEmbed
            shortname={"cjoshmartin"}
            config={{
              url: `https://cjoshmartin.com/blog/${slug}`,
              identifier: id,
              title: title,
            }}
          />
    )
}