import styles from './page.module.css'
import DesktopIntro from './components/intro/DesktopIntro'
import { useEffect, useState } from 'react'

interface AuthorImageData {
    url: string,
    title: string,
    width: string,
    height: string,
}

interface AuthorData {
  first_name: string,
  last_name: string,
  location: string, 
  job_title: string,
  bio?: string, 
  email?: string, 
  github?: string,
  image: AuthorImageData
}
interface AuthorEntryData {
  author: AuthorData
}
interface HomePageData {
  blog_authors: AuthorEntryData[],
  body: string,
}

import { LoremIpsum } from "lorem-ipsum";
import Nav from './components/layout/Nav';
import Footer from './components/layout/Footer';
const lorem = new LoremIpsum({
  sentencesPerParagraph: {
    max: 8,
    min: 4
  },
  wordsPerSentence: {
    max: 16,
    min: 4
  }
}).generateParagraphs(7);

async function getAuthorData(){
  return fetch('https://randomuser.me/api/?format=json')
    .then(response => response.json())
    .then(data  =>{
      const {results} = data;
      const {name, location, email, picture} = results[0]

      const {first, last} = name;
      
      const {city, state} = location;

      const output:AuthorData = {
        first_name: first,
        last_name: last,
        location: `${city}, ${state}`,
        email,
        image: {
          url: picture.large,
          title: 'this is a default profile image',
          width: '500',
          height: '900',
        },
        job_title: 'Fake Person!'
      }

      return {author: output}
    })
}

export default async function Home() {
  const blogAuthors: AuthorEntryData  = await getAuthorData();

  return (
    <div style={{display:"flex"}}>
      <DesktopIntro blog_authors={blogAuthors && [blogAuthors]}/>
<div style={{margin: "0 1rem"}}>

    {/* <div id="intro-mobile">
        {% with  self.blog_authors.all|first as iter %}
            {% image iter.author.image fill-400x600 id="profile-image" %}
            <div style="text-align: center;">
                <h1>{{ iter.author }}</h1>
                <h2>{iter.author.job_title}</h2>
                <h4>{iter.author.location}</h4>
                <span>[ <a style="color: #006666;" href="mailto:{{iter.author.email}}">{iter.author.email}</a> ]</span>
                {% if iter.author.github %}
                    <br/>
                    <span style="margin-top: .5rem;">[ <a style="color: #006666;" href="{{iter.author.github}}" target="_blank">{{iter.author.github}}</a> ]</span>
                {% endif %}
            </div>
        {% endwith %}
    </div> */}

    <Nav />
    <div className={styles.bio} >
        {/* {{ page.body | richtext }} */}
        {lorem}
    </div>

    {/* {% include 'footer.html' %} */}
    <Footer />
</div>
</div>
  )
}
